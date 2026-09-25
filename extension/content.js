// Content script — injected per tab. Owns DOM perception, text + pixel PII
// detection and action execution for its tab.
//
// Privacy boundary: this script produces (a) a tokenised DOM payload and (b) the
// pixel rectangles of every PII span / sensitive field on screen. Raw pixels are
// redacted by the perception engine (offscreen doc) using those rectangles before
// anything is serialised for the network. Real values live only in the local Vault.

import { MSG } from "./lib/messages.js";
import { resolveSiteConfig, getSiteConfigById } from "./lib/siteConfigs.js";
import {
  collectWithScroll,
  waitForContent,
  getElementByAgentId,
} from "./lib/domExtractor.js";
import { redactNodes, redactText, scrubLog, Vault } from "./lib/redact.js";
import { scanForInjection } from "./lib/injectionShield.js";
import { scanViewportPii, collectImageRois, interactiveMarks } from "./lib/pixelPii.js";
import { domScreenFeatures } from "./lib/screenFeatures.js";
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
import { fastDelay, fastClick, fastType, fastScroll, fastHover, fastPressKey, fastSelect, fastCheck } from "./lib/fastActions.js";

const HUMAN = { delay: humanDelay, click: humanClick, type: humanType, scroll: (a, o) => humanScroll(a, o), hover: humanHover, pressKey: humanPressKey, select: humanSelect, check: humanCheck };
const FAST = { delay: fastDelay, click: fastClick, type: fastType, scroll: (a) => fastScroll(a), hover: fastHover, pressKey: fastPressKey, select: fastSelect, check: fastCheck };

/** NER through the shared perception engine (offscreen doc / Firefox background). */
async function nerBatch(texts) {
  const res = await chrome.runtime.sendMessage({ target: "perception", op: "ner", payload: { texts } });
  if (!res?.ok) throw new Error(res?.error || "ner failed");
  return res.result.spans;
}

async function loadCustomTerms() {
  try {
    const { agentSettings } = await chrome.storage.local.get("agentSettings");
    return agentSettings?.customTerms ?? [];
  } catch {
    return [];
  }
}

