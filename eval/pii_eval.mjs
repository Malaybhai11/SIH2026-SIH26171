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
//   B. Indian synthetic set — 36 sentence templates x random Indian names/cities and
//      checksum-valid identifiers (Aadhaar/Verhoeff, GSTIN, PAN, UPI...), plus hard
//      negatives (order ids, PNRs, prices, dates, versions, ISBNs, IFSC).
//   C. Hindi/Devanagari synthetic set (B4) — same construction, but names, addresses,
//      OTP/password/DOB/account labels and structured-PII digits are all rendered in
//      Devanagari. Evaluated RULES-ONLY: the shipped NER model is English-only (see
//      docs/model-contract.md), so Hindi name/place recall here comes entirely from
//      the honorific-pattern and gazetteer rules in redact.js, not from NER — a
//      Devanagari-capable NER model is tracked separately, not silently substituted.
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

// --- corpus C: Hindi / Devanagari synthetic (B4) ------------------------------------
// Structured-PII digits render in Devanagari (०-९) via toDev(); PAN/GSTIN/UPI/email
// stay in Latin+digit form, which is how they are actually written in real Hindi
// text. Names/cities match the honorific and gazetteer rules in redact.js exactly —
// this corpus tests THOSE rules, so it must use the same vocabulary they recognize.
const toDev = (s) => String(s).replace(/\d/g, (d) => "०१२३४५६७८९"[+d]);
// plain 10-digit Indian mobile, no prefix/separator — safe to toDev() directly
// (an earlier version reused the English phone() and stripped "+91 ", which merges
// the "91" into the digit run and makes it unmatchable; see git history)
const phoneDigits10 = () => pick("6789") + digits(9);
const HI_FIRST = ["रोहन", "अंजलि", "अनिल", "प्रिया", "विक्रम", "सुनीता", "अरुण", "कविता", "संदीप", "नेहा", "राजेश", "पूजा", "मनोज", "दीपिका", "करण", "इशा", "गौरव", "स्वाति", "अमित", "रीना"];
const HI_LAST = ["शर्मा", "वर्मा", "गुप्ता", "अय्यर", "नायर", "रेड्डी", "पटेल", "मेहता", "सिंह", "कौर", "चौहान", "यादव", "अग्रवाल", "जोशी", "देशपांडे", "मुखर्जी", "बनर्जी", "कुलकर्णी", "तिवारी", "शेट्टी"];
// must match the LOCATION gazetteer regex in redact.js exactly (this corpus tests that rule)
const HI_CITY = ["मुंबई", "दिल्ली", "बेंगलुरु", "चेन्नई", "कोलकाता", "हैदराबाद", "पुणे", "अहमदाबाद", "जयपुर", "लखनऊ", "कोच्चि", "इंदौर", "भोपाल", "चंडीगढ़", "नागपुर", "सूरत", "पटना", "गुवाहाटी", "वाराणसी", "देहरादून", "रांची", "भुवनेश्वर", "मैसूरु", "कानपुर"];
const HI_AREA = ["रोड", "मार्ग", "नगर", "कॉलोनी", "गली", "सेक्टर", "ब्लॉक", "मोहल्ला", "गाँव", "विहार"];
const HI_HOUSE = ["मकान", "फ्लैट", "प्लॉट"];
const HI_PSP = ["okaxis", "oksbi", "okhdfcbank", "okicici", "ybl", "paytm"];

