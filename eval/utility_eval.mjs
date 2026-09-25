// C2 — privacy/utility benchmark: does redaction cost task success?
//
// Three arms per task, same prompt + same sanitized DOM (text stays tokenised in
// ALL THREE — this system's guarantee that raw values never reach the server
// doesn't get suspended for a benchmark):
//   redacted   — production default: redacted screenshot attached
//   dom        — no screenshot at all (sendScreenshot: false)
//   raw-image  — the UNREDACTED screenshot attached instead of the redacted one
//
// "raw-image" isolates exactly the question C2 asks — does blacking out the
// image cost the model anything — without ever sending a raw DOM/text payload:
// building a parallel path that sends real PII as plain text to prove a point
// about screenshots is the one thing this whole project exists to prevent, so
// this harness never constructs that request. sanitizedDom/tokens come from the
// SAME on-device pipeline in every arm (via the real extension's PRIVACY_PREVIEW);
// only the raw screenshot bytes are captured directly (Puppeteer page.screenshot),
// entirely outside the extension, for this one, clearly-scoped ablation.
//
// Each probe is a single decide_step call (not a full multi-step run — see
// docs/README) — this measures decision quality (did the model pick the right
// element/answer) and latency/bytes per arm, which is what "does redaction cost
// utility" actually turns on.
//
//   node eval/utility_eval.mjs   (server must be running, any real provider)

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// PAGES_SERVER hosts the demo pages (any running instance); API_SERVER is where
// /agent/step is called — MUST be a provider that actually looks at images
// (provider: "vlm") or the redacted/dom/raw-image arms are indistinguishable by
// construction (a text-only provider never reads redactedScreenshot at all).
const SERVER = process.env.PAGES_SERVER || process.env.SERVER || "http://localhost:8000";
const API_SERVER = process.env.API_SERVER || SERVER;
const ARMS = ["redacted", "dom", "raw-image"];

const TASKS = [
  {
    name: "register-fill-name",
    url: `${SERVER}/demo/register.html`,
    prompt: "Register me for the Space Science Outreach event. My name is Priya Sharma, email priya.sharma@gmail.com, phone 9876543210, I live in Ahmedabad. Category Student, institution Gujarat University. Tick the consent box and submit.",
    judge: (resp, dom) => {
      if (resp.status !== "action" || resp.action?.type !== "type") return false;
      const node = dom.find((n) => n.id === resp.action.targetId);
      return /name/i.test(node?.text || "");
    },
  },
  {
    name: "kyc-set-occupation",
    url: `${SERVER}/demo/kyc.html`,
    prompt: "Update my KYC: set occupation to Salaried and annual income to 10-25 lakh, then submit.",
    judge: (resp, dom) => {
      if (resp.status !== "action") return false;
      if (resp.action?.type === "select") {
        const node = dom.find((n) => n.id === resp.action.targetId);
        return /occupation/i.test(node?.text || "") || /salaried/i.test(resp.action.value || "");
      }
      return resp.action?.type === "click" || resp.action?.type === "type";
    },
  },
  {
    name: "checkout-order-total",
    url: `${SERVER}/demo/checkout.html`,
    prompt: "What is my order total and where is it being delivered?",
    judge: (resp) => resp.status === "done" && /2,?347/.test(resp.answer || ""),
  },
  {
    name: "inbox-find-otp",
    url: `${SERVER}/demo/inbox.html`,
    prompt: "What is the OTP that Bharat Digital Bank sent me?",
    judge: (resp) => resp.status === "done" && /\[OTP_\d+\]|otp/i.test(resp.answer || ""),
  },
  {
    name: "social-summarise",
    url: `${SERVER}/demo/social.html`,
    prompt: "Summarise in two sentences what people are posting about on this feed.",
    judge: (resp) => (resp.status === "done" && (resp.answer || "").length > 40) || resp.status === "action",
  },
];

