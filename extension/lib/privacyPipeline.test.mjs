// Run: node --test extension/lib/privacyPipeline.test.mjs
// DOM-free: only exercises the pure functions (rehydrateAction, egressGate,
// tokenizeOutgoing, sanitizeUrl), not perceiveStep, which needs chrome.* + a tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rehydrateAction, egressGate, tokenizeOutgoing, sanitizeUrl } from "./privacyPipeline.js";
import { Vault, redactText } from "./redact.js";

test("rehydrateAction: surrogate mode resolves back to the real value, same as token mode", async () => {
  const v = new Vault(null, { mode: "surrogate" });
  const { text } = await redactText("call 9876543210", { vault: v });
  const surrogate = text.replace("call ", "");
  assert.notEqual(surrogate, "9876543210");

  const action = { type: "type", targetId: "n_phone", text: surrogate };
  const rehydrated = rehydrateAction(action, v);
  assert.equal(rehydrated.text, "9876543210");
  // the action object itself is not mutated in place
  assert.equal(action.text, surrogate);
});

test("rehydrateAction: resolves every text-bearing field, including fill_form's fields[]", async () => {
  const v = new Vault(null, { mode: "surrogate" });
  const name = (await redactText("Priya Sharma", { vault: v, nerTag: async () => [{ start: 0, end: 12, type: "NAME" }] })).text;
  const email = (await redactText("priya@x.in", { vault: v })).text;
  assert.notEqual(name, "Priya Sharma");
  assert.notEqual(email, "priya@x.in");

  const action = {
    type: "fill_form",
    fields: [
      { targetId: "n_name", text: name },
      { targetId: "n_email", text: email },
    ],
  };
  const rehydrated = rehydrateAction(action, v);
  assert.deepEqual(
    rehydrated.fields.map((f) => f.text),
    ["Priya Sharma", "priya@x.in"],
  );
});

test("rehydrateAction: a value that isn't in the vault passes through unchanged (fail-open only within the vault's own placeholders)", () => {
  const v = new Vault(null, { mode: "surrogate" });
  const action = { type: "type", targetId: "n_1", text: "Asha Verma (never minted)" };
  assert.equal(rehydrateAction(action, v).text, "Asha Verma (never minted)");
});

test("egressGate: surrogate-mode vault still catches a raw real value that slipped into outgoing text", async () => {
  const v = new Vault(null, { mode: "surrogate" });
  const { text: surrogateEmail } = await redactText("priya.sharma@gmail.com", { vault: v });
  // simulate a pipeline defect: the real value ended up in outgoing text unredacted
  const { body, fixes, where } = egressGate({ prompt: "contact priya.sharma@gmail.com about the order" }, v);
  assert.equal(fixes, 1);
  assert.equal(where[0], "prompt");
  // repaired with the vault's own placeholder for that value (the surrogate, not a bracket token)
  assert.equal(body.prompt, `contact ${surrogateEmail} about the order`);
  assert.equal(body.prompt.includes("priya.sharma@gmail.com"), false);
});

test("egressGate: clean surrogate text needs no repair", async () => {
  const v = new Vault(null, { mode: "surrogate" });
  const { text } = await redactText("email priya@x.in", { vault: v });
  const { body, fixes } = egressGate({ prompt: text }, v);
  assert.equal(fixes, 0);
  assert.equal(body.prompt, text);
});

test("tokenizeOutgoing: surrogate mode produces fluent text, not bracket tokens, for supported types", async () => {
  const v = new Vault(null, { mode: "surrogate" });
  const nerTag = async (t) => (t.includes("Priya Sharma") ? [{ start: t.indexOf("Priya Sharma"), end: t.indexOf("Priya Sharma") + 12, type: "NAME" }] : []);
  const out = await tokenizeOutgoing("My name is Priya Sharma, email priya@x.in", v, nerTag);
  assert.equal(out.includes("Priya Sharma"), false);
  assert.equal(out.includes("priya@x.in"), false);
  assert.equal(/\[NAME_\d+\]/.test(out), false); // no bracket token — a fluent surrogate instead
  assert.equal(v.resolve(out), "My name is Priya Sharma, email priya@x.in");
});

test("sanitizeUrl: unaffected by redaction mode (path-only, no PII types surrogate covers)", () => {
  const v = new Vault(null, { mode: "surrogate" });
  assert.equal(sanitizeUrl("https://bank.example/accounts?id=123", v), "https://bank.example/accounts?…");
});
