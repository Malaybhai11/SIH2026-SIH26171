// Textual PII engine — DOM-free so it runs identically in the content script, the
// Node eval harness and unit tests.
//
// Two detection layers produce SPANS on the original string ({start,end,type,value}):
//   1. Rules — regex + checksum/structure validators (Luhn, Verhoeff for Aadhaar,
//      GSTIN mod-36, PAN entity codes). Deterministic, ~µs per string.
//   2. NER — on-device BERT-small PII model (names, places). Injected as
//      `nerTag(text) -> spans` so the caller owns model loading.
//
// Spans matter because the content script turns each one into exact pixel
// rectangles (Range.getClientRects) to black-box the SAME PII on the screenshot.
//
// Pseudonymisation: with a `Vault`, each distinct value becomes a stable numbered
// token ([NAME_1], [AADHAAR_1] ...). The server reasons over tokens ("[NAME_1] sent
// two emails"), can emit them in actions (type "[PHONE_1]" into a field) and the
// client swaps the real value back in locally at execution time. Values never leave
// the device; the vault lives in extension memory only.

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

// Fine-grained type -> legacy coarse token (used when no vault is supplied).
const COARSE = {
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  CC: "CC",
  CVV: "CC",
  SSN: "SSN",
  AADHAAR: "ID",
  PAN: "ID",
  PASSPORT: "ID",
  VOTER_ID: "ID",
  DRIVING_LICENSE: "ID",
  GSTIN: "ID",
  BANK_ACCOUNT: "ID",
  UPI: "ID",
  ID: "ID",
  OTP: "ID",
  SECRET: "ID",
  PASSWORD: "ID",
  IP: "ID",
  DOB: "ID",
  ADDRESS: "ADDRESS",
  PINCODE: "ADDRESS",
  NAME: "NAME",
  LOCATION: "LOCATION",
};

// Types that stay useful (and safe) to tokenise even inside otherwise-public text.
export const PII_TYPES = Object.keys(COARSE);

// --- validators ---------------------------------------------------------------

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

// Verhoeff (Aadhaar's check digit scheme)
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeffValid(num) {
  const s = String(num).replace(/\D/g, "");
  let c = 0;
  for (let i = 0; i < s.length; i++) c = VD[c][VP[i % 8][s.charCodeAt(s.length - 1 - i) - 48]];
  return c === 0;
}
export function aadhaarValid(num) {
  const s = String(num).replace(/\D/g, "");
  return s.length === 12 && /^[2-9]/.test(s) && verhoeffValid(s);
}

const GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function gstinValid(g) {
  const s = String(g).toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(s[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === s[14];
}

// --- rules -----------------------------------------------------------------------
// Each rule: { type, re (global), group?: capture index holding the value, valid?(v, m, text) }
// Order = priority when spans overlap (earlier wins at equal length).

const HOUSE = String.raw`(?:(?:Flat|House|Plot|Door|Shop|Qtr|H|D)\.?\s*(?:No\.?)?\s*[:#.]?\s*\d[\w/-]*|#\s?[\w/-]+|\d{1,5}[A-Za-z]?(?:/\d+)?)`;
const ADDR_WORD = String.raw`(?:Road|Rd|Marg|Nagar|Colony|Street|St|Lane|Ln|Sector|Layout|Cross|Main|Block|Phase|Society|Apartments?|Apts?|Enclave|Vihar|Puram|Chowk|Bazaar|Bazar|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Terrace|Parkway|Pkwy|Highway|Hwy|Gali|Mohalla|Extension|Ext|Tower|Residency|Heights|Park)`;

// identifiers that look like phone numbers but follow a reference label
const REF_CONTEXT = /\b(?:PNR|order|invoice|ref(?:erence)?|txn|transaction(?: id)?|UTR|tracking|AWB|ticket|booking|train|flight)\s*(?:no\.?|number|id)?\s*[:#]?\s*$/i;

const RULES = [
  { type: "SECRET", re: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { type: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  // UPI VPA: handle@psp, no dot-TLD after the @ part
  { type: "UPI", re: /\b[A-Za-z0-9][A-Za-z0-9._-]{1,63}@(?:ok)?[A-Za-z]{2,15}\b(?![.@-]\w)/g, valid: (v) => !/@(?:gmail|yahoo|outlook|hotmail)$/i.test(v) },
  { type: "PASSWORD", re: /\b(?:password|passwd|pwd|passcode|pin)\s*(?:is\s*|:\s*|=\s*|-\s*|\s)(?:being\s+)?(\S{4,64})/gi, group: 1, valid: (v) => /\d/.test(v) || /[^A-Za-z]/.test(v) || /[a-z][A-Z]/.test(v) },
  // random-looking credentials in prose (mixed case + digits, many class switches)
  { type: "SECRET", re: /\b(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{10,40}\b/g, valid: (v) => (v.match(/[a-z][A-Z]|[A-Z][a-z]|[A-Za-z]\d|\d[A-Za-z]/g) || []).length >= 6 && !/^[A-Z][a-z]+(?:[A-Z][a-z]+)+\d*$/.test(v) },
  { type: "OTP", re: /\b(?:OTP|one[- ]time (?:password|code)|verification code|security code|auth(?:entication)? code)\b[^0-9\n]{0,24}(\d{4,8})\b/gi, group: 1 },
  { type: "OTP", re: /\b(\d{4,8})\s+is\s+(?:your|the)\s+(?:OTP|one[- ]time|verification code|code)/gi, group: 1 },
  { type: "CVV", re: /\b(?:CVV|CVC|CVV2|card verification(?: value| code)?|security code)\b\s*(?:no\.?|number|code)?\s*(?:is|being|:|=|-|\()?\s*(\d{3,4})\b/gi, group: 1 },
  { type: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, valid: gstinValid },
  { type: "PAN", re: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g },
  { type: "DRIVING_LICENSE", re: /\b[A-Z]{2}[-\s]?\d{2}[-\s]?(?:19|20)\d{2}[-\s]?\d{7}\b/g },
  { type: "PASSPORT", re: /\b(?:passport)\b[^A-Z0-9\n]{0,20}([A-PR-WY][1-9]\d\s?\d{4}[1-9])\b/gi, group: 1 },
  { type: "PASSPORT", re: /\b[A-PR-WY][1-9]\d{5}[1-9]\b/g, valid: (v, m, t) => /passport|travel|visa/i.test(t) },
  { type: "VOTER_ID", re: /\b(?:voter\s*id|EPIC)\b[^A-Z0-9\n]{0,20}([A-Z]{3}\d{7})\b/gi, group: 1 },
  { type: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // cards: 13-19 digits with optional separators, Luhn-checked
  { type: "CC", re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: (v) => luhnValid(v) && !aadhaarValid(v), notAfter: /\bISBN(?:-1[03])?:?\s*$/i },
  // card-shaped number right after card vocabulary, even if not Luhn-valid (typos, test data)
  { type: "CC", re: /\b(?:card|credit|debit|visa|master ?card|maestro|amex|discover|rupay)\b[^0-9\n]{0,32}((?:\d[ -]?){12,18}\d)\b/gi, group: 1, valid: (v) => !aadhaarValid(v) },
  // Aadhaar: 12 digits (4-4-4 grouping optional), first digit 2-9, Verhoeff-checked.
  // Masked Aadhaar (XXXX XXXX 1234) still reveals a partial identifier: redact.
  { type: "AADHAAR", re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, valid: (v) => aadhaarValid(v) },
  { type: "AADHAAR", re: /\b[Xx*]{4}[\s-]?[Xx*]{4}[\s-]?\d{4}\b/g },
  { type: "BANK_ACCOUNT", re: /\b(?:a\/c|acct|account)\b[^0-9\n]{0,24}?(?:no\.?|number|#)?\s*(?:is|ending(?: in)?|:|-|=|\()?\s*((?:[Xx*]{2,}\s?)?\d[\d\s-]{2,20}\d)\b/gi, group: 1, valid: (v) => v.replace(/\D/g, "").length >= 6 },
  { type: "DOB", re: /\b(?:DOB|D\.O\.B\.?|date of birth|born(?: on)?|birth ?date)\s*[:\-]?\s*(\d{1,2}[\/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[\/\-. ]\d{2,4})\b/gi, group: 1 },
  { type: "IP", re: /(?<![\w.:])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}(?![\w:])/gi },
  { type: "IP", re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\w|\.\d)/g, valid: (v, m, t) => !/(?:v|version|ver\.?)\s*$/i.test(t.slice(Math.max(0, m.index - 10), m.index)) },
  // Indian mobile: optional +91/0 prefix, 6-9 start, 10 digits, optional 5-5 split
  { type: "PHONE", re: /(?<![\w+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, notAfter: REF_CONTEXT },
  // generic international / landline with a strong separator
  {
    type: "PHONE",
    re: /(?<![\w])\+?\d[\d\s().-]{7,}\d(?!\d)/g,
    valid: (v) => {
      const d = v.replace(/\D/g, "");
      const strong = /[+()\-]/.test(v);
      const spaced = /\s/.test(v);
      return d.length >= 10 && d.length <= 15 && (strong || (spaced && d.length <= 13)) && !/^\d{4}-\d{2}-\d{2}/.test(v.trim());
    },
    notAfter: /\b(?:ISBN(?:-1[03])?|PNR|order|invoice|ref(?:erence)?|txn|transaction(?: id)?|UTR|tracking|AWB|ticket|booking)\s*(?:no\.?|number|id)?\s*[:#]?\s*$/i,
  },
  // Indian/US street address: house marker, words up to a street keyword, then up to
  // five ", Segment" parts (locality, city, state) and an optional PIN code.
  {
    type: "ADDRESS",
    re: new RegExp(
      String.raw`\b${HOUSE},?\s+(?:[A-Z0-9][\w.'-]*,?\s+){0,5}?${ADDR_WORD}\b(?:\s+\d{1,3}[A-Z]?\b)?\.?(?:,\s*[A-Z0-9][\w'-]*(?:\s+[A-Z][\w'-]*){0,2}){0,5}(?:,?\s*(?:-\s*)?[1-9]\d{2}\s?\d{3}\b)?`,
      "g",
    ),
    // "Room 420, Block C" is a room, not an address: need >= 3 words or a PIN code
    valid: (v) => v.trim().split(/\s+/).length >= 3 || /\b[1-9]\d{2}\s?\d{3}\b/.test(v),
  },
  { type: "PINCODE", re: /\b(?:PIN|Pincode|Pin code|Postal code|ZIP)\s*[:\-]?\s*([1-9]\d{2}\s?\d{3})\b/gi, group: 1 },
];

/** Rule layer: spans on the ORIGINAL text. */
export function detectRuleSpans(text) {
  if (!text || typeof text !== "string") return [];
  const spans = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      let value = m[0];
      let start = m.index;
      if (rule.group) {
        value = m[rule.group];
        if (!value) continue;
        start = m.index + m[0].lastIndexOf(value);
      }
      // trim trailing separators / whitespace
      const trimmed = value.replace(/[\s,.;:-]+$/, "");
      if (!trimmed) continue;
      if (rule.valid && !rule.valid(trimmed, m, text)) continue;
      if (rule.notAfter && rule.notAfter.test(text.slice(Math.max(0, start - 24), start))) continue;
      spans.push({ start, end: start + trimmed.length, type: rule.type, value: trimmed, source: "rule" });
    }
  }
  return resolveOverlaps(spans);
}

/** Keep a non-overlapping set: rules beat NER; then longer beats shorter; then rule order. */
export function resolveOverlaps(spans) {
  const ranked = spans
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = a.s.source === "rule" ? 0 : 1;
      const rb = b.s.source === "rule" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const la = a.s.end - a.s.start;
      const lb = b.s.end - b.s.start;
      if (la !== lb) return lb - la;
      return a.i - b.i;
    });
  const kept = [];
  for (const { s } of ranked) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// --- vault ------------------------------------------------------------------------

function normKey(type, value) {
  const v = String(value);
  if (/^(PHONE|CC|AADHAAR|BANK_ACCOUNT|OTP|CVV|PINCODE)$/.test(type)) return `${type}:${v.replace(/\D/g, "")}`;
  return `${type}:${v.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/**
 * Local pseudonym vault. Same value -> same token for the whole task, across pages,
 * so the server can reason about identity ("[NAME_2] also appears in the To: field")
 * without learning it. Serializable for chrome.storage.session (memory-only).
 */
export class Vault {
  constructor(state) {
    this.map = new Map(state?.map ?? []); // key -> token
    this.values = new Map(state?.values ?? []); // token -> value
    this.counters = { ...(state?.counters ?? {}) };
    this.provenance = new Map(state?.provenance ?? []); // token -> provenance object
  }
  tokenFor(type, value, provenanceMeta = {}) {
    const key = normKey(type, value);
    let tok = this.map.get(key);
    if (!tok) {
      this.counters[type] = (this.counters[type] || 0) + 1;
      tok = `[${type}_${this.counters[type]}]`;
      this.map.set(key, tok);
      this.values.set(tok, value);
      this.provenance.set(tok, {
        tokenId: tok,
        type: type,
        sourceOrigin: provenanceMeta.sourceOrigin || provenanceMeta.origin || "user_prompt",
        sourceFieldType: provenanceMeta.sourceFieldType || provenanceMeta.fieldType || "prompt",
        timestamp: provenanceMeta.timestamp || Date.now(),
      });
    } else if (provenanceMeta && Object.keys(provenanceMeta).length > 0) {
      const existing = this.provenance.get(tok);
      if (existing && existing.sourceOrigin === "user_prompt" && provenanceMeta.sourceOrigin && provenanceMeta.sourceOrigin !== "user_prompt") {
        existing.sourceOrigin = provenanceMeta.sourceOrigin;
        if (provenanceMeta.sourceFieldType) existing.sourceFieldType = provenanceMeta.sourceFieldType;
      }
    }
    return tok;
  }
  getProvenance(token) {
    return this.provenance.get(token) || null;
  }
  hasValidProvenance(token) {
    const p = this.provenance.get(token);
    return !!(p && p.tokenId === token && p.type);
  }
  setProvenance(token, meta = {}) {
    if (!this.values.has(token)) return false;
    this.provenance.set(token, {
      tokenId: token,
      type: meta.type || token.slice(1, token.lastIndexOf("_")),
      sourceOrigin: meta.sourceOrigin || meta.origin || "user_prompt",
      sourceFieldType: meta.sourceFieldType || meta.fieldType || "prompt",
      timestamp: meta.timestamp || Date.now(),
    });
    return true;
  }
  /** Replace every known token in `s` with its real value (client-side, at execution). */
  resolve(s) {
    if (typeof s !== "string" || !s.includes("[")) return s;
    return s.replace(/\[([A-Z_]+_\d+)\]/g, (m) => (this.values.has(m) ? this.values.get(m) : m));
  }
  has(token) {
    return this.values.has(token);
  }
  rawValues() {
    return [...this.values.values()];
  }
  size() {
    return this.values.size;
  }
  /** [{type, value}] for vault-guided detection (local use only). */
  known() {
    return [...this.values.entries()].map(([t, value]) => ({ type: t.slice(1, t.lastIndexOf("_")), value }));
  }
  /** Token -> type, no values. Safe to send: tells the server what exists, not what it is. */
  catalog() {
    return [...this.values.keys()].map((t) => ({ token: t, type: t.slice(1, t.lastIndexOf("_")) }));
  }
  toJSON() {
    return { map: [...this.map], values: [...this.values], counters: this.counters, provenance: [...this.provenance] };
  }
}

// --- application --------------------------------------------------------------------

function tokenFor(span, vault, provenanceMeta) {
  if (vault) return vault.tokenFor(span.type, span.value, provenanceMeta);
  return TOKENS[COARSE[span.type] ?? "ID"];
}

/** Replace spans (non-overlapping, any order) with tokens. */
export function applySpans(text, spans, vault, provenanceMeta) {
  // assign tokens in reading order (so numbering reads naturally), splice right-to-left
  const toks = [...spans].sort((a, b) => a.start - b.start).map((s) => [s, tokenFor(s, vault, provenanceMeta)]);
  let out = text;
  for (let i = toks.length - 1; i >= 0; i--) {
    const [s, tok] = toks[i];
    out = out.slice(0, s.start) + tok + out.slice(s.end);
  }
  return out;
}

/** Back-compat: regex layer only, legacy typed tokens. */
export function redactTextRegex(input, vault) {
  if (!input || typeof input !== "string") return { text: input ?? "", hits: [] };
  const spans = detectRuleSpans(input);
  return {
    text: applySpans(input, spans, vault),
    hits: spans.map((s) => ({ type: vault ? s.type : COARSE[s.type], value: s.value, start: s.start, end: s.end, fine: s.type })),
  };
}

/** Back-compat: apply externally produced NER tags (PER/LOC labels) to a string. */
export function applyNerTags(input, tags, vault) {
  if (!input || !Array.isArray(tags) || tags.length === 0) return { text: input ?? "", hits: [] };
  const spans = [];
  for (const t of tags) {
    const label = (t.label || t.type || "").toUpperCase();
    let type = null;
    if (label === "PER" || label === "PERSON" || label === "NAME") type = "NAME";
    else if (label === "LOC" || label === "LOCATION" || label === "GPE") type = "LOCATION";
    if (!type) continue;
    spans.push({ start: t.start, end: t.end, type, value: input.slice(t.start, t.end), source: "ner" });
  }
  return { text: applySpans(input, spans, vault), hits: spans.map((s) => ({ type: s.type, value: s.value })) };
}

/**
 * All spans for a string: rules + (optional) NER, overlap-resolved.
 * @param {(text:string)=>Promise<Array<{start,end,type|label}>>} [nerTag]
 */
/** Occurrences of already-known sensitive values (from the Vault) in `text`. */
export function knownValueSpans(text, known = []) {
  const out = [];
  if (!text || !known.length) return out;
  const lower = text.toLowerCase();
  for (const { type, value } of known) {
    const v = String(value || "").toLowerCase();
    if (v.replace(/\W/g, "").length < 3) continue;
    let i = lower.indexOf(v);
    while (i >= 0) {
      const before = i === 0 ? " " : lower[i - 1];
      const after = i + v.length >= lower.length ? " " : lower[i + v.length];
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
        out.push({ start: i, end: i + v.length, type, value: text.slice(i, i + v.length), source: "vault" });
      }
      i = lower.indexOf(v, i + v.length);
    }
  }
  return out;
}

export async function detectSpans(text, { nerTag, known } = {}) {
  const rule = [...detectRuleSpans(text), ...knownValueSpans(text, known)].map((s) => ({ ...s, source: s.source === "vault" ? "rule" : s.source, via: s.source }));
  if (!nerTag || text.length < 3 || !/\p{L}{2,}/u.test(text)) return resolveOverlaps(rule);
  let ner = [];
  try {
    ner = (await nerTag(text)) || [];
  } catch (err) {
    console.warn("[redact] nerTag failed", err);
  }
  const nerSpans = ner
    .map((t) => {
      const label = (t.type || t.label || "").toUpperCase();
      const type = label === "PER" || label === "PERSON" || label === "NAME" ? "NAME" : label === "LOC" || label === "LOCATION" ? "LOCATION" : null;
      return type && { start: t.start, end: t.end, type, value: text.slice(t.start, t.end), source: "ner", score: t.score };
    })
    .filter(Boolean);
  return resolveOverlaps([...rule, ...nerSpans]);
}

/**
 * Redact a single string (rules + optional NER).
 * @returns {Promise<{ text, hits: Array<{type,value,start,end}> }>}
 */
export async function redactText(input, opts = {}) {
  if (!input || typeof input !== "string") return { text: input ?? "", hits: [] };
  const spans = await detectSpans(input, { ...opts, known: opts.known ?? opts.vault?.known() });
  return {
    text: applySpans(input, spans, opts.vault, opts.provenanceMeta),
    hits: spans.map((s) => ({ type: opts.vault ? s.type : COARSE[s.type], fine: s.type, value: s.value, start: s.start, end: s.end, source: s.source })),
  };
}

/**
 * Redact extracted DOM nodes.
 * @returns {Promise<{ nodes, log: Array<{type,value,elementId}> }>}
 */
export async function redactNodes(nodes, opts = {}) {
  const log = [];
  const out = [];
  for (const node of nodes) {
    const copy = { ...node };
    const nodeMeta = {
      sourceOrigin: opts.origin || (typeof location !== "undefined" ? location.origin : "webpage"),
      sourceFieldType: copy.role || "dom_node",
      ...(opts.provenanceMeta || {}),
    };
    for (const field of ["text", "author", "label", "value", "placeholder"]) {
      const original = copy[field];
      if (!original || typeof original !== "string") continue;
      const { text, hits } = await redactText(original, { ...opts, provenanceMeta: nodeMeta });
      for (const h of hits) log.push({ type: h.type, fine: h.fine, value: h.value, elementId: node.id, source: h.source });
      copy[field] = text;
    }
    out.push(copy);
  }
  return { nodes: out, log };
}

/** Counts-only view of the redaction log — safe to display or send. */
export function scrubLog(log) {
  const byType = {};
  for (const entry of log) byType[entry.fine ?? entry.type] = (byType[entry.fine ?? entry.type] || 0) + 1;
  return {
    total: log.length,
    byType,
    elements: [...new Set(log.map((e) => e.elementId))].length,
  };
}

/** True if a string still contains a high-confidence PII pattern (egress gate + server QA). */
export function hasResidualPII(text) {
  if (!text) return false;
  const HIGH = new Set(["EMAIL", "CC", "AADHAAR", "PAN", "GSTIN", "SSN", "SECRET", "UPI"]);
  return detectRuleSpans(text).some((s) => HIGH.has(s.type) && !/^[Xx*]{4}/.test(s.value));
}
