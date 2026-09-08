// Textual redaction engine — DOM-free so it can be unit-tested in Node.
//
// Two layers:
//   1. Regex (deterministic, fast) — structured PII with high confidence.
//   2. NER (semantic, optional) — names/locations the regex layer can't catch.
//      Injected as an async function `nerTag(text) -> [{start,end,label}]` so the
//      caller owns model loading (see visionPipeline / content.js). Absent => skipped.
//
// Every match becomes a TYPED token so the server LLM keeps structural awareness
// ("this row has a name and an email") without ever seeing values.
//
// The redaction LOG keeps raw values for the local debug panel + precision/recall
// scoring ONLY. `scrubLog()` produces the counts-only version; never forward the
// raw log to the server.

export const TOKENS = Object.freeze({
  EMAIL: "[REDACTED_EMAIL]",
  PHONE: "[REDACTED_PHONE]",
  CC: "[REDACTED_CC]",
  SSN: "[REDACTED_SSN]",
  ID: "[REDACTED_ID]",
  ADDRESS: "[REDACTED_ADDRESS]",
  NAME: "[REDACTED_NAME]",
  LOCATION: "[REDACTED_LOCATION]",
});

// --- Luhn check for candidate card numbers -----------------------------------
export function luhnValid(digits) {
  const s = String(digits).replace(/\D/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// --- Regex layer ------------------------------------------------------------
// Ordered: greedier / lower-precision patterns run last so earlier tokens
// aren't re-matched.

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const ADDRESS_RE =
  /\b\d{1,5}\s+(?:[A-Z][A-Za-z.]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Terrace|Parkway|Pkwy|Highway|Hwy)\b\.?/g;

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Aadhaar / generic 12-digit national ID in 4-4-4 grouping.
const NATIONAL_ID_RE = /\b\d{4}\s\d{4}\s\d{4}\b/g;

// Candidate card: 13-19 digits possibly separated by spaces/dashes.
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

// Candidate phone: pull the whole loose digit/separator run, then verify.
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/**
 * Redact a single string via the regex layer.
 * @returns {{ text: string, hits: Array<{type:string,value:string}> }}
 */
export function redactTextRegex(input) {
  if (!input || typeof input !== "string") return { text: input ?? "", hits: [] };
  let text = input;
  const hits = [];

  const applySimple = (re, type, token) => {
    text = text.replace(re, (m) => {
      hits.push({ type, value: m });
      return token;
    });
  };

  applySimple(EMAIL_RE, "EMAIL", TOKENS.EMAIL);
  applySimple(ADDRESS_RE, "ADDRESS", TOKENS.ADDRESS);
  applySimple(SSN_RE, "SSN", TOKENS.SSN);

  text = text.replace(CC_CANDIDATE_RE, (m) => {
    if (luhnValid(m)) {
      hits.push({ type: "CC", value: m });
      return TOKENS.CC;
    }
    return m;
  });

  applySimple(NATIONAL_ID_RE, "ID", TOKENS.ID);

  text = text.replace(PHONE_CANDIDATE_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    const hasStrongSep = /[+()\-]/.test(m);
    const hasSpace = /\s/.test(m);
    // 10-15 digits, and either a strong separator or a grouped space layout —
    // so we don't nuke bare long integers (view counts, ids).
    const looksPhone =
      digits.length >= 10 &&
      digits.length <= 15 &&
      (hasStrongSep || (hasSpace && digits.length <= 13));
    if (looksPhone) {
      hits.push({ type: "PHONE", value: m.trim() });
      return TOKENS.PHONE;
    }
    return m;
  });

  return { text, hits };
}

/**
 * Apply the NER tag spans returned by an external model to a string.
 * Tags with label PER -> NAME token, LOC -> LOCATION token. ORG/MISC ignored
 * (task-relevant, e.g. company names).
 */
export function applyNerTags(input, tags) {
  if (!input || !Array.isArray(tags) || tags.length === 0) return { text: input ?? "", hits: [] };
  const hits = [];
  // apply right-to-left so indices stay valid
  const sorted = [...tags].sort((a, b) => b.start - a.start);
  let text = input;
  for (const t of sorted) {
    const label = (t.label || "").toUpperCase();
    let token = null;
    if (label === "PER" || label === "PERSON") token = TOKENS.NAME;
    else if (label === "LOC" || label === "LOCATION" || label === "GPE") token = TOKENS.LOCATION;
    if (!token) continue;
    const value = input.slice(t.start, t.end);
    hits.push({ type: token === TOKENS.NAME ? "NAME" : "LOCATION", value });
    text = text.slice(0, t.start) + token + text.slice(t.end);
  }
  return { text, hits };
}

/**
 * Redact an array of extracted DOM nodes in place-safe fashion.
 * @param {Array<object>} nodes  extractor output; each may have `text`, `author`.
 * @param {object} opts
 * @param {(text:string)=>Promise<Array<{start,end,label}>>} [opts.nerTag]
 * @returns {Promise<{ nodes: Array<object>, log: Array<{type,value,elementId}> }>}
 */
export async function redactNodes(nodes, opts = {}) {
  const { nerTag } = opts;
  const log = [];
  const out = [];

  for (const node of nodes) {
    const copy = { ...node };
    for (const field of ["text", "author"]) {
      const original = copy[field];
      if (!original || typeof original !== "string") continue;

      const r1 = redactTextRegex(original);
      let text = r1.text;
      for (const h of r1.hits) log.push({ type: h.type, value: h.value, elementId: node.id });

      if (nerTag && text.length > 3 && /[A-Za-z]/.test(text)) {
        try {
          const tags = await nerTag(text);
          const r2 = applyNerTags(text, tags);
          text = r2.text;
          for (const h of r2.hits) log.push({ type: h.type, value: h.value, elementId: node.id });
        } catch (err) {
          // NER is best-effort; regex layer already ran.
          console.warn("[redact] nerTag failed", err);
        }
      }
      copy[field] = text;
    }
    out.push(copy);
  }

  return { nodes: out, log };
}

/** Counts-only view of the redaction log — safe to display or (server QA) compare. */
export function scrubLog(log) {
  const byType = {};
  for (const entry of log) byType[entry.type] = (byType[entry.type] || 0) + 1;
  return {
    total: log.length,
    byType,
    elements: [...new Set(log.map((e) => e.elementId))].length,
  };
}

/** True if a string still contains a high-confidence PII pattern (server + client QA). */
export function hasResidualPII(text) {
  if (!text) return false;
  EMAIL_RE.lastIndex = 0;
  SSN_RE.lastIndex = 0;
  if (EMAIL_RE.test(text) || SSN_RE.test(text)) return true;
  CC_CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = CC_CANDIDATE_RE.exec(text))) {
    if (luhnValid(m[0])) return true;
  }
  return false;
}
