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
import { verifyTokenReleasePolicy } from "./tokenReleasePolicy.js";

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
  vault.provenance = new Map([...vault.provenance, ...merged.provenance]);
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
export async function tokenizeOutgoing(text, vault, nerTag, provenanceMeta = null) {
  if (!text) return text;
  return (
    await redactText(text, {
      vault,
      nerTag,
      provenanceMeta: provenanceMeta || { sourceOrigin: "user_prompt", sourceFieldType: "prompt" },
    })
  ).text;
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
/**
 * Swap tokens in an action for real values, locally, just before execution.
 * Enforces centralized token release policy:
 * TOKEN RELEASE = valid provenance AND allowed destination origin AND matching destination field
 *
 * If ANY security check fails:
 *   - Real values are NEVER released into action.text/fields.
 *   - The safe token representation is preserved.
 *   - a.__securityDecision records { allowed: false, decision: "BLOCK", reason, blockedToken, blockedType }.
 *
 * If ALL checks pass (or explicit user override):
 *   - Real values are safely substituted.
 *   - a.__securityDecision records { allowed: true, decision: "ALLOW" | "USER_DECISION", reason }.
 */
export function rehydrateAction(action, vault, securityContext = {}) {
  const a = { ...action };

  const extractTokens = (str) => {
    if (typeof str !== "string") return [];
    return [...str.matchAll(/\[([A-Z_]+)_\d+\]/g)].map((m) => ({
      token: m[0],
      type: m[1].replace(/_\d+$/, ""),
    }));
  };

  const actionTokens = new Set();
  const tokenList = [];

  for (const key of ["text", "value", "url"]) {
    if (typeof a[key] === "string") {
      for (const t of extractTokens(a[key])) {
        actionTokens.add(t.type);
        tokenList.push({ ...t, key, targetId: a.targetId });
      }
    }
  }

  if (Array.isArray(a.fields)) {
    for (const f of a.fields) {
      if (typeof f.text === "string") {
        for (const t of extractTokens(f.text)) {
          actionTokens.add(t.type);
          tokenList.push({ ...t, key: "fields", targetId: f.targetId });
        }
      }
    }
  }

  a.__sensitiveTypes = [...actionTokens];
  a.__b1TokenTypes = [...actionTokens];

  // If no sensitive tokens are present in this action, it is non-sensitive and allowed immediately
  if (tokenList.length === 0) {
    a.__securityDecision = {
      allowed: true,
      decision: "ALLOW",
      reason: "No sensitive tokens present in action",
    };
    return a;
  }

  // Centralized security verification for each token
  const destinationOrigin = securityContext.destinationOrigin;
  const userApproved = !!securityContext.userApproved;
  const customAllowedOrigins = securityContext.customAllowedOrigins || [];

  for (const item of tokenList) {
    const targetFieldMeta =
      item.key === "fields"
        ? (securityContext.targetFields?.[item.targetId] || securityContext.targetFieldMeta)
        : (securityContext.targetFieldMeta || securityContext.targetFields?.[item.targetId]);

    const check = verifyTokenReleasePolicy({
      token: item.token,
      tokenType: item.type,
      vault,
      destinationOrigin,
      targetFieldMeta,
      userApproved,
      customAllowedOrigins,
    });

    if (!check.allowed) {
      // Security check failed! BLOCK the release. Real value must NOT be exposed.
      a.__securityDecision = {
        allowed: false,
        decision: "BLOCK",
        reason: check.reason,
        blockedToken: item.token,
        blockedType: item.type,
        destinationOrigin,
      };
      a.__blocked = true;
      return a;
    }
  }

  // ALL checks passed (or explicit user override granted) -> Release the real values
  if (Array.isArray(a.fields)) {
    a.fields = a.fields.map((f) => {
      const fieldTokens = extractTokens(f.text).map((t) => t.type);
      return {
        ...f,
        __sensitiveTypes: fieldTokens,
        text: vault.resolve(f.text ?? ""),
      };
    });
  }

  for (const k of ["text", "value", "url"]) {
    if (typeof a[k] === "string") {
      a[k] = vault.resolve(a[k]);
    }
  }

  a.__securityDecision = {
    allowed: true,
    decision: userApproved ? "USER_DECISION" : "ALLOW",
    reason: userApproved ? "Authorized via explicit user override" : "All security checks passed",
  };

  return a;
}