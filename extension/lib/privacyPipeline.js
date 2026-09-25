// One agent step's privacy pipeline, run from the background worker:
//
//   content script           perception engine (offscreen / FF background)
//   ──────────────           ─────────────────────────────────────────────
//   DOM extract ─┐
//   text+pixel   │ PII boxes, ROIs, marks, tokenised DOM (values stay in Vault)
//   PII scan  ───┘
//                    screenshot ─► analyze: faces (YuNet), screen state +
//                                  region semantics (MobileCLIP), frame cache
//                               ─► redact: opaque typed boxes + Set-of-Marks
//   egress gate: every outgoing string re-checked against the Vault's raw values
//                and the checksum rules — fail-closed rewrite before fetch().
//
// Raw pixels and raw values never cross the network boundary; only the redacted
// JPEG and tokenised text do.

import { MSG } from "./messages.js";
import { perception, ensureOffscreen } from "./perceptionClient.js";
import { Vault, detectRuleSpans, applySpans, hasResidualPII, redactText, scrubLog } from "./redact.js";

async function sendToTab(tabId, msg, timeoutMs = 20000, frameId) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg, frameId != null ? { frameId } : undefined),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${msg.type} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function capture(windowId, tabId) {
  try {
    // captureVisibleTab grabs whatever tab is visible in the window. If that is not
    // the tab we scanned, the PII boxes would be painted onto someone else's pixels:
    // fail safe and send no image at all.
    const [visible] = await chrome.tabs.query({ active: true, windowId });
    if (!visible || visible.id !== tabId) return null;
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (e) {
    return null;
  }
}

// --- D1: cross-origin iframes ----------------------------------------------------
//
// manifest.json injects content.js into every frame of the tab (all_frames: true),
// so a same-origin-policy-respecting payment widget (Razorpay/Stripe checkout,
// embedded forms) gets its OWN content script — it just doesn't know where it sits
// on the page. Each frame reports its PII boxes/DOM nodes in its own local
// coordinates, and reports the on-page rect of any <iframe> children it contains
// (only a parent's DOM can measure that). The background script below walks the
// frame tree from the root, resolving each child's page-space offset from its
// parent's report before descending into it, then stitches every reachable frame's
// results into one combined snapshot. A frame we can't read at all (sandboxed
// without allow-scripts, a same-origin injection failure, or one whose offset never
// resolved) is left out and instead counted toward `fullFrame`, so the engine still
// covers its pixels with a full vision pass instead of leaving it unredacted.

async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames?.length) return frames;
  } catch {
    /* webNavigation unavailable (Firefox, or a restricted page) */
  }
  return [{ frameId: 0, parentFrameId: -1, url: null }];
}

function normalizeFrameUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u || "";
  }
}

