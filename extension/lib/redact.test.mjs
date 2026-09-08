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
  assert.equal(redactTextRegex("aadhaar 1234 5678 9012").text, `aadhaar ${TOKENS.ID}`);
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
