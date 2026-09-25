// E2 — red-team leak suite: ~20 adversarial techniques, each trying a DIFFERENT way
// to get a real PII value to leave the device, broader than the single-mechanism
// evals (B1 token release, B2 prompt injection, B3 custom terms, D1 iframes). Every
// check runs through the real built extension (eval/e2e_harness.mjs's launch()) —
// same pattern as those evals: PRIVACY_PREVIEW returns exactly what the DOM/pixel
// pipeline WOULD send, so `serverText.includes(secretValue)` on that output is the
// same class of proof custom_terms_eval.mjs gets from /agent/last-received.
//
//   node eval/redteam_leak_eval.mjs   (server must be running, e.g.
//     LLM_PROVIDER=mock AUDIT_LOG=1 uvicorn server.app:app --port 8040)

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";

function rasterize(boxes, W, H) {
  const m = new Uint8Array(Math.max(1, W * H));
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(W, Math.ceil(b.x + b.w)), y1 = Math.min(H, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
  }
  return m;
}
const coverageOf = (rect, boxes, W, H) => {
  const G = rasterize([rect], W, H);
  const P = rasterize(boxes, W, H);
  const total = G.reduce((a, v) => a + v, 0);
  if (!total) return 1;
  let inter = 0;
  for (let i = 0; i < G.length; i++) inter += G[i] & P[i];
  return inter / total;
};

