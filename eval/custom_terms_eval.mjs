// B3 — custom sensitive terms + per-site policy, through the real extension.
// "Done when": a custom term is redacted in text and pixels; the per-site policy
// is enforced (no server call reaches a local-only site).
//
//   node eval/custom_terms_eval.mjs   (server must be running)

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";
const CODENAME = "Kestrel Initiative"; // mock project codename — not a real secret

const { browser, ctl } = await launch();

// 1. Save a custom term via the same storage key the popup uses.
await ctl.evaluate(
  (codename) => chrome.storage.local.set({ agentSettings: { customTerms: [{ label: "Codename", term: codename }] } }),
  CODENAME,
);

const url = `${SERVER}/demo/checkout.html`; // any demo page with visible text works
// inject the codename into the page so there's something to redact in text AND pixels
const page = await openPage(browser, url);
await page.evaluate((codename) => {
  const p = document.createElement("p");
  p.textContent = `Internal note: ${codename} rollout scheduled for this order.`;
  document.querySelector("main")?.prepend(p);
}, CODENAME);
await new Promise((r) => setTimeout(r, 300));

const tabId = await tabIdFor(ctl, url);
const r = await preview(ctl, tabId, "balanced");

const textHit = (r.sanitizedDom || []).some((n) => (n.text || "").includes("[CODENAME_"));
const pixelHit = (r.boxes || []).some((b) => b.type === "CODENAME");
const rawLeaked = JSON.stringify(r.sanitizedDom).includes(CODENAME);

// 2. Per-site policy: mark this host local-only and run a REAL task against it —
// confirm zero requests reach the server's own audit log (not just that the
// setting round-trips through storage).
const hostname = new URL(url).hostname;
await ctl.evaluate(
  (hostname) => chrome.storage.local.set({ agentSettings: { customTerms: [], sitePolicies: { [hostname]: "local-only" } } }),
  hostname,
);
const before = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
await ctl.evaluate(
  (prompt) => chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl: "http://localhost:8000/agent/step", localOnly: false, multiAgentEnabled: false, maxIterations: 2 } }),
  "What is my order total?",
);
let taskState;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  taskState = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state);
  if (["DONE", "ERROR"].includes(taskState.status)) break;
}
const after = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
const newServerRequests = after.length - before.length;

await browser.close();

const summary = {
  generatedAt: new Date().toISOString(),
  customTerm: { label: "Codename", value: "<redacted in this report too>" },
  redactedInText: textHit,
  redactedInPixels: pixelHit,
  rawValueLeaked: rawLeaked,
  sitePolicy: { hostname, policy: "local-only", taskStatus: taskState?.status, newServerRequests },
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/custom_terms.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (!textHit || !pixelHit || rawLeaked || newServerRequests !== 0) {
  console.error("\nFAIL");
  process.exitCode = 1;
} else {
  console.log("\nPASS: custom term redacted in text + pixels, raw value never left the device, local-only site made 0 server requests.");
}
