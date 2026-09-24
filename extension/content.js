// Content script — injected per tab. Owns perception + redaction + action execution
// for its tab. All redaction happens HERE, before anything is handed to the
// background worker: the worker and popup never see raw PII or raw pixels.

import { MSG } from "./lib/messages.js";
import { resolveSiteConfig, getSiteConfigById } from "./lib/siteConfigs.js";
import {
  extractSnapshot,
  collectWithScroll,
  waitForContent,
  getElementByAgentId,
} from "./lib/domExtractor.js";
import { redactNodes, redactText, scrubLog } from "./lib/redact.js";
import * as vision from "./lib/visionPipeline.js";
import { redactScreenshot, stripDataUrlPrefix } from "./lib/visualRedact.js";
import {
  humanDelay,
  humanClick,
  humanType,
  humanScroll,
  humanHover,
  humanPressKey,
  humanSelect,
  humanCheck,
} from "./lib/humanBehavior.js";

const FACE_SIZE = 128;
const SCREEN_SIZE = 224;

function domHints() {
  const q = (s) => document.querySelectorAll(s).length;
  return {
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    hasPaymentField: !!document.querySelector(
      'input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]',
    ),
    articleRoleCount: q('article, [role="article"]'),
    formFieldCount: q("input:not([type=hidden]), textarea, select"),
    paragraphCount: q("p"),
  };
}

/** Rects (page px) of fields that must be black-boxed regardless of visible text. */
function sensitiveRegionBoxes() {
  const sel =
    'input[type="password"], input[autocomplete="cc-number"], input[name*="card" i], input[name*="cvv" i], input[name*="ssn" i]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      out.push({
        x: Math.round(r.x + window.scrollX),
        y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }
  return out;
}

async function runVision(screenshotDataUrl) {
  const t0 = performance.now();
  await vision.init();
  const hints = domHints();

  let faceInput = null;
  let screenInput = null;
  let naturalSize = null;
  if (screenshotDataUrl) {
    const f = await vision.toImageData(screenshotDataUrl, FACE_SIZE, FACE_SIZE);
    const s = await vision.toImageData(screenshotDataUrl, SCREEN_SIZE, SCREEN_SIZE);
    faceInput = f.imageData;
    screenInput = s.imageData;
    naturalSize = f.natural;
  } else {
    faceInput = new ImageData(FACE_SIZE, FACE_SIZE);
    screenInput = new ImageData(SCREEN_SIZE, SCREEN_SIZE);
  }

  const result = await vision.run({ faceInput, screenInput, domHints: hints, naturalSize });
  result.totalMs = Math.round(performance.now() - t0);
  return { result, hints };
}

/** Cheap local-only downscale of the raw screenshot for live "what am I looking at"
 * UI in the popup. Never sent to the server, never persisted — display only. */