async function extractAllFrames({ tabId, vault, useNer, targetCount }) {
  const frames = await listFrames(tabId);
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  const children = new Map();
  for (const f of frames) {
    if (f.frameId === 0) continue;
    if (!children.has(f.parentFrameId)) children.set(f.parentFrameId, []);
    children.get(f.parentFrameId).push(f.frameId);
  }

  const offsets = new Map([[0, { x: 0, y: 0 }]]);
  const results = new Map();
  const unreachable = [];
  let rootSnapshot = null;
  let rootFailure = null;

  const queue = [0];
  while (queue.length) {
    const fid = queue.shift();
    const res = await sendToTab(tabId, { type: MSG.EXTRACT_SNAPSHOT, targetCount, vault: vault.toJSON(), useNer }, fid === 0 ? 20000 : 8000, fid).catch(
      (e) => ({ ok: false, error: String(e?.message || e) }),
    );
    if (!res?.ok) {
      if (fid !== 0) unreachable.push({ frameId: fid, url: byId.get(fid)?.url ?? null, rect: offsets.get(fid) ?? null });
      else rootFailure = res;
      continue;
    }
    // Merge this frame's newly-minted tokens into the shared vault BEFORE the next
    // frame runs, so two frames never independently mint the same token number for
    // different values (they'd otherwise race, since each starts from a vault
    // snapshot that doesn't yet know about the other's additions this step).
    const merged = new Vault(res.vault);
    vault.map = merged.map;
    vault.values = merged.values;
    vault.counters = merged.counters;
    vault.origins = merged.origins;
    results.set(fid, res);
    if (fid === 0) rootSnapshot = res;

    const kids = children.get(fid) || [];
    if (kids.length) {
      const reported = res.childFrames || [];
      const used = new Set();
      for (const kidId of kids) {
        const kidUrl = normalizeFrameUrl(byId.get(kidId)?.url);
        let best = kidUrl ? reported.findIndex((c, i) => !used.has(i) && normalizeFrameUrl(c.src) === kidUrl) : -1;
        if (best === -1) best = reported.findIndex((_, i) => !used.has(i));
        if (best === -1) {
          unreachable.push({ frameId: kidId, url: byId.get(kidId)?.url ?? null, reason: "offset unresolved", rect: null });
          continue;
        }
        used.add(best);
        const parentOff = offsets.get(fid);
        const r = reported[best].rect;
        offsets.set(kidId, { x: parentOff.x + r.x, y: parentOff.y + r.y, w: r.w, h: r.h });
        queue.push(kidId);
      }
    }
  }

  if (!rootSnapshot) return rootFailure || { ok: false, error: "root frame extraction failed" };

  const sanitizedDom = [];
  const piiBoxes = [];
  const marks = [];
  const rois = [];
  const redactionLog = [];
  let redactMs = 0;
  let pixelMs = 0;
  for (const [fid, res] of results) {
    const off = offsets.get(fid) || { x: 0, y: 0 };
    const prefix = fid === 0 ? "" : `f${fid}_`;
    for (const n of res.sanitizedDom || []) {
      sanitizedDom.push({ ...n, id: prefix + n.id, frameId: fid, rect: n.rect ? { ...n.rect, x: n.rect.x + off.x, y: n.rect.y + off.y } : n.rect });
    }
    for (const b of res.piiBoxes || []) piiBoxes.push({ ...b, x: b.x + off.x, y: b.y + off.y });
    for (const m of res.marks || []) marks.push({ ...m, id: prefix + m.id, frameId: fid, x: m.x + off.x, y: m.y + off.y });
    for (const r of res.rois || []) rois.push({ ...r, id: prefix + r.id, x: r.x + off.x, y: r.y + off.y });
    redactionLog.push(...(res.redactionLog || []));
    redactMs += res.timings?.redactMs || 0;
    pixelMs += res.timings?.pixelMs || 0;
  }
  // A frame we know the position of but couldn't read into (sandboxed, injection
  // failure, timeout) gets no per-element PII boxes — but "can't read it" must
  // never mean "leave it exposed": black out its whole rectangle instead. Faces
  // inside it are still separately covered by the `fullFrame` full-vision pass.
  for (const u of unreachable) {
    if (u.rect) piiBoxes.push({ x: u.rect.x, y: u.rect.y, w: u.rect.w, h: u.rect.h, type: "FRAME", label: "FRAME", source: "unreachable-frame" });
  }

  return {
    ...rootSnapshot,
    sanitizedDom,
    piiBoxes,
    rois,
    marks,
    vault: vault.toJSON(),
    redactionLog,
    redactionSummary: scrubLog(redactionLog),
    fullFrame: rootSnapshot.fullFrame || unreachable.length > 0,
    frameCount: results.size,
    unreachableFrames: unreachable,
    timings: { ...rootSnapshot.timings, redactMs, pixelMs },
  };
}

/**
 * @returns {Promise<{snapshot, visual, timings}>}
 * snapshot = content-script output (tokenised DOM, boxes, rois, marks, vault),
 *            merged across every reachable frame of the tab (D1)
 * visual   = { screen, faces, regions, redactedImage, painted, ep, cacheHit }
 */