const HI_TEMPLATES = [
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("श्री ", ["NAME", `${f} ${l}`], " का आधार ", ["AADHAAR", toDev(aadhaar())], " है।"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("श्रीमती ", ["NAME", `${f} ${l}`], " (पैन: ", ["PAN", pan()], ") ने रिटर्न फाइल किया।"); },
  () => T("आपका ओटीपी ", ["OTP", toDev(digits(6))], " है। किसी के साथ साझा न करें।"),
  () => T(["OTP", toDev(digits(6))], " ही आपका ओटीपी है, ५ मिनट में समाप्त हो जाएगा।"),
  () => { const f = pick(HI_FIRST); return T("संपर्क करें: ", ["NAME", f], " को ", ["PHONE", toDev(phoneDigits10())], " पर।"); },
  () => { const f = pick(FIRST), l = pick(LAST); return T("मेल भेजें ", ["EMAIL", email(f, l)], " पर।"); },  // Latin username: real Indian email local-parts are ASCII, even in Hindi text
  () => { const f = pick(FIRST); return T("₹५०० भेजें ", ["UPI", `${f.toLowerCase()}${digits(2)}@${pick(HI_PSP)}`], " पर।"); },  // UPI VPA handles are Latin too
  () => { const h = pick(HI_HOUSE), a = pick(HI_AREA), c = pick(HI_CITY); return T(["ADDRESS", `${h} नं. ${toDev(String(1 + Math.floor(rnd() * 400)))}, ${a} ${toDev(String(1 + Math.floor(rnd() * 40)))}, ${c}`], " पर डिलीवर करें।"); },
  () => T("जीएसटीआईएन ", ["GSTIN", gstin()], " — कुल राशि ₹", toDev(String(1000 + Math.floor(rnd() * 90000))), "।"),
  () => T("कार्ड नंबर ", ["CC", toDev(card())], ", सीवीवी ", ["CVV", toDev(digits(3))], " है।"),
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST), c = pick(HI_CITY); return T(["NAME", `${f} ${l}`], " पिछले साल ", ["LOCATION", c], " से आए थे।"); },
  () => { const c = pick(HI_CITY); return T("पोस्ट किया गया ", ["LOCATION", c], " से · २घं पहले"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("नॉमिनी: ", ["NAME", `${f} ${l}`], ", रिश्ता: पति/पत्नी"); },
  () => T("जन्म तिथि: ", ["DOB", `${toDev(String(1 + Math.floor(rnd() * 28)))}/०${toDev(String(1 + Math.floor(rnd() * 9)))}/१९${toDev(String(70 + Math.floor(rnd() * 29)))}`], " रक्त समूह बी+"),
  () => T("खाता संख्या: ", ["BANK_ACCOUNT", toDev(digits(12))], " आईएफएससी SBIN000", toDev(digits(4))),
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("धन्यवाद ", ["NAME", f], "! मैंने नोट्स ", ["NAME", `${pick(HI_FIRST)} ${pick(HI_LAST)}`], " के साथ साझा किए।"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("डॉ ", ["NAME", `${f} ${l}`], " ने मरीज को देखा और दवा लिखी।"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("कुमारी ", ["NAME", `${f} ${l}`], " को पुरस्कार मिला।"); },
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); const c = pick(HI_CITY); return T("नमस्ते टीम, ", ["NAME", `${f} ${l}`], " ", ["LOCATION", c], " से आईएसआरओ सत्र में शामिल होंगे।"); },
  () => T("मेरा पासवर्ड ", ["PASSWORD", `${pick(["Hunter", "Sunrise", "Welcome"])}@${digits(4)}`], " है — पहली बार लॉगिन के बाद बदलें।"),
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); const ef = pick(FIRST), el = pick(LAST); return T("संपर्क करें ", ["NAME", `${f} ${l}`], " को ", ["EMAIL", email(ef, el)], " या ", ["PHONE", toDev(phoneDigits10())], " पर।"); },
  () => { const h = pick(HI_HOUSE), c = pick(HI_CITY); return T(["ADDRESS", `${h} ७, हाईटेक सिटी रोड, माधापुर, ${c}`], ", तेलंगाना"); },
  () => T("पिन कोड ", ["PINCODE", toDev(pin())], " वाले क्षेत्र में सेवा उपलब्ध है।"),
  () => { const f = pick(HI_FIRST), l = pick(HI_LAST); return T("ड्राइवर ", ["NAME", `${f} ${l}`], " (", ["PHONE", toDev(phoneDigits10())], ") सफेद स्विफ्ट में आ रहे हैं।"); },
  // hard negatives: must produce NO spans (Hindi reference/order/date/version context)
  () => T("ऑर्डर संख्या ", digits(3), "-", digits(7), " १२ मार्च २०२५ को भेजा गया।"),
  () => T("पीएनआर ", toDev(digits(10)), " — ट्रेन ", toDev(digits(5)), ", कोच बी", toDev(String(1 + Math.floor(rnd() * 9))), "।"),
  () => T("कुल देय राशि: ₹", toDev(String(1 + Math.floor(rnd() * 99))), ",", toDev(digits(3)), " जीएसटी सहित।"),
  () => T("चंद्रयान-3 ने २३ अगस्त २०२३ को चंद्रमा के दक्षिणी ध्रुव के पास लैंड किया।"),
  () => T("पीएसएलवी-सी", String(50 + Math.floor(rnd() * 20)), " मिशन ने ", String(2 + Math.floor(rnd() * 30)), " उपग्रह कक्षा में स्थापित किए।"),
  () => T("सेंसेक्स ", toDev(String(60 + Math.floor(rnd() * 20))), ",", toDev(digits(3)), " अंक पर बंद हुआ।"),
  () => T("डाउनलोड गति ९४.६ Mbps, पिंग १२ ms।"),
  () => T("१२,३४५ उपयोगकर्ताओं द्वारा ४.५ रेटिंग, १,०२,३९८ डाउनलोड"),
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
const hindi = hindiCorpus(340);
const report = {
  generatedAt: new Date().toISOString(),
  engine: "rules (regex + Luhn/Verhoeff/GSTIN validators) + BERT-small PII NER INT8 (29 MB, English-only)",
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
  hindi_synthetic: {
    source: `${hindi.length} Devanagari sentences from ${HI_TEMPLATES.length} templates (${HI_TEMPLATES.length - 7} with PII, 7 hard-negative)`,
    note:
      "rules-only by construction — the shipped NER model is English-only (docs/model-contract.md), so this " +
      "number is exactly what B4's rule-based work (Devanagari digit normalization, honorific names, gazetteer " +
      "locations, Hindi label words) achieves alone. See perType: structured/labelled PII (AADHAAR/OTP/PHONE/" +
      "ADDRESS/DOB/BANK_ACCOUNT/PINCODE/PAN/GSTIN/UPI/CC/CVV) is rule-covered; bare names with no honorific and " +
      "no NER are the known, expected gap — a multilingual NER model closes it (tracked separately).",
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
show("hindi       rules only", report.hindi_synthetic.rulesOnly);
console.log("per type (indian, rules+NER):", JSON.stringify(report.indian_synthetic.rulesPlusNer.perType));
console.log("per type (ai4privacy, rules+NER):", JSON.stringify(report.ai4privacy_en.rulesPlusNer.perType));
console.log("per type (hindi, rules only):", JSON.stringify(report.hindi_synthetic.rulesOnly.perType));