async function handleExtract({ targetCount = 10, collect = false, vault: vaultState, useNer = true }) {
  const cfg = resolveSiteConfig(location.hostname);
  const perceiveT0 = performance.now();
  const customTerms = await loadCustomTerms();

  // 1. DOM extraction (SPA-aware: retry until content hydrates)
  let extraction = collect
    ? await collectWithScroll(cfg, { targetCount })
    : await waitForContent(cfg);

  // A stale site-specific selector must not mean a permanently "empty" page —
  // retry once with the generic extractor before believing it.
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

  // 2. Pixel-level PII: spans -> exact on-screen rectangles. Values already in the
  //    vault (e.g. from the user's own task text) are boxed wherever they appear.
  const pixT0 = performance.now();
  const ner = useNer ? nerBatch : null;
  const vault = new Vault(vaultState);
  const pixel = await scanViewportPii(ner, vault.known(), customTerms);
  const rois = collectImageRois();
  const marks = interactiveMarks(extraction.nodes);
  const pixelMs = Math.round(performance.now() - pixT0);

  // 3. Text payload tokenisation (same engine + same vault => same tokens)
  const redactT0 = performance.now();
  let nerTag;
  if (ner) {
    // one batched NER call for every payload string; the engine caches per string
    const strings = new Set();
    for (const n of extraction.nodes) for (const f of ["text", "author", "label"]) if (typeof n[f] === "string" && n[f]) strings.add(n[f]);
    for (const t of extraction.meta?.toasts ?? []) strings.add(t);
    if (document.title) strings.add(document.title);
    const list = [...strings];
    let spans = [];
    try {
      spans = await nerBatch(list);
    } catch (e) {
      console.warn("[content] NER failed; rules only", e);
    }
    const byText = new Map(list.map((t, i) => [t, spans[i] || []]));
    nerTag = async (t) => byText.get(t) ?? [];
  }
  const opts = { nerTag, vault, origin: location.origin, customTerms };
  // image src URLs can embed identifiers (…/users/rahul.verma/avatar.jpg): keep host only
  const nodes = extraction.nodes.map((n) => (n.src ? { ...n, src: safeUrl(n.src) } : n));
  const { nodes: sanitizedDom, log } = await redactNodes(nodes, opts);

  // B2: flag text that reads like an instruction aimed at an agent rather than
  // page content — the invisible-text gate above (domExtractor) stops most of
  // this, but the same trick works in plain sight too (a review, a comment, a
  // product description). Flagged, not dropped: the server prompt (B2) treats
  // flagged text as untrusted DATA to reason about, never as an instruction to
  // follow — same trust boundary as the redaction tokens themselves.
  const injectionHits = scanForInjection(sanitizedDom);
  if (injectionHits.length) {
    const flagged = new Set(injectionHits.map((h) => h.elementId));
    for (const n of sanitizedDom) if (flagged.has(n.id)) n.untrusted = true;
  }

  const sanitizedToasts = [];
  for (const t of extraction.meta?.toasts ?? []) {
    const { text, hits } = await redactText(t, opts);
    for (const h of hits) log.push({ type: h.type, value: h.value, elementId: "toast" });
    sanitizedToasts.push(text);
  }
  const title = (await redactText(document.title || "", opts)).text;

  // pixel boxes get the SAME token as the text layer ("EMAIL_1") so the redacted
  // screenshot and the DOM payload tell the server one consistent story
  const boxes = pixel.boxes.map((b) => {
    const tok = b.value && !/_FIELD$|^CARD$/.test(b.type) ? vault.tokenFor(b.type, b.value, { origin: location.origin }) : `[${b.type}]`;
    return { x: b.x, y: b.y, w: b.w, h: b.h, type: b.type, label: tok.slice(1, -1), source: b.source };
  });
  const redactMs = Math.round(performance.now() - redactT0);

  return {
    type: MSG.SNAPSHOT,
    ok: true,
    sanitizedDom,
    meta: {
      ...extraction.meta,
      url: undefined,
      title,
      toasts: sanitizedToasts,
      // counts + short snippets only (already-redacted text) — never a reason to
      // hide MORE from the user than the redaction layer already does
      injectionAttempts: injectionHits,
    },
    exhausted: extraction.exhausted ?? false,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
    // structural counts (no text/values) fused with MobileCLIP for the screen state
    screenFeatures: domScreenFeatures(),
    // engine-only cache key for "same page" (never sent to the server)
    pageKey: `${location.origin}${location.pathname}`,
    // Cross-origin iframes (D1): the content script is injected into every frame
    // (manifest all_frames:true) and each frame reports its own piiBoxes/nodes in
    // ITS OWN local coordinates. The background script stitches every reachable
    // frame's results into one snapshot, offsetting by the iframe's on-page rect —
    // reported here by the PARENT frame, since only the parent's DOM has the
    // <iframe> element to measure. A frame the background can't reach at all
    // (sandboxed without allow-scripts, or a same-origin injection failure) has no
    // entry in the merged snapshot, so `fullFrame` (below) still exists as the
    // fallback: paint over its whole rectangle with a full vision pass rather than
    // leaving it fully unredacted.
    childFrames: [...document.querySelectorAll("iframe")]
      .map((f) => {
        const r = f.getBoundingClientRect();
        return { src: f.src || f.getAttribute("src") || "", rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
      })
      .filter((c) => c.rect.w > 0 && c.rect.h > 0),
    // pixels no readable frame's ROI enumeration can see into — refined by the
    // background script once it knows which frames it could actually reach.
    fullFrame: [...document.querySelectorAll("iframe")].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width * r.height > 40000 && r.bottom > 0 && r.top < window.innerHeight;
    }),
    // geometry only — no values
    piiBoxes: boxes,
    rois,
    marks,
    vault: vault.toJSON(),
    redactionLog: log.map((e) => ({ type: e.fine ?? e.type, elementId: e.elementId, source: e.source })),
    redactionSummary: scrubLog(log),
    timings: { perceiveMs, pixelMs, pixelNerMs: pixel.stats.nerMs, redactMs, textBlocks: pixel.stats.blocks },
  };
}

