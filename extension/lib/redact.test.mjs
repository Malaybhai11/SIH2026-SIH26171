// Run: npm run test:redact   (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactTextRegex,
  applyNerTags,
  redactNodes,
  luhnValid,
  hasResidualPII,
  scrubLog,
  TOKENS,
  Vault,
  redactText,
  aadhaarValid,
  gstinValid,
  detectRuleSpans,
  normalizeDevanagariDigits,
  customTermSpans,
  detectSpans,
} from "./redact.js";

test("luhn", () => {
  assert.equal(luhnValid("4242 4242 4242 4242"), true);
  assert.equal(luhnValid("4242424242424241"), false);
  assert.equal(luhnValid("1234"), false);
});

test("email redaction", () => {
  const { text, hits } = redactTextRegex("contact me at jane.doe@example.co.uk today");
  assert.equal(text, `contact me at ${TOKENS.EMAIL} today`);
  assert.equal(hits[0].type, "EMAIL");
});

test("credit card only when Luhn-valid", () => {
  assert.equal(redactTextRegex("card 4242 4242 4242 4242").text, `card ${TOKENS.CC}`);
  assert.equal(redactTextRegex("order 1234 5678 9012 3456").text.includes(TOKENS.CC), false);
});

test("ssn + national id", () => {
  assert.equal(redactTextRegex("ssn 123-45-6789").text, `ssn ${TOKENS.SSN}`);
  // Verhoeff-valid Aadhaar is redacted; a random 12-digit number is not
  assert.equal(redactTextRegex("aadhaar 2345 6789 0124").text, `aadhaar ${TOKENS.ID}`);
  assert.equal(redactTextRegex("ref 1234 5678 9012").text.includes(TOKENS.ID), false);
});

test("phone needs a separator, not bare integers", () => {
  assert.equal(redactTextRegex("call +1 (415) 555-2671 now").text.includes(TOKENS.PHONE), true);
  assert.equal(redactTextRegex("viewed 4155552671000 times").text.includes(TOKENS.PHONE), false);
});

test("address heuristic", () => {
  assert.ok(redactTextRegex("ships from 350 Fifth Avenue, NY").text.includes(TOKENS.ADDRESS));
  assert.ok(redactTextRegex("HQ at 1600 Amphitheatre Parkway").text.includes(TOKENS.ADDRESS));
});

test("NER tags map PER/LOC only", () => {
  const s = "Elon Musk visited Boca Chica with Acme Corp";
  const tags = [
    { start: 0, end: 9, label: "PER" },
    { start: 18, end: 28, label: "LOC" },
    { start: 34, end: 43, label: "ORG" },
  ];
  const { text } = applyNerTags(s, tags);
  assert.equal(text, `${TOKENS.NAME} visited ${TOKENS.LOCATION} with Acme Corp`);
});

test("redactNodes walks text + author and logs elementId", async () => {
  const nodes = [
    { id: "n_1", text: "reach me: a@b.com", author: "@real" },
    { id: "n_2", text: "no pii here" },
  ];
  const { nodes: out, log } = await redactNodes(nodes);
  assert.equal(out[0].text, `reach me: ${TOKENS.EMAIL}`);
  assert.equal(log[0].elementId, "n_1");
  assert.equal(scrubLog(log).byType.EMAIL, 1);
});

test("hasResidualPII catches leaks for server-side QA", () => {
  assert.equal(hasResidualPII("still has x@y.com"), true);
  assert.equal(hasResidualPII("clean [REDACTED_EMAIL] text"), false);
});

