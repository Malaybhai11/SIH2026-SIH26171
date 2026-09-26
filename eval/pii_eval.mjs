// PII detection recall / precision (criterion 2) on two corpora, using the SHIPPED
// engine: extension/lib/redact.js (rules) + extension/lib/perception/ner.js (BERT-small
// PII NER via onnxruntime-node — same decode path as the browser).
//
//   node eval/pii_eval.mjs [--n 500]
//
// Corpora
//   A. ai4privacy/pii-masking-200k (English, public, span-labelled) — first N rows.
//      Our types are mapped from theirs (MAP below); labels we don't target (job
//      titles, amounts, ...) count as neither TP nor FN, and predictions landing on
//      them are not counted as FP (they ARE personal-ish, just not in our scheme).
//   B. Indian synthetic set — 40 sentence templates x random Indian names/cities and
//      checksum-valid identifiers (Aadhaar/Verhoeff, GSTIN, PAN, UPI...), plus hard
//      negatives (order ids, PNRs, prices, dates, versions, ISBNs, IFSC).
//
// Metrics: span recall (a gold span is found if >= 50% of its characters are
// covered by predictions), span precision (a predicted span is correct if >= 50% of
// its characters fall inside gold PII), plus character-level coverage. Per type.

import ort from "onnxruntime-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { detectSpans, verhoeffValid, gstinValid } from "../extension/lib/redact.js";
import { PiiNer } from "../extension/lib/perception/ner.js";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg("--n", 500);

// --- NER -----------------------------------------------------------------------
const M = "extension/models/onnx-community/bert-small-pii-detection-ONNX/";
const nerSession = await ort.InferenceSession.create(M + "onnx/model_quantized.onnx", { intraOpNumThreads: 2 });
const ner = new PiiNer(ort, nerSession, JSON.parse(await readFile(M + "tokenizer.json", "utf8")), JSON.parse(await readFile(M + "config.json", "utf8")));

// --- corpus A: ai4privacy ------------------------------------------------------------
const MAP = {
  EMAIL: "EMAIL", PHONENUMBER: "PHONE", FIRSTNAME: "NAME", LASTNAME: "NAME", MIDDLENAME: "NAME", FULLNAME: "NAME",
  CITY: "LOCATION", STATE: "LOCATION", COUNTY: "LOCATION", STREET: "ADDRESS", BUILDINGNUMBER: "ADDRESS",
  SECONDARYADDRESS: "ADDRESS", ZIPCODE: "ADDRESS", CREDITCARDNUMBER: "CC", CREDITCARDCVV: "CVV", SSN: "SSN",
  IP: "IP", IPV4: "IP", PASSWORD: "PASSWORD", DOB: "DOB", ACCOUNTNUMBER: "BANK_ACCOUNT", PIN: "PASSWORD",
};
async function loadAi4privacy() {
  const f = "eval/.cache/ai4p_en_head.jsonl";
  if (!existsSync(f)) {
    const res = await fetch("https://huggingface.co/datasets/ai4privacy/pii-masking-200k/resolve/main/english_pii_43k.jsonl", { headers: { Range: "bytes=0-3000000" } });
    await writeFile(f, Buffer.from(await res.arrayBuffer()));
  }
  const lines = (await readFile(f, "utf8")).split("\n").filter(Boolean);
  const out = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      out.push({
        text: r.source_text,
        gold: r.privacy_mask.map((m) => ({ start: m.start, end: m.end, type: MAP[m.label] ?? null, raw: m.label })),
      });
    } catch {
      /* truncated last line */
    }
    if (out.length >= N) break;
  }
  return out;
}

