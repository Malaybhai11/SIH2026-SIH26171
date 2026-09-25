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
const REF_CONTEXT =
  /(?:\b(?:PNR|order|invoice|ref(?:erence)?|txn|transaction(?: id)?|UTR|tracking|AWB|ticket|booking|train|flight)\s*(?:no\.?|number|id)?\s*[:#]?|(?:पीएनआर|ऑर्डर|चालान|संदर्भ|लेनदेन|ट्रैकिंग|टिकट|बुकिंग|ट्रेन)\s*(?:नंबर|सं\.?)?\s*[:#]?)\s*$/i;

// --- B4: Hindi / Devanagari PII --------------------------------------------------
//
// Devanagari digits (०-९, U+0966-U+096F) are drop-in 1-for-1 substitutes for ASCII
// digits — same string length, same character positions — so every existing
// digit-based rule above (Aadhaar/Verhoeff, phone, OTP, CVV, PIN, bank account,
// DOB) already works on Hindi numerals once the string they scan has been
// normalised. detectRuleSpans() below runs every rule against a normalised COPY
// of the text; span start/end stay valid on the ORIGINAL string because the
// substitution never changes length or count.
export function normalizeDevanagariDigits(s) {
  return s.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
}

// Loose "Devanagari word character": letters + vowel signs/virama, deliberately
// EXCLUDING the danda/double-danda punctuation (U+0964-U+0965, sentence-final —
// it must stop a name/address match, not extend it) and the digit block
// (U+0966-U+096F — handled separately by normalizeDevanagariDigits above; a
// "word" here should never accidentally swallow an adjacent number).
const HI_WORD = String.raw`[ऀ-ॣ॰-ॿ]+`;

// Honorific + name: Hindi has no capitalisation to lean on (unlike the English
// NAME rule, which is NER-only), so a name is recognised by the title in front of
// it — the same cue a human reader uses. Bounded to 1-4 Devanagari words so it
// doesn't run on into the rest of the sentence.
const HI_HONORIFIC = String.raw`(?:श्रीमती|श्री|सुश्री|कुमारी|डॉ\.?|डॉक्टर)`;
// Common postpositions/particles/verbs that must stop a name match ("रोहन मेहता का
// फोन" is a name followed by "of phone", not a 4-word name) — Hindi has no
// capitalisation to mark where a name ends, so this stoplist does that job.
const HI_STOP = String.raw`(?:का|की|के|ने|को|से|में|पर|है|हैं|था|थी|और|या|यह|वह|तथा|एवं|साथ)`;

// Hindi address vocabulary (locality/street words) mirroring ADDR_WORD, plus the
// house/plot markers that precede an address in Hindi government and e-commerce
// forms. Rules run against the digit-normalised text (see detectRuleSpans), so
// these use plain \d exactly like the English rules above.
const HI_HOUSE = String.raw`(?:मकान|प्लॉट|फ्लैट|दुकान)\s*(?:नंबर|नं\.?|सं\.?)?\s*[:#]?\s*\d[\wऀ-ॣ॰-ॿ/-]*`;
const HI_ADDR_WORD = String.raw`(?:मार्ग|नगर|गली|सड़क|कॉलोनी|चौक|विहार|पुरम|सेक्टर|गांव|गाँव|जिला|ज़िला|तहसील|ब्लॉक|अपार्टमेंट|सोसाइटी|रोड|एन्क्लेव|टावर)`;

const HI_CITY = String.raw`(?:मुंबई|मुम्बई|दिल्ली|नई\s*दिल्ली|बेंगलुरु|बैंगलोर|चेन्नई|कोलकाता|हैदराबाद|पुणे|अहमदाबाद|जयपुर|लखनऊ|कोच्चि|इंदौर|भोपाल|चंडीगढ़|नागपुर|सूरत|पटना|गुवाहाटी|वाराणसी|देहरादून|मैसूरु|रांची|भुवनेश्वर|तिरुवनंतपुरम)`;

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
  // "PIN"/"ZIP"/"Postal" each optionally followed by the word "code" (with or
  // without a space) before the label separator — "zip code 560001" was falling
  // through here because "code" sat between the label and the digits, which the
  // old alternation (bare "ZIP", or the fixed two-word "Pin code"/"Postal code")
  // didn't account for on the "zip" side. \s*code\.? covers "zip code"/"zipcode"
  // uniformly for every label instead of hand-listing each one/two-word variant.
  { type: "PINCODE", re: /\b(?:PIN|Pincode|Postal|ZIP)(?:\s*code)?\s*[:\-]?\s*([1-9]\d{2}\s?\d{3})\b/gi, group: 1 },

  // --- Hindi / Devanagari script rules (B4) — separate rules rather than folding
  // into the English ones above: \b is defined over ASCII \w, so it doesn't bound
  // correctly at a Devanagari word (whitespace and Devanagari letters are both \W,
  // so no transition — see HI_WORD comment). A mixed sentence that keeps "OTP",
  // "CVV" etc. as English loanwords (very common in Indian SMS/forms) already
  // matches the English rules above unchanged; these cover the Devanagari-script
  // label spelling.
  { type: "OTP", re: new RegExp(String.raw`(?:ओटीपी|वन[- ]टाइम\s*(?:पासवर्ड|कोड)|सत्यापन\s*कोड)[^0-9\n]{0,24}(\d{4,8})`, "g"), group: 1 },
  { type: "CVV", re: new RegExp(String.raw`(?:सीवीवी|सुरक्षा\s*कोड)[^0-9\n]{0,20}(\d{3,4})`, "g"), group: 1 },
  { type: "DOB", re: new RegExp(String.raw`(?:जन्म\s*तिथि|जन्मतिथि|डीओबी)\s*[:\-]?\s*(\d{1,2}[\/\-. ]\d{1,2}[\/\-. ]\d{2,4})`, "g"), group: 1 },
  { type: "PINCODE", re: new RegExp(String.raw`(?:पिन\s*कोड|डाक\s*कोड|पिनकोड)\s*[:\-]?\s*([1-9]\d{2}\s?\d{3})`, "g"), group: 1 },
  {
    type: "BANK_ACCOUNT",
    re: new RegExp(String.raw`(?:खाता\s*(?:संख्या|नंबर|क्रमांक)|अकाउंट\s*नंबर)\s*[:\-]?\s*(\d[\d\s-]{5,20}\d)`, "g"),
    group: 1,
    valid: (v) => v.replace(/\D/g, "").length >= 6,
  },
  {
    type: "NAME",
    // Bounded to 1-2 words (the overwhelming majority of Hindi personal names in
    // these contexts): a 3rd word is almost always the next clause ("...ने आवेदन
    // किया"), a city ("...चंडीगढ़ से आए"), or another particle, not more of the name.
    re: new RegExp(String.raw`${HI_HONORIFIC}\s+(${HI_WORD}(?:\s+(?!${HI_STOP}(?:\s|$|[।॥,.])|${HI_CITY})${HI_WORD}){0,1})`, "g"),
    group: 1,
  },
  {
    type: "ADDRESS",
    re: new RegExp(String.raw`${HI_HOUSE}[,\s]+(?:${HI_WORD}[,\s]+){0,6}?${HI_ADDR_WORD}(?:[,\s]+${HI_WORD}){0,3}(?:[,\s]+[1-9]\d{2}\s?\d{3})?`, "g"),
    valid: (v) => v.trim().split(/\s+/).length >= 3 || /[1-9]\d{2}\s?\d{3}/.test(v),
  },
  { type: "LOCATION", re: new RegExp(HI_CITY, "g") },
];

/** Rule layer: spans on the ORIGINAL text (Devanagari digits normalised to ASCII first — see normalizeDevanagariDigits; the substitution is 1-for-1, so span offsets stay valid on the original string). */
export function detectRuleSpans(text) {
  if (!text || typeof text !== "string") return [];
  const normalized = normalizeDevanagariDigits(text);
  const spans = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(normalized))) {
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
      if (rule.valid && !rule.valid(trimmed, m, normalized)) continue;
      if (rule.notAfter && rule.notAfter.test(normalized.slice(Math.max(0, start - 24), start))) continue;
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

// --- surrogate generation -----------------------------------------------------
//
// Semantic obfuscation mode ("surrogates"): instead of an opaque [NAME_1] token, the
// Vault can mint a plausible-but-fake replacement of the same shape ("Asha Verma"),
// so an LLM's natural-language reasoning ("does this look like a real name?") sees
// fluent text instead of a placeholder. The REAL value still never leaves the device:
// it only ever exists as a key in the Vault, resolved back locally at execution time
// exactly like a bracket token is today. All data below is synthetic (no real people).

function hashSeed(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG (mulberry32) so a given seed always produces the same stream —
// this is what makes generateSurrogate a pure, repeatable function of its inputs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
const digitsOf = (rand, n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 10);
  return s;
};

// Indian-context synthetic name/place data, matching the project's demo-data flavor
// (server/demo/*.html). None of these refer to real people.
const SURR_FIRST = ["Asha", "Ananya", "Arjun", "Divya", "Farhan", "Gauri", "Harsh", "Isha", "Kabir", "Kavya", "Lakshmi", "Manav", "Meera", "Neha", "Nikhil", "Pooja", "Rahul", "Rohan", "Sana", "Tara", "Uday", "Varun", "Yash", "Zara"];
const SURR_LAST = ["Bhatt", "Chauhan", "Desai", "Gupta", "Iyer", "Joshi", "Kapoor", "Kulkarni", "Malhotra", "Menon", "Nair", "Patel", "Pillai", "Rao", "Reddy", "Saxena", "Shetty", "Sinha", "Thakur", "Verma"];
const SURR_CITY = ["Pune", "Jaipur", "Lucknow", "Nagpur", "Indore", "Bhopal", "Kochi", "Chandigarh", "Coimbatore", "Surat", "Nashik", "Guwahati", "Vadodara", "Ranchi", "Mysuru", "Dehradun", "Amritsar", "Bhubaneswar"];
const SURR_STATE = ["Maharashtra", "Rajasthan", "Uttar Pradesh", "Karnataka", "Gujarat", "Punjab", "Telangana", "Odisha", "Kerala", "Haryana"];
const SURR_STREET_WORD = ["Nagar", "Colony", "Marg", "Layout", "Cross", "Vihar", "Enclave", "Phase", "Extension", "Sector"];
const SURR_EMAIL_DOMAIN = ["mailbox.example", "inboxmail.in", "netpost.example", "dakmail.example"];

function surrogateName(rand) {
  return `${pick(rand, SURR_FIRST)} ${pick(rand, SURR_LAST)}`;
}
function surrogateEmail(rand) {
  const local = `${pick(rand, SURR_FIRST)}.${pick(rand, SURR_LAST)}${Math.floor(rand() * 90) + 10}`.toLowerCase();
  return `${local}@${pick(rand, SURR_EMAIL_DOMAIN)}`;
}
function surrogatePhone(rand) {
  // Indian mobile shape: leading 6-9, 10 digits total, grouped like the RULES regex expects.
  const first = "6789"[Math.floor(rand() * 4)];
  const rest = digitsOf(rand, 9);
  return `+91 ${first}${rest.slice(0, 4)} ${rest.slice(4)}`;
}
function surrogateLocation(rand) {
  return `${pick(rand, SURR_CITY)}, ${pick(rand, SURR_STATE)}`;
}
function surrogateAddress(rand) {
  const house = Math.floor(rand() * 900) + 10;
  const sector = Math.floor(rand() * 40) + 1;
  const pincode = `${1 + Math.floor(rand() * 8)}${digitsOf(rand, 5)}`;
  return `House No. ${house}, ${pick(rand, SURR_STREET_WORD)} ${sector}, ${pick(rand, SURR_CITY)} ${pincode}`;
}

const SURROGATE_GENERATORS = {
  NAME: surrogateName,
  EMAIL: surrogateEmail,
  PHONE: surrogatePhone,
  ADDRESS: surrogateAddress,
  LOCATION: surrogateLocation,
};

/** Types generateSurrogate knows how to fake; everything else falls back to a bracket token. */
export const SURROGATE_TYPES = new Set(Object.keys(SURROGATE_GENERATORS));

/**
 * Pure, deterministic surrogate generator: the same (type, realValue) always produces
 * the same plausible-but-fake replacement — same real value -> same surrogate, so a
 * name repeated on a page reads as the same fake name everywhere. Pass an explicit
 * `seed` (e.g. a disambiguation counter) to get a different candidate for the same
 * value; omit it to hash the value itself. Returns null for a type with no generator,
 * so the caller can fall back to an opaque [TYPE_n] token.
 */
export function generateSurrogate(type, realValue, seed) {
  const gen = SURROGATE_GENERATORS[type];
  if (!gen) return null;
  const s = seed === undefined ? hashSeed(`${type}:${String(realValue).trim().toLowerCase()}`) : seed >>> 0;
  return gen(mulberry32(s));
}

/**
 * Local pseudonym vault. Same value -> same token for the whole task, across pages,
 * so the server can reason about identity ("[NAME_2] also appears in the To: field")
 * without learning it. Serializable for chrome.storage.session (memory-only).
 *
 * Redaction mode ("token" | "surrogate"): "token" (default) mints opaque [TYPE_n]
 * placeholders, as before. "surrogate" mints a plausible fake value instead, for the
 * types generateSurrogate supports, and falls back to a bracket token for the rest.
 * Either way the mapping is the same shape (placeholder <-> real value) and resolve()
 * rehydrates both forms identically — the security property (raw values stay local,
 * only the placeholder/surrogate ever leaves the device) holds in both modes.
 */
export class Vault {
  constructor(state, opts = {}) {
    this.map = new Map(state?.map ?? []); // key -> token/surrogate
    this.values = new Map(state?.values ?? []); // token/surrogate -> real value
    this.labels = new Map(state?.labels ?? []); // token/surrogate -> "TYPE_n" (for pixel-box marks, regardless of mode)
    this.counters = { ...(state?.counters ?? {}) };
    // Provenance for the token release policy (B1): the page origin a value was
    // first seen on, or null for values the user typed into the task prompt.
    // First-seen wins — never overwritten once set.
    this.origins = new Map(state?.origins ?? []); // token -> origin | null
    this.mode = opts.mode ?? state?.mode ?? "token";
  }
  /** A surrogate that doesn't collide with the real value or an already-minted one. */
  _mintSurrogate(type, value, fine) {
    const base = `${type}:${normKey(type, value)}`;
    const realLower = String(value).trim().toLowerCase();
    for (let bump = 0; bump < 25; bump++) {
      const candidate = generateSurrogate(type, value, hashSeed(`${base}:${bump}`));
      if (!candidate) return null;
      const taken = this.values.has(candidate) && this.values.get(candidate) !== value;
      if (candidate.trim().toLowerCase() !== realLower && !taken) return candidate;
    }
    return `[${fine}]`; // pathological collision streak — fall back to a plain token
  }
  tokenFor(type, value, meta = {}) {
    const key = normKey(type, value);
    let tok = this.map.get(key);
    if (!tok) {
      this.counters[type] = (this.counters[type] || 0) + 1;
      const fine = `${type}_${this.counters[type]}`;
      tok = (this.mode === "surrogate" && this._mintSurrogate(type, value, fine)) || `[${fine}]`;
      this.map.set(key, tok);
      this.values.set(tok, value);
      this.labels.set(tok, fine);
    }
    if (!this.origins.has(tok) && meta.origin !== undefined) this.origins.set(tok, meta.origin);
    return tok;
  }
  /** "AADHAAR" style fine type from a "[AADHAAR_1]" token, or null. */
  typeOf(token) {
    const m = /^\[([A-Z_]+)_\d+\]$/.exec(token || "");
    return m ? m[1] : null;
  }
  /** Page origin the token's value was first seen on, or null (user-supplied / unknown). */
  originOf(token) {
    return this.origins.get(token) ?? null;
  }
  /** "TYPE_n" for a minted token/surrogate — used to label pixel-redaction boxes. */
  labelFor(tok) {
    return this.labels.get(tok) ?? (tok.startsWith("[") && tok.endsWith("]") ? tok.slice(1, -1) : tok);
  }
  /** Replace every known token/surrogate in `s` with its real value (client-side, at execution). */
  resolve(s) {
    if (typeof s !== "string" || !s || this.values.size === 0) return s;
    let out = s;
    for (const [tok, value] of this.values) {
      if (out.includes(tok)) out = out.split(tok).join(value);
    }
    return out;
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
    return [...this.values.entries()].map(([t, value]) => ({ type: this.labelFor(t).slice(0, this.labelFor(t).lastIndexOf("_")), value }));
  }
  /** Token/surrogate -> type, no real values. Safe to send: tells the server what exists, not what it is. */
  catalog() {
    return [...this.values.keys()].map((t) => ({ token: t, type: this.labelFor(t).slice(0, this.labelFor(t).lastIndexOf("_")) }));
  }
  toJSON() {
    return {
      map: [...this.map],
      values: [...this.values],
      labels: [...this.labels],
      counters: this.counters,
      origins: [...this.origins],
      mode: this.mode,
    };
  }
}

// --- application --------------------------------------------------------------------

function tokenFor(span, vault, origin) {
  if (vault) return vault.tokenFor(span.type, span.value, { origin });
  return TOKENS[COARSE[span.type] ?? "ID"];
}

/** Replace spans (non-overlapping, any order) with tokens. */
export function applySpans(text, spans, vault, origin) {
  // assign tokens in reading order (so numbering reads naturally), splice right-to-left
  const toks = [...spans].sort((a, b) => a.start - b.start).map((s) => [s, tokenFor(s, vault, origin)]);
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

// --- B3: user-defined sensitive terms ---------------------------------------------
//
// An organisation's own secrets (a project codename, an employee id format) can't be
// in any generic PII model — the user defines them in the popup, literal words/
// phrases or a regex pattern, and they're redacted exactly like built-in PII: same
// vault, same tokens, same pixel boxes (the label becomes the token type, e.g. a
// term labelled "Codename" mints [CODENAME_1]).
export function customTermSpans(text, customTerms = []) {
  const out = [];
  if (!text || !customTerms?.length) return out;
  for (const t of customTerms) {
    if (!t || (!t.term && t.term !== 0)) continue;
    const type = String(t.label || "CUSTOM").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "CUSTOM";
    if (t.isRegex) {
      let re;
      try {
        re = new RegExp(t.term, "gi");
      } catch {
        continue; // an invalid user-supplied pattern is skipped, not a pipeline crash
      }
      let m;
      let guard = 0;
      while ((m = re.exec(text)) && guard++ < 1000) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push({ start: m.index, end: m.index + m[0].length, type, value: m[0], source: "custom" });
      }
    } else {
      const needle = String(t.term).toLowerCase();
      if (!needle) continue;
      const lower = text.toLowerCase();
      let i = lower.indexOf(needle);
      while (i >= 0) {
        out.push({ start: i, end: i + needle.length, type, value: text.slice(i, i + needle.length), source: "custom" });
        i = lower.indexOf(needle, i + needle.length);
      }
    }
  }
  return out;
}

export async function detectSpans(text, { nerTag, known, customTerms } = {}) {
  const rule = [...detectRuleSpans(text), ...knownValueSpans(text, known), ...customTermSpans(text, customTerms)].map((s) => ({
    ...s,
    source: s.source === "vault" || s.source === "custom" ? "rule" : s.source,
    via: s.source,
  }));
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
    text: applySpans(input, spans, opts.vault, opts.origin),
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
    for (const field of ["text", "author", "label", "value", "placeholder"]) {
      const original = copy[field];
      if (!original || typeof original !== "string") continue;
      const { text, hits } = await redactText(original, opts);
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
