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
import { Vault, detectRuleSpans, applySpans, hasResidualPII, redactText } from "./redact.js";

async function sendToTab(tabId, msg, timeoutMs = 20000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
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

/**
 * @returns {Promise<{snapshot, visual, timings}>}
 * snapshot = content-script output (tokenised DOM, boxes, rois, marks, vault)
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
    snapshot = await sendToTab(tabId, { type: MSG.EXTRACT_SNAPSHOT, targetCount, vault: vault.toJSON(), useNer });
    if (!snapshot?.ok) return { snapshot, visual: null, timings: {} };
    screenshot = await capture(windowId, tabId);
    const geo = await sendToTab(tabId, { type: MSG.GEOMETRY }, 3000).catch(() => null);
    if (!geo || (geo.scrollY === snapshot.viewport.scrollY && geo.scrollX === snapshot.viewport.scrollX)) break;
  }
  const tDom = performance.now();

  // adopt tokens minted by the content script (same Vault, now with this page's values)
  const merged = new Vault(snapshot.vault);
  vault.map = merged.map;
  vault.values = merged.values;
  vault.counters = merged.counters;
  delete snapshot.vault; // never keep a second copy of raw values around
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
    const boxes = [
      ...snapshot.piiBoxes.map((b) => ({ ...dev(b), label: b.label, pad: 2 })),
      ...(analysis.faces || []).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, label: "FACE", pad: Math.round(f.w * 0.12) })),
      ...(analysis.regions || []).filter((r) => r.sensitive).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, label: r.label.toUpperCase(), pad: 0 })),
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
      },
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