export async function perceiveStep({ tabId, windowId, vault, settings, targetCount }) {
  const t0 = performance.now();
  const useNer = settings.perceptionMode !== "eco";
  let snapshot = null;
  let screenshot = null;

  // the content script calls the engine directly for NER: it must exist first
  await ensureOffscreen();
  // Scan, then capture immediately; if the page scrolled in between, scan again.
  for (let attempt = 0; attempt < 2; attempt++) {
    snapshot = await extractAllFrames({ tabId, vault, useNer, targetCount });
    if (!snapshot?.ok) return { snapshot, visual: null, timings: {} };
    screenshot = await capture(windowId, tabId);
    const geo = await sendToTab(tabId, { type: MSG.GEOMETRY }, 3000, 0).catch(() => null);
    if (!geo || (geo.scrollY === snapshot.viewport.scrollY && geo.scrollX === snapshot.viewport.scrollX)) break;
  }
  const tDom = performance.now();

  // the vault is already fully merged (extractAllFrames merges every frame's new
  // tokens as it goes); this just clears the raw-value copy carried on the wire.
  delete snapshot.vault;
  const pageKey = snapshot.pageKey;
  delete snapshot.pageKey; // engine cache key only

  let visual = { screen: null, faces: [], regions: [], redactedImage: null, painted: 0 };
  if (screenshot) {
    const analysis = await perception("analyze", {
      screenshot,
      viewport: snapshot.viewport,
      rois: snapshot.rois,
      mode: settings.perceptionMode,
      pageKey,
      fullFrame: snapshot.fullFrame,
      features: snapshot.screenFeatures,
    }).catch((e) => ({ error: String(e?.message || e) }));
    const tAnalyze = performance.now();

    const scale = analysis.scale ?? snapshot.viewport.dpr ?? 1;
    const dev = (b) => ({ x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale });
    // A1: OCR runs DOM-free in the engine (offscreen doc), so it has no Vault — mint
    // tokens for its finds here, same origin-tagged provenance as every other token
    // (B1's token release policy governs these identically to DOM-sourced values).
    const pageOrigin = pageKey?.match(/^(https?:\/\/[^/]+)/)?.[1] ?? null;
    const ocrBoxes = (analysis.ocrSpans || []).map((s) => {
      const tok = vault.tokenFor(s.type, s.value, { origin: pageOrigin });
      return { x: s.x, y: s.y, w: s.w, h: s.h, label: tok.slice(1, -1), pad: 2 };
    });
    const boxes = [
      ...snapshot.piiBoxes.map((b) => ({ ...dev(b), label: b.label, pad: 2 })),
      ...(analysis.faces || []).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, label: "FACE", pad: Math.round(f.w * 0.12) })),
      ...(analysis.regions || []).filter((r) => r.sensitive).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, label: r.label.toUpperCase(), pad: 0 })),
      ...ocrBoxes,
    ];
    const marks = settings.sendScreenshot ? snapshot.marks.map((m) => ({ ...dev(m), label: m.label })) : [];
    const red = await perception("redact", { screenshot, boxes, marks }).catch((e) => ({ error: String(e?.message || e) }));
    const tRedact = performance.now();

    visual = {
      ep: analysis.ep ?? null,
      error: analysis.error || red.error || null,
      cacheHit: !!analysis.cacheHit,
      screen: analysis.screen ?? null,
      faces: analysis.faces ?? [],
      regions: (analysis.regions ?? []).map((r) => ({ id: r.id, label: r.label, confidence: r.confidence, sensitive: r.sensitive })),
      redactedImage: red.dataUrl ?? null,
      redactedBytes: red.bytes ?? 0,
      painted: red.painted ?? 0,
      boxCounts: {
        text: snapshot.piiBoxes.filter((b) => b.source !== "field").length,
        fields: snapshot.piiBoxes.filter((b) => b.source === "field").length,
        faces: (analysis.faces || []).length,
        regions: (analysis.regions || []).filter((r) => r.sensitive).length,
        ocr: ocrBoxes.length,
      },
      // debug/eval surface only — the actual redaction already used `boxes` above
      ocrBoxes: (analysis.ocrSpans || []).map((s, i) => ({ ...s, label: ocrBoxes[i]?.label })),
      engineTimings: analysis.timings ?? null,
      timings: { analyzeMs: Math.round(tAnalyze - tDom), redactMs: Math.round(tRedact - tAnalyze) },
    };
  }
  screenshot = null; // drop the raw frame as soon as possible

  return {
    snapshot,
    visual,
    timings: {
      domAndTextMs: Math.round(tDom - t0),
      ...snapshot.timings,
      ...(visual.timings || {}),
      perceptionTotalMs: Math.round(performance.now() - t0),
    },
  };
}