function safeUrl(u) {
  try {
    const x = new URL(u, location.href);
    return `${x.origin}/…`;
  } catch {
    return "";
  }
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

// ---- Live action overlay ----
// A user watching the actual tab (not the popup) otherwise sees nothing happening —
// this draws a brief highlight box over whatever element the agent is about to act
// on. Plain DOM + inline CSS (same "compute a viewport rect, paint a box" pattern as
// the pixel-PII redaction boxes in lib/pixelPii.js, just live instead of baked into
// a screenshot), no framework, nothing persisted, nothing sent anywhere.
let overlayEl = null;
let overlayHideTimer = null;
let overlayRemoveTimer = null;
const OVERLAY_VISIBLE_MS = 1200;
const OVERLAY_FADE_MS = 250;

function ensureOverlayEl() {
  if (overlayEl && overlayEl.isConnected) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.setAttribute("data-aavaran-overlay", "1");
  overlayEl.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "box-sizing:border-box",
    "border:2px solid #7c5cff",
    "border-radius:4px",
    "background:rgba(124,92,255,0.12)",
    "box-shadow:0 0 0 2px rgba(124,92,255,0.35)",
    "transition:opacity 200ms ease",
    "opacity:0",
  ].join(";");
  (document.documentElement || document.body).appendChild(overlayEl);
  return overlayEl;
}

/**
 * Briefly outline `el` in the page itself so a watching user sees "about to act
 * here". Scrolls it into view first (instantly — A.click/A.type do their own
 * scroll too, which is then a no-op) so the box lands on the real post-scroll
 * position rather than wherever the element was before the action ran.
 */
function showActionOverlay(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch {
    /* detached element, or a browser that rejects "instant" — skip the pre-scroll */
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const box = ensureOverlayEl();
  clearTimeout(overlayHideTimer);
  clearTimeout(overlayRemoveTimer);
  box.style.top = `${Math.max(0, r.top)}px`;
  box.style.left = `${Math.max(0, r.left)}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.style.opacity = "1";
  overlayHideTimer = setTimeout(() => {
    box.style.opacity = "0";
    overlayRemoveTimer = setTimeout(() => box.remove(), OVERLAY_FADE_MS);
  }, OVERLAY_VISIBLE_MS);
}

async function handleAction({ action, humanize = false }) {
  const A = humanize ? HUMAN : FAST;
  try {
    switch (action.type) {
      case "scroll":
        await A.scroll(action.amount ?? 750, { duration: action.ms });
        return { ok: true };
      case "click": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        // If the node itself isn't clickable (e.g. a list row), click the primary
        // link/button inside it.
        const clickable = el.matches('a[href], button, [role="button"], [role="link"], input')
          ? el
          : el.querySelector('a[href], button, [role="button"], [role="link"]') || el;
        showActionOverlay(clickable);
        await A.click(clickable, { postDelay: action.ms });
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
        showActionOverlay(el);
        await A.type(el, action.text ?? "");
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
        showActionOverlay(el);
        await A.select(el, match.value);
        return { ok: true };
      }
      case "check": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        if (el.tagName !== "INPUT" || !["checkbox", "radio"].includes(el.type)) {
          return { ok: false, error: "not a checkbox/radio" };
        }
        showActionOverlay(el);
        await A.check(el, !!action.checked);
        return { ok: true };
      }
      case "hover": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        showActionOverlay(el);
        await A.hover(el);
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
        showActionOverlay(target);
        await A.pressKey(target, action.key);
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
            showActionOverlay(el);
            await A.type(el, f.text ?? "");
            filled++;
            results.push({ targetId: f.targetId, ok: true });
          } catch (err) {
            results.push({ targetId: f.targetId, ok: false, error: String(err) });
          }
          await A.delay(humanize ? 300 : 30, humanize ? 650 : 60);
        }
        const failed = results.filter((r) => !r.ok);
        return failed.length ? { ok: filled > 0, filled, results } : { ok: true, filled };
      }
      case "wait":
        await A.delay(action.ms ? action.ms * 0.9 : 800, action.ms ? action.ms * 1.1 : 1200);
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
      targetCount: msg.targetCount,
      collect: msg.type === MSG.COLLECT_WITH_SCROLL || msg.collect,
      vault: msg.vault,
      useNer: msg.useNer !== false,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ type: MSG.SNAPSHOT, ok: false, error: String(err) }));
    return true;
  }
  // geometry check right after the screenshot: if the page moved between the PII
  // scan and the capture, the background re-scans instead of trusting stale boxes
  if (msg?.type === MSG.GEOMETRY) {
    sendResponse({ ok: true, scrollX: window.scrollX, scrollY: window.scrollY, w: window.innerWidth, h: window.innerHeight });
    return false;
  }
  if (msg?.type === MSG.EXECUTE_ACTION) {
    handleAction(msg).then(sendResponse);
    return true;
  }
  return false;
});

console.debug("[content] ready on", location.hostname);
