// Content script — injected per tab. Owns perception + redaction + action execution
// for its tab. All redaction happens HERE, before anything is handed to the
// background worker: the worker and popup never see raw PII or raw pixels.

import { MSG } from "./lib/messages.js";
import { resolveSiteConfig } from "./lib/siteConfigs.js";
import { extractSnapshot, collectWithScroll, getElementByAgentId } from "./lib/domExtractor.js";
import { redactNodes, scrubLog } from "./lib/redact.js";
import * as vision from "./lib/visionPipeline.js";
import { redactScreenshot, stripDataUrlPrefix } from "./lib/visualRedact.js";

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

async function handleExtract({ screenshot, targetCount = 10, collect = false }) {
  const cfg = resolveSiteConfig(location.hostname);
  const perceiveT0 = performance.now();

  // 1. DOM extraction
  const extraction = collect
    ? await collectWithScroll(cfg, { targetCount })
    : extractSnapshot(cfg);
  const perceiveMs = Math.round(performance.now() - perceiveT0);

  // 2. Vision (parallel-ish; runs after scroll settles)
  const { result: visionResult } = await runVision(screenshot);

  // 3. Textual redaction
  const redactT0 = performance.now();
  const nerTag = await vision.getNerTagger();
  const { nodes: sanitizedDom, log } = await redactNodes(extraction.nodes, { nerTag });
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

  return {
    type: MSG.SNAPSHOT,
    ok: true,
    sanitizedDom,
    meta: extraction.meta,
    exhausted: extraction.exhausted ?? false,
    screenState: visionResult.screenState,
    screenStateConfidence: Number(visionResult.screenStateConfidence.toFixed(2)),
    sendScreenshot,
    redactedScreenshot,
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

function settle(ms = 700) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleAction({ action }) {
  try {
    switch (action.type) {
      case "scroll":
        window.scrollBy(0, action.amount ?? 900);
        await settle(action.ms ?? 700);
        return { ok: true };
      case "click": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        await settle(action.ms ?? 800);
        return { ok: true };
      }
      case "type": {
        const el = getElementByAgentId(action.targetId);
        if (!el) return { ok: false, error: `no element ${action.targetId}` };
        el.focus();
        el.value = action.text ?? "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      case "wait":
        await settle(action.ms ?? 1000);
        return { ok: true };
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
