// D3 — send-image gate: screenshots should be attached adaptively, not on every
// step. "Done when": images sent on under 40% of steps, with no drop in task
// success vs. always sending (task_e2e.mjs's historical runs, which predate the
// gate and send on 100% of steps whenever sendScreenshot is on).
//
// Runs the 5 demo tasks with sendScreenshot on (the ceiling the gate still
// respects) and needsScreenshot() deciding per-step whether to actually attach
// one. Measures the send rate and confirms tasks still pass at the same rate as
// task_e2e.mjs's individual runs.
//
//   node eval/image_gate_eval.mjs   (server must be running)

import { launch, openPage, tabIdFor, saveSettings } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";

const TASKS = [
  {
    name: "register",
    url: `${SERVER}/demo/register.html`,
    prompt:
      "Register me for the Space Science Outreach event. My name is Priya Sharma, email priya.sharma@gmail.com, phone 9876543210, I live in Ahmedabad. Category Student, institution Gujarat University. Tick the consent box and submit.",
    check: (page) =>
      page.evaluate(() => ({
        fullname: document.querySelector("#fullname")?.value,
        submitted: !document.querySelector("#ok")?.hidden,
      })),
    pass: (r) => !!r && r.fullname === "Priya Sharma" && r.submitted,
  },
  {
    name: "inbox",
    url: `${SERVER}/demo/inbox.html`,
    prompt: "What is the OTP that Bharat Digital Bank sent me?",
    pass: (r, st) => /482913/.test(st.answer || ""),
  },
  {
    name: "kyc",
    url: `${SERVER}/demo/kyc.html`,
    prompt: "Update my KYC: set occupation to Salaried and annual income to 10-25 lakh, then submit.",
    check: (page) => page.evaluate(() => ({ occ: document.querySelector("#occ")?.value, done: !document.querySelector("#done")?.hidden })),
    pass: (r) => !!r && r.occ === "Salaried" && r.done,
  },
  {
    name: "social",
    url: `${SERVER}/demo/social.html`,
    prompt: "Summarise in two sentences what people are posting about on this feed.",
    pass: (r, st) => (st.answer || "").length > 40,
  },
  {
    name: "checkout",
    url: `${SERVER}/demo/checkout.html`,
    prompt: "What is my order total and where is it being delivered?",
    pass: (r, st) => /2,?347/.test(st.answer || ""),
  },
];

async function runOne(browser, ctl, t) {
  const page = await openPage(browser, t.url);
  await tabIdFor(ctl, t.url);
  const t0 = Date.now();
  await ctl.evaluate(
    (prompt) => chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl: "http://localhost:8000/agent/step", localOnly: false, multiAgentEnabled: false, maxIterations: 12 } }),
    t.prompt,
  );
  let state;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state);
    if (["DONE", "ERROR"].includes(state.status) || Date.now() - t0 > 180000) break;
  }
  const wallMs = Date.now() - t0;
  const outcome = t.check ? await t.check(page).catch(() => null) : null;
  let passed = false;
  try {
    passed = !!t.pass(outcome, state);
  } catch {
    passed = false;
  }
  const iters = state.metrics?.iterations ?? [];
  const imageSentN = iters.filter((m) => m.imageSent).length;
  await page.close();
  return {
    task: t.name,
    passed,
    status: state.status,
    wallMs,
    steps: iters.length,
    imageSentN,
    imageSentPct: iters.length ? +((100 * imageSentN) / iters.length).toFixed(1) : null,
    gateReasons: iters.map((m) => m.imageGateReason),
  };
}

const { browser, ctl } = await launch();
await saveSettings(ctl, { perceptionMode: "balanced", humanize: false, sendScreenshot: true });

const results = [];
for (const t of TASKS) {
  process.stdout.write(`${t.name} ... `);
  const r = await runOne(browser, ctl, t).catch((e) => ({ task: t.name, passed: false, error: String(e), steps: 0, imageSentN: 0, imageSentPct: null }));
  results.push(r);
  console.log(`${r.passed ? "PASS" : "FAIL"} (${r.status}, ${r.steps} steps, image ${r.imageSentN}/${r.steps})`);
}
await browser.close();

const totalSteps = results.reduce((a, r) => a + (r.steps || 0), 0);
const totalImages = results.reduce((a, r) => a + (r.imageSentN || 0), 0);
const overallPct = totalSteps ? +((100 * totalImages) / totalSteps).toFixed(1) : null;
const passedN = results.filter((r) => r.passed).length;

const summary = {
  generatedAt: new Date().toISOString(),
  note:
    "sendScreenshot is on (the ceiling) in every run here; needsScreenshot() then decides per-step whether an image is actually attached. " +
    "Compare overallImageSentPct against task_e2e.mjs's pre-D3 behaviour, which sent an image on every single step whenever sendScreenshot was on (100%).",
  overallImageSentPct: overallPct,
  underFortyPercentBar: overallPct !== null ? overallPct < 40 : null,
  tasksPassed: `${passedN}/${results.length}`,
  results,
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/image_gate.json", JSON.stringify(summary, null, 2));
console.log(`\nimages sent on ${overallPct}% of steps across ${totalSteps} steps (vs. 100% pre-gate) · ${passedN}/${results.length} tasks passed`);
if (overallPct !== null && overallPct >= 40) {
  console.error("FAIL: image gate is sending on 40%+ of steps");
  process.exitCode = 1;
}