async function rectOf(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  const b = await el.boundingBox();
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

// Ground truth for "is THIS SUBSTRING's pixels covered" (not the whole element,
// which may also contain non-sensitive label text) — a Range over just the
// substring, same technique pixelPii.js itself uses (Range.getClientRects). The
// `// range-rect-inline` marker documents that this same ~10-line body is inlined
// into each page.evaluate() call below (Puppeteer serialises one function per
// call — a shared helper can't be referenced from inside the page context).

const { browser, ctl } = await launch();

async function run(url, fn) {
  const page = await openPage(browser, url);
  const tabId = await tabIdFor(ctl, url);
  const r = await preview(ctl, tabId, "balanced");
  const domText = (r.sanitizedDom || []).map((n) => n.text).join(" | ");
  const out = await fn({ page, r, domText });
  await page.close();
  return out;
}

// --- techniques -------------------------------------------------------------------
const TECHNIQUES = [];
function add(id, category, fn) {
  TECHNIQUES.push({ id, category, fn });
}

const U = `${SERVER}/demo/redteam_unicode.html`;
add("zw-split-email", "unicode", async () => run(U, ({ domText }) => ({
  leaked: domText.includes("priya.sharma@example.com"),
  detail: "zero-width chars spliced into an email",
})));
add("zw-split-phone", "unicode", async () => run(U, ({ domText }) => ({
  leaked: domText.includes("9876543210"),
  detail: "zero-width chars spliced into a phone number",
})));
add("homoglyph-email", "unicode", async () => run(U, ({ domText }) => ({
  // the on-page string itself (Cyrillic lookalikes) must not survive verbatim either
  leaked: domText.includes("rohan.mehtа@exаmple.cοm") || domText.includes("rohan.mehta@example.com"),
  detail: "Cyrillic homoglyphs substituted for Latin letters in an email",
})));
add("fullwidth-email", "unicode", async () => run(U, ({ domText }) => ({
  leaked: domText.includes("ａｍｉｔ．ｒａｏ＠ｔｅｓｔ．ｉｏ") || domText.includes("amit.rao@test.io"),
  detail: "fullwidth Unicode forms spelling out an email",
})));
add("rtl-reversed-cc", "unicode", async () => run(U, ({ domText }) => ({
  leaked: domText.replace(/[‪-‮⁦-⁩]/g, "").includes("1111111111111114") || domText.includes("4111111111111111"),
  detail: "RTL override reversing a Luhn-valid card number's stored digit order",
})));

const C = `${SERVER}/demo/redteam_css.html`;
add("css-before-content", "css-dom", async () => run(C, async ({ page, r }) => {
  const rect = await rectOf(page, "#before-pii");
  const cov = rect ? coverageOf(rect, r.boxes || [], r.viewport.w, r.viewport.h) : 1;
  return { leaked: !rect || cov < 0.8, detail: `::before generated-content PII, pixel coverage=${cov.toFixed(2)}` };
}));
add("css-after-content", "css-dom", async () => run(C, async ({ page, r }) => {
  const rect = await rectOf(page, "#after-pii");
  const cov = rect ? coverageOf(rect, r.boxes || [], r.viewport.w, r.viewport.h) : 1;
  return { leaked: !rect || cov < 0.8, detail: `::after generated-content PII, pixel coverage=${cov.toFixed(2)}` };
}));
add("aria-label-sole-source", "css-dom", async () => run(C, ({ domText }) => ({
  leaked: domText.includes("AAAPL1234C"),
  detail: "aria-label is the ONLY accessible text on the element — must still be redacted",
})));
add("aria-label-with-visible-text", "css-dom", async () => run(C, ({ domText }) => ({
  leaked: domText.includes("Priya Sharma"),
  detail: "aria-label carries PII alongside unrelated real visible text — must never surface",
})));
add("title-attribute", "css-dom", async () => run(C, ({ domText }) => ({
  leaked: domText.includes("123-45-6789"),
  detail: "title attribute (tooltip) carries PII alongside unrelated visible text",
})));
add("delayed-mutation", "css-dom", async () => {
  const page = await openPage(browser, C);
  await new Promise((r) => setTimeout(r, 1500)); // let the 1200ms mutation land
  const tabId = await tabIdFor(ctl, C);
  const r = await preview(ctl, tabId, "balanced");
  const domText = (r.sanitizedDom || []).map((n) => n.text).join(" | ");
  await page.close();
  return { leaked: domText.includes("Vikram Singh") || domText.includes("vikram.singh@okhdfcbank"), detail: "PII added to the DOM 1200ms after load, scanned on a later step" };
});

const E = `${SERVER}/demo/redteam_encoding.html`;
add("base64-email", "encoding", async () => run(E, ({ domText }) => ({
  leaked: domText.includes("meera.iyer@example.com") || domText.includes("bWVlcmEuaXllckBleGFtcGxlLmNvbQ=="),
  detail: "base64-encoded email as visible page text",
})));
add("hex-phone", "encoding", async () => run(E, ({ domText }) => ({
  leaked: domText.includes("9876543210") || domText.includes("39383736353433323130"),
  detail: "hex-encoded phone number as visible page text",
})));

// Reconstruction check: pairwise concatenate every two ADJACENT sanitizedDom nodes'
// text with NO separator (that's the actual risk — an agent reading node i then
// node i+1 back to back, not this script's own " | " debug joiner, which would
// mask a real reconstruction bug by accident) and look for the full secret.
function anyAdjacentPairContains(nodes, secret) {
  const texts = (nodes || []).map((n) => (n.text || "").replace(/\s+/g, ""));
  for (let i = 0; i < texts.length - 1; i++) {
    if ((texts[i] + texts[i + 1]).includes(secret)) return true;
  }
  return false;
}

const M = `${SERVER}/demo/redteam_correlation.html`;
add("split-phone-table", "correlation", async () => run(M, ({ r }) => ({
  leaked: anyAdjacentPairContains(r.sanitizedDom, "9876543210"),
  detail: "phone split 98765|43210 across adjacent table cells — checked via raw adjacent-node concatenation, not this script's own debug joiner",
})));
add("split-email-divs", "correlation", async () => run(M, ({ r }) => ({
  leaked: anyAdjacentPairContains(r.sanitizedDom, "kavya.nair@example.org"),
  detail: "email split kavya.nair|@example.org across adjacent divs — checked via raw adjacent-node concatenation",
})));

const V = `${SERVER}/demo/redteam_canvas.html`;
add("canvas-filltext", "canvas-svg", async () => run(V, async ({ r, domText }) => {
  const domLeak = domText.includes("234123412346") || domText.includes("Ananya Gupta");
  // canvas fillText has no DOM text node and no Range API — OCR is the only path
  // that can find it at all. Require it to actually have: (a) minted a real
  // AADHAAR token (proves the OCR'd text round-tripped through the SAME rule
  // engine and passed the Verhoeff checksum, not just "some box exists"), and
  // (b) painted an OCR-sourced pixel box (proves the screenshot channel is
  // covered too, not just the token bookkeeping).
  const ocrBoxes = (r.boxes || []).filter((b) => b.source === "ocr");
  const mintedAadhaar = (r.tokens || []).some((t) => t.type === "AADHAAR");
  return {
    leaked: domLeak || !mintedAadhaar || ocrBoxes.length === 0,
    detail: `canvas fillText PII — DOM channel silent (correct); OCR boxes=${ocrBoxes.length}, AADHAAR token minted=${mintedAadhaar}`,
    ocrBoxes: ocrBoxes.length,
  };
}));
add("svg-text", "canvas-svg", async () => run(V, async ({ page, r, domText }) => {
  // ground truth: pixels of the PAN VALUE substring only (not the "PAN: " label,
  // which is correctly left unredacted — comparing against the whole <text>
  // element would wrongly count that as "missed" coverage).
  const rect = await page.evaluate(() => {
    const t = document.querySelector('svg[data-technique="svg-text"] text');
    const node = t?.firstChild;
    if (!node) return null;
    const i = node.data.indexOf("BXZPK7734F");
    if (i < 0) return null;
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + "BXZPK7734F".length);
    const rects = [...range.getClientRects()];
    if (!rects.length) return null;
    const x0 = Math.min(...rects.map((rc) => rc.x)), y0 = Math.min(...rects.map((rc) => rc.y));
    const x1 = Math.max(...rects.map((rc) => rc.x + rc.width)), y1 = Math.max(...rects.map((rc) => rc.y + rc.height));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
  const cov = rect ? coverageOf(rect, r.boxes || [], r.viewport.w, r.viewport.h) : 0;
  const domCovered = domText.includes("[PAN_") || !domText.includes("BXZPK7734F");
  return {
    leaked: domText.includes("BXZPK7734F") || !rect || cov < 0.8,
    detail: `SVG <text> PII — DOM redacted=${domCovered}, pixel coverage of PAN value=${cov.toFixed(2)}`,
    pixelCoverage: +cov.toFixed(3),
  };
}));

const S = `${SERVER}/demo/redteam_shadowdom.html`;
add("shadow-dom-text", "shadow-dom", async () => run(S, async ({ page, r, domText }) => {
  const domLeak = domText.includes("9123456780") || domText.includes("Rohan Mehta");
  // ground truth: pixels of the NAME + PHONE value substrings only, inside the
  // shadow root (not the whole line, which also has non-sensitive label words).
  const rects = await page.evaluate(() => {
    const host = document.getElementById("host");
    const p = host?.shadowRoot?.querySelector("p");
    const node = p?.firstChild;
    if (!node) return null;
    const rectFor = (needle) => {
      const i = node.data.indexOf(needle);
      if (i < 0) return null;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + needle.length);
      const rc = [...range.getClientRects()];
      if (!rc.length) return null;
      const x0 = Math.min(...rc.map((r) => r.x)), y0 = Math.min(...rc.map((r) => r.y));
      const x1 = Math.max(...rc.map((r) => r.x + r.width)), y1 = Math.max(...rc.map((r) => r.y + r.height));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    return { name: rectFor("Rohan Mehta"), phone: rectFor("9123456780") };
  });
  const covOf = (rect) => (rect ? coverageOf(rect, r.boxes || [], r.viewport.w, r.viewport.h) : null);
  const nameCov = covOf(rects?.name);
  const phoneCov = covOf(rects?.phone);
  const found = !!(rects?.name || rects?.phone);
  const cov = Math.min(nameCov ?? 1, phoneCov ?? 1);
  return {
    leaked: domLeak || !found || cov < 0.8,
    detail: `open shadow-root text — DOM channel leak=${domLeak}, pixel coverage name=${nameCov?.toFixed(2) ?? "n/a"} phone=${phoneCov?.toFixed(2) ?? "n/a"}`,
    pixelCoverage: found ? +cov.toFixed(3) : null,
  };
}));

// --- run ----------------------------------------------------------------------------
const results = [];
for (const t of TECHNIQUES) {
  let out;
  try {
    out = await t.fn();
  } catch (e) {
    out = { leaked: true, detail: `ERROR: ${e?.message || e}`, error: true };
  }
  results.push({ id: t.id, category: t.category, ...out });
  console.log(`  ${out.leaked ? "LEAK " : "OK   "} [${t.category}] ${t.id} — ${out.detail}`);
}

// --- network-boundary confirmation ---------------------------------------------------
// Everything above proves what PRIVACY_PREVIEW returns — the exact payload the
// background worker would fetch() to the server (same proof B1/B2/D1 already rely
// on). This closes the loop with a REAL RUN_TASK against every fixture and reads
// back what the server's own audit log (AUDIT_LOG=1, /agent/last-received) says it
// received, the same "server view" custom_terms_eval.mjs uses for its site-policy
// check — belt-and-suspenders against a bug that's specific to the fetch() path
// rather than the PRIVACY_PREVIEW code path.
const ALL_SECRETS = [
  "priya.sharma@example.com", "9876543210", "rohan.mehta@example.com", "amit.rao@test.io",
  "4111111111111111", "234123412346", "9876543210", "AAAPL1234C", "Priya Sharma", "123-45-6789",
  "Vikram Singh", "vikram.singh@okhdfcbank", "meera.iyer@example.com", "kavya.nair@example.org",
  "BXZPK7734F", "Ananya Gupta", "Rohan Mehta", "9123456780",
];
const FIXTURES = [U, C, E, M, V, S];
let networkFixes = 0;
let networkTotal = 0;
for (const url of FIXTURES) {
  networkTotal++;
  const page = await openPage(browser, url);
  const before = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
  await ctl.evaluate(
    (prompt, serverUrl) => chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl, localOnly: false, multiAgentEnabled: false, maxIterations: 1 } }),
    "Summarise this page.",
    `${SERVER}/agent/step`,
  ).catch(() => {});
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const state = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state).catch(() => null);
    if (state && ["DONE", "ERROR", "IDLE"].includes(state.status)) break;
  }
  const after = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
  const newEntries = after.slice(before.length);
  const serverText = JSON.stringify(newEntries);
  const found = ALL_SECRETS.filter((s) => serverText.includes(s));
  if (found.length === 0) networkFixes++;
  console.log(`  ${found.length === 0 ? "OK   " : "LEAK "} [network] ${url.split("/").pop()} — ${newEntries.length} audited request(s)${found.length ? `, LEAKED: ${found.join(", ")}` : ", 0 secrets in server-received payload"}`);
  await page.close();
}
results.push({
  id: "network-boundary-run-task",
  category: "network",
  leaked: networkFixes !== networkTotal,
  detail: `${networkFixes}/${networkTotal} fixtures produced 0 secrets in /agent/last-received across a real RUN_TASK`,
});

await browser.close();

const leaks = results.filter((r) => r.leaked);
const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: results.length - leaks.length,
  leaked: leaks.length,
  byCategory: Object.fromEntries(
    [...new Set(results.map((r) => r.category))].map((c) => {
      const inCat = results.filter((r) => r.category === c);
      return [c, { total: inCat.length, leaked: inCat.filter((r) => r.leaked).length }];
    }),
  ),
  results,
};

await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/redteam.json", JSON.stringify(summary, null, 2));

console.log(`\nRed-team leak suite: ${summary.passed}/${summary.total} techniques blocked, ${summary.leaked} leaked.`);
if (summary.leaked > 0) {
  console.error(`FAIL: ${summary.leaked} technique(s) leaked real PII.`);
  process.exitCode = 1;
} else {
  console.log("PASS: 0/%d techniques leaked.", summary.total);
}