async function makeThumbnail(screenshotDataUrl, maxWidth = 160) {
  if (!screenshotDataUrl) return null;
  try {
    const resp = await fetch(screenshotDataUrl);
    const srcBlob = await resp.blob();
    const bitmap = await createImageBitmap(srcBlob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function handleExtract({ screenshot, targetCount = 10, collect = false }) {
  const cfg = resolveSiteConfig(location.hostname);
  const perceiveT0 = performance.now();

  // 1. DOM extraction (SPA-aware: retry until content hydrates)
  let extraction = collect
    ? await collectWithScroll(cfg, { targetCount })
    : await waitForContent(cfg);

  // A site-specific config's selectors can go stale (sites redesign their markup
  // often — this is an explicitly known risk, e.g. x.com's own selectors) and
  // silently match nothing forever even though the page clearly has content. A
  // site-specific itemSelector fully REPLACES the generic one rather than adding
  // to it, so a bad site config previously meant permanent, unrecoverable "empty
  // page" — retry once with the generic extractor before believing that.
  if (
    extraction.nodes.length === 0 &&
    !extraction.meta?.loginWall &&
    !extraction.meta?.captchaWall &&
    cfg.id !== "generic"
  ) {
    const genericCfg = getSiteConfigById("generic");
    const fallback = collect
      ? await collectWithScroll(genericCfg, { targetCount })
      : await waitForContent(genericCfg);
    if (fallback.nodes.length > 0) extraction = fallback;
  }
  const perceiveMs = Math.round(performance.now() - perceiveT0);

  // 2. Vision (parallel-ish; runs after scroll settles)
  const { result: visionResult } = await runVision(screenshot);

  // 3. Textual redaction
  const redactT0 = performance.now();
  const nerTag = await vision.getNerTagger();
  const { nodes: sanitizedDom, log } = await redactNodes(extraction.nodes, { nerTag });

  let sanitizedToasts = [];
  if (Array.isArray(extraction.meta?.toasts)) {
    sanitizedToasts = await Promise.all(
      extraction.meta.toasts.map(async (t) => {
        const { text, hits } = await redactText(t, { nerTag });
        for (const h of hits) log.push({ type: h.type, value: h.value, elementId: "toast" });
        return text;
      })
    );
  }
  const sanitizedMeta = {
    ...extraction.meta,
    toasts: sanitizedToasts,
  };
  const redactMs = Math.round(performance.now() - redactT0);

  // 4. Visual redaction
  let redactedScreenshot = null;
  let painted = 0;
  const sendScreenshot = vision.shouldSendScreenshot(
    visionResult.screenState,
    visionResult.screenStateConfidence,
  );
  if (screenshot) {
    const vr = await redactScreenshot(screenshot, visionResult.boxes, sensitiveRegionBoxes());
    painted = vr.painted;
    if (sendScreenshot) redactedScreenshot = stripDataUrlPrefix(vr.dataUrl);
  }

  // Local-only thumbnail for live popup display — independent of sendScreenshot,
  // never forwarded to the server.
  const thumbnail = screenshot ? await makeThumbnail(screenshot) : null;

  return {
    type: MSG.SNAPSHOT,
    ok: true,
    sanitizedDom,
    meta: sanitizedMeta,
    exhausted: extraction.exhausted ?? false,
    screenState: visionResult.screenState,
    screenStateConfidence: Number(visionResult.screenStateConfidence.toFixed(2)),
    sendScreenshot,
    redactedScreenshot,
    thumbnail,
    // values stripped — safe to forward to popup, never to server
    redactionLog: log.map((e) => ({ type: e.type, elementId: e.elementId })),
    redactionSummary: scrubLog(log),
    visionMode: visionResult.mode,
    visualBoxesPainted: painted,
    timings: {
      perceiveMs,
      redactMs,
      faceMs: visionResult.timings.faceMs,
      screenMs: visionResult.timings.screenMs,
      visionTotalMs: visionResult.totalMs,
    },
  };
}

// input[type=X] that can never accept typed text — attempting it either throws
// (file) or is meaningless (checkbox/radio/submit/etc, which have their own
// `check`/`click` actions).
const NON_TEXT_INPUT_TYPES = new Set([
  "file",
  "checkbox",
  "radio",
  "submit",
  "button",
  "image",
  "reset",
  "range",
  "color",
]);

function isTypeableElement(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  return !!el.isContentEditable;
}

async function handleAction({ action }) {
  try {
    switch (action.type) {
      case "scroll":
        await humanScroll(action.amount ?? 750, { duration: action.ms });
        return { ok: true };
      case "click": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        // If the node itself isn't clickable (e.g. a list row), click the primary
        // link/button inside it.
        const clickable = el.matches('a[href], button, [role="button"], [role="link"], input')
          ? el
          : el.querySelector('a[href], button, [role="button"], [role="link"]') || el;
        await humanClick(clickable, { postDelay: action.ms });
        return { ok: true };
      }
      case "type": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        if (!isTypeableElement(el)) {
          return {
            ok: false,
            error: `element ${action.targetId} does not accept typed text (${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ""}) — pick a different target`,
          };
        }
        await humanType(el, action.text ?? "");
        return { ok: true };
      }
      case "select": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        if (el.tagName !== "SELECT") return { ok: false, error: "not a select" };
        const value = action.value ?? "";
        const options = [...el.options];
        const byValue = options.find((o) => o.value === value);
        const match = byValue || options.find((o) => o.textContent.trim() === value.trim());
        if (!match) return { ok: false, error: `no option matching ${value}` };
        await humanSelect(el, match.value);
        return { ok: true };
      }
      case "check": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        if (el.tagName !== "INPUT" || !["checkbox", "radio"].includes(el.type)) {
          return { ok: false, error: "not a checkbox/radio" };
        }
        await humanCheck(el, !!action.checked);
        return { ok: true };
      }
      case "hover": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        await humanHover(el);
        return { ok: true };
      }
      case "press_key": {
        let target = document.activeElement;
        if (action.targetId) {
          const el = getElementByAgentId(action.targetId);
          if (!el) return { ok: false, error: `no element ${action.targetId}` };
          el.focus();
          target = el;
        }
        if (!target) return { ok: false, error: "no active element" };
        await humanPressKey(target, action.key);
        return { ok: true };
      }
      case "fill_form": {
        const fields = Array.isArray(action.fields) ? action.fields : [];
        const results = [];
        let filled = 0;
        for (const f of fields) {
          const el = getElementByAgentId(f.targetId);
          if (!el) {
            results.push({ targetId: f.targetId, ok: false, error: "not found" });
            continue;
          }
          if (!isTypeableElement(el)) {
            results.push({ targetId: f.targetId, ok: false, error: "does not accept typed text" });
            continue;
          }
          try {
            await humanType(el, f.text ?? "");
            filled++;
            results.push({ targetId: f.targetId, ok: true });
          } catch (err) {
            results.push({ targetId: f.targetId, ok: false, error: String(err) });
          }
          await humanDelay(300, 650);
        }
        const failed = results.filter((r) => !r.ok);
        return failed.length ? { ok: filled > 0, filled, results } : { ok: true, filled };
      }
      case "wait":
        await humanDelay(action.ms ? action.ms * 0.9 : 800, action.ms ? action.ms * 1.1 : 1200);
        return { ok: true };
      case "save_image": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        const img = el.tagName === "IMG" ? el : el.querySelector("img");
        if (!img) return { ok: false, error: "no image found at or inside this element" };
        // Prefer the actively-rendered source; fall back to common lazy-load attributes
        // some sites (LinkedIn included) use before the real src is swapped in.
        const raw =
          img.currentSrc ||
          img.src ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          "";
        if (!raw || raw.startsWith("data:image/gif") /* common 1x1 lazy-load placeholder */) {
          return { ok: false, error: "image has no usable source (still lazy-loading? scroll/wait and retry)" };
        }
        let imageUrl;
        try {
          imageUrl = new URL(raw, location.href).href;
        } catch {
          return { ok: false, error: "could not resolve image URL" };
        }
        return { ok: true, imageUrl, alt: (img.alt || "").slice(0, 200), caption: (action.text || "").slice(0, 300) };
      }
      case "extract":
        return { ok: true };
      default:
        return { ok: false, error: `unknown action ${action.type}` };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MSG.PING) {
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.EXTRACT_SNAPSHOT || msg?.type === MSG.COLLECT_WITH_SCROLL) {
    handleExtract({
      screenshot: msg.screenshot,
      targetCount: msg.targetCount,
      collect: msg.type === MSG.COLLECT_WITH_SCROLL || msg.collect,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ type: MSG.SNAPSHOT, ok: false, error: String(err) }));
    return true;
  }
  if (msg?.type === MSG.EXECUTE_ACTION) {
    handleAction(msg).then(sendResponse);
    return true;
  }
  return false;
});

console.debug("[content] ready on", location.hostname);