// --- corpus B: Indian synthetic ---------------------------------------------------------
let seed = 26171;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
const FIRST = ["Aarav", "Vivaan", "Aditya", "Ishaan", "Rohan", "Arjun", "Kabir", "Ananya", "Diya", "Saanvi", "Priya", "Kavya", "Meera", "Sneha", "Lakshmi", "Harpreet", "Gurpreet", "Mohammed", "Imran", "Farhan", "Ayesha", "Zoya", "Suresh", "Ramesh", "Venkatesh", "Karthik", "Deepika", "Pooja", "Nikhil", "Siddharth", "Tanvi", "Anjali", "Rahul", "Vikram", "Sunita", "Joseph", "Mary", "Thomas", "Abhishek", "Neha"];
const LAST = ["Sharma", "Verma", "Iyer", "Nair", "Reddy", "Rao", "Patel", "Shah", "Mehta", "Singh", "Kaur", "Gill", "Khan", "Qureshi", "Ansari", "Mukherjee", "Banerjee", "Chatterjee", "Das", "Bose", "Pillai", "Menon", "Kulkarni", "Deshpande", "Joshi", "Gupta", "Agarwal", "Yadav", "Chauhan", "Fernandes", "D'Souza", "Naidu", "Hegde", "Shetty", "Tiwari"];
const CITY = ["Mumbai", "Delhi", "Bengaluru", "Chennai", "Kolkata", "Hyderabad", "Pune", "Ahmedabad", "Jaipur", "Lucknow", "Kochi", "Indore", "Bhopal", "Chandigarh", "Nagpur", "Surat", "Patna", "Bhubaneswar", "Guwahati", "Thiruvananthapuram", "Mysuru", "Varanasi", "Dehradun", "Ranchi"];
const STREET = ["MG Road", "Nehru Nagar", "Gandhi Marg", "Sector 21", "Park Street", "Anna Salai", "Linking Road", "Residency Road", "Civil Lines Road", "Shivaji Nagar"];
const PSP = ["okaxis", "oksbi", "okhdfcbank", "okicici", "ybl", "paytm", "ibl", "axl"];
const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function aadhaar() {
  for (;;) {
    const p = String(2 + Math.floor(rnd() * 8)) + digits(10);
    for (let d = 0; d < 10; d++) if (verhoeffValid(p + d)) return `${(p + d).slice(0, 4)} ${(p + d).slice(4, 8)} ${(p + d).slice(8)}`;
  }
}
const pan = () => Array.from({ length: 3 }, () => pick(L)).join("") + pick("PCHFT") + pick(L) + digits(4) + pick(L);
function gstin() {
  for (;;) {
    const base = `${10 + Math.floor(rnd() * 25)}${pan()}${1 + Math.floor(rnd() * 9)}Z`;
    for (const c of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (gstinValid(base + c)) return base + c;
  }
}
const phone = () => pick(["+91 ", "", "0", "+91-"]) + pick("6789") + digits(4) + pick([" ", "", "-"]) + digits(5);
const email = (f, l) => `${f.toLowerCase()}.${l.toLowerCase().replace(/\W/g, "")}${pick(["", digits(2)])}@${pick(["gmail.com", "yahoo.co.in", "outlook.com", "rediffmail.com", "iitb.ac.in", "company.in"])}`;
const pin = () => String(1 + Math.floor(rnd() * 8)) + digits(5);
function card() {
  for (;;) {
    const p = pick(["4", "5", "6"]) + digits(14);
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      let d = +p[14 - i];
      if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    const c = (10 - (sum % 10)) % 10;
    const n = p + c;
    return `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8, 12)} ${n.slice(12)}`;
  }
}

// template: array of parts; strings are literal, [type, value] are gold spans
function T(...parts) {
  let text = "";
  const gold = [];
  for (const p of parts) {
    if (typeof p === "string") text += p;
    else {
      gold.push({ start: text.length, end: text.length + p[1].length, type: p[0] });
      text += p[1];
    }
  }
  return { text, gold };
}
const TEMPLATES = [
  () => { const f = pick(FIRST), l = pick(LAST); return T("Dear ", ["NAME", `${f} ${l}`], ", your Aadhaar ", ["AADHAAR", aadhaar()], " has been linked to your bank account."); },
  () => { const f = pick(FIRST), l = pick(LAST); return T(["NAME", `${f} ${l}`], " (PAN: ", ["PAN", pan()], ") filed the return on 31 July."); },
  () => T("Your OTP for login is ", ["OTP", digits(6)], ". Do not share it with anyone. -", pick(["SBI", "HDFC", "ICICI", "Axis"])),
  () => T(["OTP", digits(6)], " is your verification code for Swiggy. Valid for 10 minutes."),
  () => { const f = pick(FIRST), l = pick(LAST); return T("Call ", ["NAME", f], " on ", ["PHONE", phone()], " before 6 pm."); },
  () => { const f = pick(FIRST), l = pick(LAST); return T("Send the invoice to ", ["EMAIL", email(f, l)], " and cc accounts."); },
  () => { const f = pick(FIRST), l = pick(LAST); return T("Pay ₹", String(100 + Math.floor(rnd() * 9000)), " to ", ["UPI", `${f.toLowerCase()}${digits(2)}@${pick(PSP)}`], " for the dinner."); },
  () => T("Registered office: ", ["ADDRESS", `${1 + Math.floor(rnd() * 400)}, ${pick(STREET)}, ${pick(CITY)} - ${pin()}`], "."),
  () => T("GSTIN ", ["GSTIN", gstin()], " — invoice total ₹", String(1000 + Math.floor(rnd() * 90000)), "."),
  () => T("Card ending ", "XXXX", " — full number ", ["CC", card()], ", CVV: ", ["CVV", digits(3)], "."),
  () => { const f = pick(FIRST), l = pick(LAST), c = pick(CITY); return T(["NAME", `${f} ${l}`], " moved from ", ["LOCATION", c], " last year."); },
  () => { const c = pick(CITY); return T("Posted from ", ["LOCATION", c], " · 2h · Public"); },
  () => { const f = pick(FIRST), l = pick(LAST); return T("Nominee: ", ["NAME", `${f} ${l}`], ", relation: Spouse"); },
  () => T("DOB: ", ["DOB", `${1 + Math.floor(rnd() * 28)}/0${1 + Math.floor(rnd() * 9)}/19${70 + Math.floor(rnd() * 29)}`], " · Blood group B+"),
  () => T("A/c No: ", ["BANK_ACCOUNT", digits(12)], " · IFSC SBIN000", digits(4)),
  () => { const f = pick(FIRST), l = pick(LAST); return T("Thanks ", ["NAME", f], "! I've shared the notes with ", ["NAME", `${pick(FIRST)} ${pick(LAST)}`], "."); },
  () => { const f = pick(FIRST), l = pick(LAST); return T("Driver ", ["NAME", `${f} ${l}`], " (", ["PHONE", phone()], ") is arriving in a white Swift."); },
  () => T("Passport No. ", ["PASSPORT", `${pick("JKLMNPRSTVWZ")}${1 + Math.floor(rnd() * 9)}${digits(5)}${1 + Math.floor(rnd() * 9)}`], " expires in 2031."),
  () => T("Voter ID: ", ["VOTER_ID", `${pick(L)}${pick(L)}${pick(L)}${digits(7)}`], ", Part No 112"),
  () => { const f = pick(FIRST), l = pick(LAST); return T("Hi team, ", ["NAME", `${f} ${l}`], " from ", ["LOCATION", pick(CITY)], " will join the ISRO outreach session."); },
  () => T("Login from IP ", ["IP", `${10 + Math.floor(rnd() * 200)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${1 + Math.floor(rnd() * 250)}`], " was blocked."),
  () => T("Your password is ", ["PASSWORD", `${pick(FIRST)}@${digits(4)}`], " — change it after first login."),
  () => { const f = pick(FIRST), l = pick(LAST); return T("Reach ", ["NAME", `${f} ${l}`], " at ", ["EMAIL", email(f, l)], " or ", ["PHONE", phone()], "."); },
  () => T("Deliver to ", ["ADDRESS", `Flat ${100 + Math.floor(rnd() * 900)}, ${pick(["Shanti", "Sai", "Green", "Lotus"])} ${pick(["Apartments", "Residency", "Heights"])}, ${pick(STREET)}, ${pick(CITY)} ${pin()}`], "."),
  // hard negatives: must produce NO spans
  () => T("Order #", `${digits(3)}-${digits(7)}-${digits(7)}`, " was shipped on 12 March 2025."),
  () => T("PNR ", digits(10), " — Train ", digits(5), ", Coach B", String(1 + Math.floor(rnd() * 9)), ", Berth ", String(1 + Math.floor(rnd() * 70)), "."),
  () => T("Total payable: ₹", `${1 + Math.floor(rnd() * 99)},${digits(3)}.${digits(2)}`, " including GST @18%."),
  () => T("Version ", `v${1 + Math.floor(rnd() * 9)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 50)}`, " released on ", `2025-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`, "."),
  () => T("ISBN 978-", digits(1), "-", digits(3), "-", digits(5), "-", digits(1), " · 312 pages"),
  () => T("IFSC code SBIN000", digits(4), " belongs to the Main Branch."),
  () => T("The PSLV-C", String(50 + Math.floor(rnd() * 20)), " mission placed ", String(2 + Math.floor(rnd() * 30)), " satellites in orbit."),
  () => T("Chandrayaan-3 landed near the lunar south pole on 23 August 2023."),
  () => T("Sensex closed at ", `${60 + Math.floor(rnd() * 20)},${digits(3)}`, " points, up ", `${digits(1)}.${digits(2)}`, "%."),
  () => T("Room ", String(100 + Math.floor(rnd() * 400)), ", Block C — meeting at 3:30 pm."),
  () => T("Download speed 94.6 Mbps, ping 12 ms, jitter 3 ms."),
  () => T("Rated 4.5 by 12,345 users · 1,02,398 downloads"),
];
function indianCorpus(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(TEMPLATES[i % TEMPLATES.length]());
  return out;
}

// --- corpus C: Hindi / Devanagari (B4) --------------------------------------------------
const DEV_DIGIT = "०१२३४५६७८९";
const hiDigits = (n) => Array.from({ length: n }, () => DEV_DIGIT[Math.floor(rnd() * 10)]).join("");
function hiAadhaar() {
  for (;;) {
    const p = String(2 + Math.floor(rnd() * 8)) + digits(10);
    for (let d = 0; d < 10; d++) {
      if (verhoeffValid(p + d)) {
        const g = `${(p + d).slice(0, 4)} ${(p + d).slice(4, 8)} ${(p + d).slice(8)}`;
        return [...g].map((c) => (c >= "0" && c <= "9" ? DEV_DIGIT[+c] : c)).join("");
      }
    }
  }
}
const hiPhone = () => [...pick("6789") + digits(9)].map((c) => DEV_DIGIT[+c]).join("");
const HI_FIRST = ["रोहन", "विक्रम", "अंजलि", "प्रिया", "सुनीता", "अनिल", "कविता", "राजेश", "मीरा", "दीपक", "नेहा", "अमित", "पूजा", "संदीप", "रेखा", "मोहम्मद", "फरहान", "आयशा", "गुरप्रीत", "हरप्रीत"];
const HI_LAST = ["शर्मा", "वर्मा", "मेहता", "गुप्ता", "सिंह", "कौर", "अय्यर", "नायर", "रेड्डी", "पटेल", "यादव", "चौहान", "अंसारी", "खान", "जोशी", "देशपांडे"];
const HI_STREET_WORD = ["गांधी", "नेहरू", "अशोक", "राज"];
const HI_ADDR_KEYWORDS = ["मार्ग", "नगर", "गली", "कॉलोनी", "सेक्टर"];
const HI_NEGATIVE_CITY = ["चंडीगढ़", "मुंबई", "दिल्ली"];

function hiT(...parts) {
  let text = "";
  const gold = [];
  for (const p of parts) {
    if (typeof p === "string") text += p;
    else {
      gold.push({ start: text.length, end: text.length + p[1].length, type: p[0] });
      text += p[1];
    }
  }
  return { text, gold };
}
const HI_TEMPLATES = [
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return hiT("श्री ", ["NAME", `${f} ${l}`], " का आधार नंबर ", ["AADHAAR", hiAadhaar()], " है।"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return hiT("श्रीमती ", ["NAME", `${f} ${l}`], " ने आवेदन जमा किया।"); },
  () => hiT("आपका ओटीपी ", ["OTP", hiDigits(6)], " है, किसी के साथ साझा न करें।"),
  () => hiT("बैंक से भेजा गया ओटीपी: ", ["OTP", hiDigits(6)], "।"),
  () => { const f = pick(HI_FIRST); return hiT(f, " को कॉल करें: ", ["PHONE", hiPhone()], "।"); },
  () => hiT("सीवीवी कोड ", ["CVV", hiDigits(3)], " है।"),
  () => hiT("जन्म तिथि: ", ["DOB", `${1 + Math.floor(rnd() * 27)}/0${1 + Math.floor(rnd() * 9)}/19${70 + Math.floor(rnd() * 29)}`], "।"),
  () => hiT("पिन कोड ", ["PINCODE", String(1 + Math.floor(rnd() * 8)) + digits(5)], " दर्ज करें।"),
  () => hiT("मकान नंबर ", String(1 + Math.floor(rnd() * 400)), ", ", ["ADDRESS", `${pick(HI_STREET_WORD)} ${pick(HI_ADDR_KEYWORDS)}, ${pick(["मुंबई", "दिल्ली", "पुणे", "जयपुर"])} ${1 + Math.floor(rnd() * 8)}${digits(5)}`], " पर डिलीवर करें।"),
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return hiT("डॉ. ", ["NAME", `${f} ${l}`], " ", ["LOCATION", pick(HI_NEGATIVE_CITY)], " से आए हैं।"); },
  () => { const f = pick(HI_FIRST); return hiT("धन्यवाद ", ["NAME", f], "! रिपोर्ट भेज दी गई है।"); },
  () => hiT("खाता संख्या ", ["BANK_ACCOUNT", digits(12)], " में राशि जमा हुई।"),
  // hard negatives (no PII) — Devanagari digits in a non-PII context must not fire
  () => hiT("कुल राशि ₹", digits(1) + ",", digits(3), " है, जिसमें जीएसटी शामिल है।"),
  () => hiT("पीएनआर ", digits(10), " — ट्रेन ", digits(5), ", कोच बी", String(1 + Math.floor(rnd() * 9)), "।"),
  () => hiT("चंद्रयान-3 ने 23 अगस्त 2023 को चंद्रमा के दक्षिणी ध्रुव के पास लैंडिंग की।"),
  () => hiT("यह सेवा सोमवार से शुक्रवार, सुबह 9 बजे से शाम 6 बजे तक उपलब्ध है।"),
  () => hiT("संस्करण ", `v${1 + Math.floor(rnd() * 9)}.${Math.floor(rnd() * 20)}`, " जारी किया गया।"),
];
function hindiCorpus(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(HI_TEMPLATES[i % HI_TEMPLATES.length]());
  return out;
}