test("Indian identifiers are validated, not just pattern-matched", () => {
  assert.equal(aadhaarValid("234567890124"), true);
  assert.equal(aadhaarValid("234567890125"), false);
  assert.equal(aadhaarValid("134567890124"), false); // Aadhaar never starts with 0/1
  assert.equal(gstinValid("27AAPFU0939F1ZV"), true);
  assert.equal(gstinValid("27AAPFU0939F1ZX"), false);
  const types = (s) => detectRuleSpans(s).map((x) => x.type);
  assert.deepEqual(types("PAN ABCPS1234K"), ["PAN"]);
  assert.deepEqual(types("pay rahul.v@okaxis"), ["UPI"]);
  assert.deepEqual(types("mail rahul.v@gmail.com"), ["EMAIL"]);
  assert.deepEqual(types("call 9876543210"), ["PHONE"]);
  assert.deepEqual(types("Your OTP is 482913"), ["OTP"]);
  assert.deepEqual(types("DL MH-12-2015-0012345"), ["DRIVING_LICENSE"]);
  assert.deepEqual(types("House No. 12, Sector 15, Rohini, Delhi 110085"), ["ADDRESS"]);
});

test("hard negatives stay untouched", () => {
  for (const s of [
    "Order #402-1234567-8901234 total ₹1,299",
    "Released on 2025-03-12, version v1.2.3.4",
    "ISBN 978-3-16-148410-0",
    "IFSC HDFC0001234 (branch code)",
    "Chandrayaan-3 landed on 23 August 2023",
    "1,234,567 views",
  ]) {
    assert.deepEqual(detectRuleSpans(s), [], s);
  }
});

test("vault: stable numbered tokens and local-only resolution", async () => {
  const v = new Vault();
  const a = await redactText("Mail priya@x.in, cc priya@x.in and ravi@y.in", { vault: v });
  assert.equal(a.text, "Mail [EMAIL_1], cc [EMAIL_1] and [EMAIL_2]");
  assert.equal(v.resolve("type [EMAIL_2] here"), "type ravi@y.in here");
  assert.equal(v.resolve("unknown [EMAIL_9] stays"), "unknown [EMAIL_9] stays");
  assert.deepEqual(v.catalog().map((c) => c.type), ["EMAIL", "EMAIL"]);
  // survives serialization (chrome.storage.session round-trip)
  const v2 = new Vault(JSON.parse(JSON.stringify(v)));
  assert.equal(v2.tokenFor("EMAIL", "PRIYA@x.in"), "[EMAIL_1]");
});

test("NER spans merge with rules; rules win overlaps", async () => {
  const nerTag = async () => [{ start: 0, end: 12, type: "NAME" }, { start: 17, end: 29, type: "NAME" }];
  const r = await redactText("Rajesh Kumar at rajesh@k.com", { nerTag, vault: new Vault() });
  assert.equal(r.text, "[NAME_1] at [EMAIL_1]");
});

// --- B4: Hindi / Devanagari PII ---------------------------------------------------

test("normalizeDevanagariDigits maps ०-९ to 0-9, length-preserving", () => {
  assert.equal(normalizeDevanagariDigits("२३४१ २३४१ २३४६"), "2341 2341 2346");
  assert.equal(normalizeDevanagariDigits("no digits here"), "no digits here");
  assert.equal(normalizeDevanagariDigits("mixed 123 और ४५६").length, "mixed 123 और ४५६".length);
});

test("Aadhaar checksum validates on Devanagari digits, same as ASCII", () => {
  const ascii = detectRuleSpans("Aadhaar 2341 2341 2346");
  const dev = detectRuleSpans("आधार २३४१ २३४१ २३४६");
  assert.equal(ascii.filter((s) => s.type === "AADHAAR").length, 1);
  const devSpan = dev.find((s) => s.type === "AADHAAR");
  assert.ok(devSpan, "Devanagari Aadhaar not detected");
  assert.equal(devSpan.value, "2341 2341 2346"); // value normalised to ASCII for vault identity
});

test("PINCODE label matches 'zip code' (two words), not just bare ZIP", () => {
  // Regression: "ZIP\s*[:-]?\s*digits" required the digits to follow the label
  // directly, so "zip code 560001" — the word "code" sitting between the label
  // and the number — fell through undetected and reached the server as plain
  // text (caught live via eval/benchmark30_eval.mjs's leak check).
  assert.equal(detectRuleSpans("zip code 560001")[0]?.type, "PINCODE");
  assert.equal(detectRuleSpans("Zip: 560001")[0]?.type, "PINCODE");
  assert.equal(detectRuleSpans("Postal code 560001")[0]?.type, "PINCODE");
  assert.equal(detectRuleSpans("Pincode 560001")[0]?.type, "PINCODE");
});