function buildRequestBody({ prompt, sanitizedDom, tokens, viewport, screen, sendScreenshot, screenshot, currentUrl }) {
  return {
    contractVersion: 1,
    taskId: randomUUID(),
    prompt,
    iteration: 1,
    maxIterations: 10,
    screenState: screen?.state ?? "unknown",
    screenStateConfidence: screen?.confidence ?? 0.5,
    siteConfigId: "generic",
    currentUrl,
    openTabs: [],
    pageMeta: { nodeCount: sanitizedDom.length, loginWall: false, scrollY: 0, scrollMax: 0, title: "", toasts: [] },
    visualContext: { screen, regions: [], facesRedacted: 0, boxCounts: null },
    redactionScheme: { version: 2, tokens: tokens || [] },
    sendScreenshot,
    redactedScreenshot: sendScreenshot ? screenshot : null,
    sanitizedDom,
    accumulatedData: [],
    memoryFacts: [],
    lastActionResult: null,
  };
}

async function callServer(body) {
  const t0 = Date.now();
  const res = await fetch(`${API_SERVER}/agent/step`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const wallMs = Date.now() - t0;
  const json = await res.json();
  return { json, wallMs, bytesSent: JSON.stringify(body).length };
}

const { browser, ctl } = await launch();
const results = [];

for (const t of TASKS) {
  const page = await openPage(browser, t.url);
  await new Promise((r) => setTimeout(r, 400));
  const tabId = await tabIdFor(ctl, t.url);
  const r = await preview(ctl, tabId, "balanced");
  if (!r?.ok) {
    results.push({ task: t.name, error: r?.error ?? "preview failed" });
    await page.close();
    continue;
  }
  const rawScreenshotB64 = (await page.screenshot({ type: "jpeg", quality: 80, encoding: "base64" })).toString();
  const redactedB64 = r.redactedImage ? r.redactedImage.slice(r.redactedImage.indexOf(",") + 1) : null;
  const common = { prompt: t.prompt, sanitizedDom: r.sanitizedDom, tokens: r.tokens, viewport: r.viewport, screen: r.screen, currentUrl: t.url };

  for (const arm of ARMS) {
    const body = buildRequestBody({
      ...common,
      sendScreenshot: arm !== "dom",
      screenshot: arm === "raw-image" ? rawScreenshotB64 : redactedB64,
    });
    let out;
    try {
      const { json, wallMs, bytesSent } = await callServer(body);
      out = { arm, task: t.name, success: !!t.judge(json, r.sanitizedDom), status: json.status, serverMs: json._debug?.serverMs, wallMs, bytesSent, leakCatch: json._debug?.leakCatch?.count ?? 0 };
    } catch (e) {
      out = { arm, task: t.name, success: false, error: String(e.message || e) };
    }
    results.push(out);
    process.stdout.write(`${t.name} [${arm}] -> ${out.success ? "OK" : "miss"}${out.error ? ` (${out.error})` : ""}\n`);
  }
  await page.close();
}
await browser.close();

const byArm = {};
for (const arm of ARMS) {
  const rows = results.filter((r) => r.arm === arm && !r.error);
  const successN = rows.filter((r) => r.success).length;
  byArm[arm] = {
    tasks: rows.length,
    successRate: rows.length ? +(successN / rows.length).toFixed(3) : null,
    medianServerMs: rows.length ? median(rows.map((r) => r.serverMs).filter((x) => x != null)) : null,
    medianBytesSent: rows.length ? median(rows.map((r) => r.bytesSent)) : null,
    totalLeakCatch: rows.reduce((a, r) => a + (r.leakCatch || 0), 0),
  };
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
}

const redactedVsRaw = byArm.redacted?.successRate != null && byArm["raw-image"]?.successRate != null
  ? +((byArm.redacted.successRate - byArm["raw-image"].successRate) * 100).toFixed(1)
  : null;

const summary = {
  generatedAt: new Date().toISOString(),
  note: "Single-step decision-quality probes (does redaction change the model's chosen action/answer), not full multi-step task runs — see file header.",
  arms: byArm,
  redactedVsRawPercentagePoints: redactedVsRaw,
  withinFivePointBar: redactedVsRaw !== null ? Math.abs(redactedVsRaw) <= 5 : null,
  results,
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/utility.json", JSON.stringify(summary, null, 2));
console.log("\n" + JSON.stringify({ arms: byArm, redactedVsRawPercentagePoints: redactedVsRaw }, null, 2));
