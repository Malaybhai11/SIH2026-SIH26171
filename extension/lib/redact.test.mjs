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

// Hindi / Devanagari — B4. `\b` does not treat Devanagari as a word character (it's
// defined over ASCII \w), so every Hindi rule is bounded with an explicit script
// lookaround instead; these tests exist specifically to catch that class of regression.
test("Devanagari digit normalization is index-preserving", () => {
  assert.equal(normalizeDevanagariDigits("०१२३४५६७८९"), "0123456789");
  assert.equal(normalizeDevanagariDigits("२३४५ ६७८९ ०१२४"), "2345 6789 0124");
  assert.equal(normalizeDevanagariDigits("no digits here").length, "no digits here".length);
  // mixed-script string: every non-digit codepoint must survive untouched, same length
  const mixed = "राशि ₹१२,३४५ है";
  assert.equal(normalizeDevanagariDigits(mixed).length, mixed.length);
});

test("structured PII in Devanagari numerals hits the same rules as Latin numerals", () => {
  const types = (s) => detectRuleSpans(s).map((x) => x.type);
  assert.deepEqual(types("आधार २३४५ ६७८९ ०१२४ है"), ["AADHAAR"]); // Verhoeff-valid
  // invalid check digit -> not tagged AADHAAR; still conservatively caught as a
  // phone-shaped digit run (same "redact first, mislabel is fine" fallback as the
  // Luhn-invalid-card case above) rather than leaking untouched
  assert.ok(!types("आधार २३४५ ६७८९ ०१२५ है").includes("AADHAAR"));
  assert.deepEqual(types("संपर्क करें ९८७६५४३२१० पर"), ["PHONE"]);
  assert.deepEqual(types("आपका ओटीपी ४८२९१३ है"), ["OTP"]);
  assert.deepEqual(types("जन्म तिथि: १४/०८/१९९५"), ["DOB"]);
  assert.deepEqual(types("पिन कोड ११०६८५"), ["PINCODE"]);
  // the raw value keeps the original Devanagari digits, not the normalized ASCII copy
  assert.equal(detectRuleSpans("आधार २३४५ ६७८९ ०१२४ है")[0].value, "२३४५ ६७८९ ०१२४");
});

test("Hindi label words gate OTP/password/DOB/bank-account the same way English labels do", () => {
  const types = (s) => detectRuleSpans(s).map((x) => x.type);
  assert.deepEqual(types("मेरा पासवर्ड Hunter@2026 है।"), ["PASSWORD"]);
  assert.deepEqual(types("खाता संख्या ५०१००२३४५६७८ में जमा किया गया।"), ["BANK_ACCOUNT"]);
  assert.deepEqual(types("५५१९२० ही आपका ओटीपी है।"), ["OTP"]);
});

test("Hindi addresses: house marker + area words, order-independent", () => {
  const types = (s) => detectRuleSpans(s).map((x) => x.type);
  assert.deepEqual(types("मकान नं. १२, सेक्टर १५, रोहिणी, दिल्ली - पिन कोड ११०६८५"), ["ADDRESS"]);
  assert.deepEqual(types("प्लॉट ७, हाईटेक सिटी रोड, माधापुर, हैदराबाद, तेलंगाना"), ["ADDRESS"]);
  // no house marker + no street word -> not an address
  assert.deepEqual(types("रोहिणी, दिल्ली में मौसम अच्छा है"), ["LOCATION"]);
});

test("Hindi honorific names stop at function words and don't swallow a following place", () => {
  const types = (s) => detectRuleSpans(s).map((x) => x.type);
  const t1 = detectRuleSpans("श्री रोहन शर्मा का आधार २३४५ ६७८९ ०१२४ है।");
  assert.deepEqual(t1.map((x) => [x.type, x.value]), [["NAME", "रोहन शर्मा"], ["AADHAAR", "२३४५ ६७८९ ०१२४"]]);
  // a city right after the name (no comma) is NOT absorbed into NAME — it's still
  // caught, just by the separate LOCATION gazetteer rule instead
  const t2 = detectRuleSpans("श्रीमती अंजलि गुप्ता मुंबई से आई हैं।");
  assert.deepEqual(t2.map((x) => [x.type, x.value]), [["NAME", "अंजलि गुप्ता"], ["LOCATION", "मुंबई"]]);
});

test("Hindi hard negatives: reference numbers and plain prose stay untouched", () => {
  for (const s of [
    "ऑर्डर संख्या 402-1234567 पर कार्रवाई हो चुकी है",
    "टिकट संख्या ४५२१३६७८९०, ट्रेन १२०१०",
    "चंद्रयान-3 ने 23 अगस्त 2023 को चंद्रमा पर लैंड किया",
    "कुल राशि ₹१२,३४५ है",
  ]) {
    assert.deepEqual(detectRuleSpans(s), [], s);
  }
});