test("Hindi OTP/CVV/PIN/DOB label + Devanagari digits", () => {
  assert.equal(detectRuleSpans("आपका ओटीपी ४८२९१३ है")[0]?.type, "OTP");
  assert.equal(detectRuleSpans("सीवीवी: १२३")[0]?.type, "CVV");
  assert.equal(detectRuleSpans("पिन कोड: ११०१२३")[0]?.type, "PINCODE");
  assert.equal(detectRuleSpans("जन्म तिथि: 15/08/1990")[0]?.type, "DOB");
});

test("Hindi honorific + name, bounded by particles/verbs/city names", () => {
  assert.deepEqual(
    detectRuleSpans("श्री रोहन मेहता का फोन नंबर ९८७६५४३२१० है।").map((s) => [s.type, s.value]),
    [["NAME", "रोहन मेहता"], ["PHONE", "9876543210"]],
  );
  const s = detectRuleSpans("श्री विक्रम सिंह चंडीगढ़ से आए हैं।");
  assert.deepEqual(s.map((x) => [x.type, x.value]), [["NAME", "विक्रम सिंह"], ["LOCATION", "चंडीगढ़"]]);
});

test("Hindi address (house marker + address word + city + PIN)", () => {
  const s = detectRuleSpans("मकान नंबर 12, गांधी मार्ग, मुंबई 400001 पर डिलीवर करें।");
  const addr = s.find((x) => x.type === "ADDRESS");
  assert.ok(addr);
  assert.match(addr.value, /मार्ग/);
  assert.match(addr.value, /400001/);
});

test("Hindi PNR/order/ticket numbers are NOT flagged as phone (Devanagari reference context)", () => {
  assert.deepEqual(detectRuleSpans("पीएनआर 6719633314 — ट्रेन 86262, कोच बी9।"), []);
});

test("Hindi hard negatives stay untouched", () => {
  for (const s of [
    "चंद्रयान-3 ने 23 अगस्त 2023 को चंद्रमा के दक्षिणी ध्रुव के पास लैंडिंग की।",
    "यह सेवा सोमवार से शुक्रवार, सुबह 9 बजे से शाम 6 बजे तक उपलब्ध है।",
  ]) {
    assert.deepEqual(detectRuleSpans(s), [], s);
  }
});

// --- B3: user-defined custom sensitive terms ---------------------------------------

test("customTermSpans matches a literal term, case-insensitively, everywhere it appears", () => {
  const terms = [{ label: "Codename", term: "Project Falcon" }];
  const spans = customTermSpans("Update on project falcon: launch moved to March. PROJECT FALCON is on track.", terms);
  assert.equal(spans.length, 2);
  assert.ok(spans.every((s) => s.type === "CODENAME"));
});

test("customTermSpans supports a user regex pattern", () => {
  const terms = [{ label: "Employee ID", term: "EMP-\\d{5}", isRegex: true }];
  const spans = customTermSpans("Badge EMP-00231 was reissued.", terms);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, "EMPLOYEE_ID");
  assert.equal(spans[0].value, "EMP-00231");
});

test("customTermSpans skips an invalid user regex instead of throwing", () => {
  const terms = [{ label: "Bad", term: "(unclosed", isRegex: true }];
  assert.doesNotThrow(() => customTermSpans("some (unclosed text", terms));
  assert.deepEqual(customTermSpans("some (unclosed text", terms), []);
});

test("a custom term is redacted through the full detectSpans pipeline, same as built-in PII", async () => {
  const terms = [{ label: "Codename", term: "Aavaran Secret" }];
  const spans = await detectSpans("The Aavaran Secret launch is confirmed.", { customTerms: terms });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, "CODENAME");
  const v = new Vault();
  const { text } = await redactText("The Aavaran Secret launch is confirmed.", { vault: v, customTerms: terms });
  assert.equal(text, "The [CODENAME_1] launch is confirmed.");
});