// --- scoring ---------------------------------------------------------------------
function covered(a, spans) {
  let c = 0;
  for (let i = a.start; i < a.end; i++) if (spans.some((s) => i >= s.start && i < s.end)) c++;
  return c / Math.max(1, a.end - a.start);
}

async function evaluate(corpus, withNer) {
  const perType = {};
  let tp = 0, fn = 0, ptp = 0, pfp = 0, negTotal = 0, negHit = 0;
  const t0 = performance.now();
  const nerOut = withNer ? await ner.tagBatch(corpus.map((c) => c.text)) : null;
  const ms = performance.now() - t0;
  for (let k = 0; k < corpus.length; k++) {
    const { text, gold } = corpus[k];
    const pre = nerOut?.[k] ?? [];
    const preds = await detectSpans(text, { nerTag: withNer ? async () => pre : undefined });
    const targeted = gold.filter((g) => g.type);
    const allGold = gold; // any labelled PII (ours or not) makes a prediction "correct"
    for (const g of targeted) {
      const pt = (perType[g.type] ??= { tp: 0, fn: 0, fp: 0 });
      if (covered(g, preds) >= 0.5) { tp++; pt.tp++; } else { fn++; pt.fn++; }
    }
    for (const p of preds) {
      const ok = covered(p, allGold) >= 0.5;
      if (ok) ptp++;
      else {
        pfp++;
        const pt = (perType[p.type] ??= { tp: 0, fn: 0, fp: 0 });
        pt.fp++;
      }
    }
    if (gold.length === 0) {
      negTotal++;
      if (preds.length) negHit++;
    }
  }
  const r = (a, b) => (a + b ? +(a / (a + b)).toFixed(3) : null);
  return {
    recall: r(tp, fn),
    precision: r(ptp, pfp),
    f1: tp + fn && ptp + pfp ? +((2 * r(tp, fn) * r(ptp, pfp)) / (r(tp, fn) + r(ptp, pfp))).toFixed(3) : null,
    goldSpans: tp + fn,
    predictedSpans: ptp + pfp,
    hardNegatives: negTotal ? { sentences: negTotal, falseAlarms: negHit } : undefined,
    nerMsPerSentence: withNer ? +(ms / corpus.length).toFixed(1) : 0,
    perType: Object.fromEntries(Object.entries(perType).sort().map(([k, v]) => [k, { recall: r(v.tp, v.fn), falsePositives: v.fp, n: v.tp + v.fn }])),
  };
}