/** NER via the engine, usable from the background (prompt / tab titles / facts). */
export function backgroundNerTag(enabled = true) {
  if (!enabled) return undefined;
  return async (text) => (await perception("ner", { texts: [text] })).spans[0];
}

/** Tokenise free text that WE send (prompt, titles, memory facts). */
export async function tokenizeOutgoing(text, vault, nerTag) {
  if (!text) return text;
  return (await redactText(text, { vault, nerTag })).text;
}

/** URL -> origin + tokenised path; query and fragment are dropped (they carry ids/emails/tokens). */
export function sanitizeUrl(url, vault) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const spans = detectRuleSpans(path);
    return `${u.origin}${spans.length ? applySpans(path, spans, vault) : u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "";
  }
}

const SKIP_KEYS = new Set(["redactedScreenshot"]);

/**
 * Fail-closed egress gate. Walks every string in the outgoing body:
 *   1. any raw Vault value still present (e.g. a name the DOM split oddly) -> token
 *   2. any high-confidence checksum-valid PII left -> tokenised by the rules
 * Returns the cleaned body and how many strings it had to fix (should be 0; a
 * non-zero count is logged and surfaced in the dashboard as a pipeline defect).
 */
export function egressGate(body, vault) {
  const values = vault
    .rawValues()
    .filter((v) => typeof v === "string" && v.replace(/\W/g, "").length >= 4)
    .sort((a, b) => b.length - a.length);
  let fixes = 0;
  const where = [];
  const walk = (x, key, path = key) => {
    if (typeof x === "string") {
      if (SKIP_KEYS.has(key)) return x;
      let s = x;
      for (const v of values) {
        if (s.includes(v)) {
          const tok = [...vault.values.entries()].find(([, val]) => val === v)?.[0] ?? "[REDACTED]";
          s = s.split(v).join(tok);
        }
      }
      if (hasResidualPII(s)) s = applySpans(s, detectRuleSpans(s), vault);
      if (s !== x) {
        fixes++;
        if (where.length < 10) where.push(path);
      }
      return s;
    }
    if (Array.isArray(x)) return x.map((v, i) => walk(v, key, `${path}[${i}]`));
    if (x && typeof x === "object") {
      const o = {};
      for (const [k, v] of Object.entries(x)) o[k] = walk(v, k, path ? `${path}.${k}` : k);
      return o;
    }
    return x;
  };
  return { body: walk(body, ""), fixes, where };
}

/** Swap tokens in an action for real values, locally, just before execution. */
export function rehydrateAction(action, vault) {
  const a = { ...action };
  for (const k of ["text", "value", "url"]) if (typeof a[k] === "string") a[k] = vault.resolve(a[k]);
  if (Array.isArray(a.fields)) a.fields = a.fields.map((f) => ({ ...f, text: vault.resolve(f.text ?? "") }));
  return a;
}

// --- B1: token release policy --------------------------------------------------
//
// Trust boundary: the server only ever sees tokens ([PHONE_1], [AADHAAR_2] ...),
// but the CLIENT resolves them to real values right before typing. A page can try
// to manipulate the agent (via its own content, or an injected instruction) into
// putting a real value somewhere it doesn't belong — e.g. typing the user's phone
// number, captured from a profile page, into an unrelated site's comment box. A
// token may be released into a field only when the field's own visible meaning
// (label/placeholder text) matches the token's PII type, AND — for values read off
// a page rather than typed by the user — the release happens on the same origin
// the value was first seen on. Anything else pauses for an explicit user decision.

// token type -> field categories it may legitimately be typed into
const RELEASE_ALLOWED = {
  EMAIL: ["email"],
  PHONE: ["phone"],
  CC: ["card"],
  CVV: ["card"],
  PASSWORD: ["password"],
  OTP: ["otp"],
  SSN: ["id"],
  AADHAAR: ["id"],
  PAN: ["id"],
  PASSPORT: ["id"],
  VOTER_ID: ["id"],
  DRIVING_LICENSE: ["id"],
  GSTIN: ["id"],
  BANK_ACCOUNT: ["bank", "id"],
  UPI: ["bank", "id"],
  DOB: ["dob"],
  ADDRESS: ["address"],
  PINCODE: ["address"],
  NAME: ["name"],
  LOCATION: ["address", "name"],
  // technical secrets: no field ever legitimately wants these typed into it
  IP: [],
  SECRET: [],
};

const FIELD_CATEGORY_RULES = [
  [/\be-?mail\b/i, "email"],
  [/\b(phone|mobile|\btel\b|contact\s*(no|number))\b/i, "phone"],
  [/pass(word|wd|code)?\b|\bpwd\b/i, "password"],
  [/\botp\b|one[- ]?time\s*(password|code)|verification\s*code/i, "otp"],
  [/card.?(no|num|number)?\b|\bcvv\b|\bcvc\b|credit\s*card|debit\s*card/i, "card"],
  [/aadh?aa?r|\bpan\b|passport|voter\s*id|driving\s*licen[cs]e|\bgstin\b|\bssn\b/i, "id"],
  [/account.?(no|num|number)?\b|\bifsc\b|\bupi\b|\bbank\b/i, "bank"],
  [/date of birth|\bdob\b|birth\s*date/i, "dob"],
  [/address|street|\bcity\b|pin\s*code|postal\s*code|\bzip\b/i, "address"],
  [/\bname\b/i, "name"],
];

/** Guess what kind of value a form field expects from its visible label/placeholder text. */
export function guessFieldPiiCategory(labelText) {
  const t = String(labelText || "");
  for (const [re, cat] of FIELD_CATEGORY_RULES) if (re.test(t)) return cat;
  return "unknown";
}

const TOKEN_RE = /\[([A-Z_]+)_\d+\]/g;

function tokensIn(s) {
  if (typeof s !== "string" || !s.includes("[")) return [];
  return [...s.matchAll(TOKEN_RE)].map((m) => m[0]);
}

/**
 * Evaluate whether an action may release the real values behind its tokens.
 * @returns {{ ok: boolean, blocked: Array<{token,type,category,target,reason}> }}
 */
export function checkTokenRelease(action, snapshot, vault, currentOrigin) {
  const blocked = [];
  const nodeText = (targetId) => (snapshot?.sanitizedDom || []).find((n) => n.id === targetId)?.text || "";

  const evalTokens = (str, target, category) => {
    for (const token of tokensIn(str)) {
      const type = vault.typeOf(token);
      const allowed = RELEASE_ALLOWED[type];
      if (allowed === undefined) continue; // not a PII token type this policy governs
      const fieldOk = allowed.length > 0 && allowed.includes(category);
      const tokenOrigin = vault.originOf(token);
      const originOk = tokenOrigin === null || tokenOrigin === currentOrigin;
      if (!fieldOk || !originOk) {
        blocked.push({
          token,
          type,
          category,
          target,
          reason: !fieldOk
            ? category === "url"
              ? `${type} token would leave the device inside a URL — never allowed`
              : `${type} token does not belong in a "${category}" field`
            : `${type} token was captured on ${tokenOrigin}, not ${currentOrigin}`,
        });
      }
    }
  };

  if (typeof action.text === "string") {
    evalTokens(action.text, action.targetId || "(field)", guessFieldPiiCategory(nodeText(action.targetId)));
  }
  if (Array.isArray(action.fields)) {
    for (const f of action.fields) evalTokens(f.text || "", f.targetId || "(field)", guessFieldPiiCategory(nodeText(f.targetId)));
  }
  // URLs (navigate/open_tab): no legitimate reason for a token to appear here —
  // this is the classic exfiltration path (PII in a query string to a 3rd party).
  if (typeof action.url === "string") evalTokens(action.url, action.url, "url");

  return { ok: blocked.length === 0, blocked };
}