const ai4p = await loadAi4privacy();
const indian = indianCorpus(360);
const hindi = hindiCorpus(150);
const report = {
  generatedAt: new Date().toISOString(),
  engine: "rules (regex + Luhn/Verhoeff/GSTIN validators) + BERT-small PII NER INT8 (29 MB)",
  ai4privacy_en: {
    source: `ai4privacy/pii-masking-200k english, first ${ai4p.length} rows`,
    rulesOnly: await evaluate(ai4p, false),
    rulesPlusNer: await evaluate(ai4p, true),
  },
  indian_synthetic: {
    source: `${indian.length} sentences from ${TEMPLATES.length} templates (${TEMPLATES.length - 12} with PII, 12 hard-negative)`,
    rulesOnly: await evaluate(indian, false),
    rulesPlusNer: await evaluate(indian, true),
  },
  hindi_devanagari: {
    // rules only — the shipped NER model is English-trained (BERT-small PII); it
    // is expected to contribute ~nothing on Devanagari script, so Hindi coverage
    // is entirely the regex/checksum layer (normalizeDevanagariDigits + the
    // Hindi-script rules in redact.js). "Done when": recall >= 0.85 @ precision
    // >= 0.95 on this set, with the English corpora above unaffected.
    source: `${hindi.length} sentences from ${HI_TEMPLATES.length} templates (${HI_TEMPLATES.length - 5} with PII, 5 hard-negative), Aadhaar/OTP/CVV in Devanagari digits`,
    rulesOnly: await evaluate(hindi, false),
  },
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/pii.json", JSON.stringify(report, null, 2));
const show = (k, v) => console.log(k.padEnd(34), `R=${v.recall} P=${v.precision} F1=${v.f1}`, v.hardNegatives ? `neg-FA=${v.hardNegatives.falseAlarms}/${v.hardNegatives.sentences}` : "");
show("ai4privacy  rules only", report.ai4privacy_en.rulesOnly);
show("ai4privacy  rules + NER", report.ai4privacy_en.rulesPlusNer);
show("indian      rules only", report.indian_synthetic.rulesOnly);
show("indian      rules + NER", report.indian_synthetic.rulesPlusNer);
show("hindi       rules only", report.hindi_devanagari.rulesOnly);
console.log("per type (indian, rules+NER):", JSON.stringify(report.indian_synthetic.rulesPlusNer.perType));
console.log("per type (ai4privacy, rules+NER):", JSON.stringify(report.ai4privacy_en.rulesPlusNer.perType));
console.log("per type (hindi, rules only):", JSON.stringify(report.hindi_devanagari.rulesOnly.perType));
