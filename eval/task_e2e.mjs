// End-to-end task runs through the REAL extension + server, with a privacy assertion:
// the server's own audit log must not contain any of the user's raw values.
//
//   AUDIT_LOG=1 uvicorn server.app:app --port 8000     (any provider; mock can't fill forms)
//   node eval/task_e2e.mjs [--task register|inbox|kyc|social|checkout] [--headful]
//
// Writes eval/results/e2e_<task>.json with per-step latency, outcome checks and leak check.

import { launch, openPage, tabIdFor, saveSettings } from "./e2e_harness.mjs";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const argv = process.argv;
const pickArg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const which = pickArg("--task", "register");
const SERVER = process.env.SERVER || "http://localhost:8000";

const TASKS = {
  register: {
    url: `${SERVER}/demo/register.html`,
    prompt:
      "Register me for the Space Science Outreach event. My name is Priya Sharma, email priya.sharma@gmail.com, phone 9876543210, I live in Ahmedabad. Category Student, institution Gujarat University. Tick the consent box and submit.",
    secrets: ["Priya Sharma", "priya.sharma@gmail.com", "9876543210", "Ahmedabad"],
    check: (page) =>
      page.evaluate(() => ({
        fullname: document.querySelector("#fullname").value,
        email: document.querySelector("#email").value,
        phone: document.querySelector("#phone").value,
        city: document.querySelector("#city").value,
        category: document.querySelector("#cat").value,
        consent: document.querySelector("#consent").checked,
        submitted: !document.querySelector("#ok").hidden,
      })),
    pass: (r) => !!r && r.fullname === "Priya Sharma" && r.email === "priya.sharma@gmail.com" && r.phone.replace(/\D/g, "").endsWith("9876543210") && r.submitted,
  },
  inbox: {
    url: `${SERVER}/demo/inbox.html`,
    prompt: "What is the OTP that Bharat Digital Bank sent me?",
    secrets: ["482913", "Rohan Mehta", "Kavya Nair", "kavya.nair@okicici", "+91 98450 12345", "ananya.iyer@dakmail.in"],
    pass: (r, st) => /482913/.test(st.answer || ""),
  },
  kyc: {
    url: `${SERVER}/demo/kyc.html`,
    prompt: "Update my KYC: set occupation to Salaried and annual income to 10–25 lakh, then submit.",
    secrets: ["Ananya Iyer", "2345 6789 0124", "ABCPI1234K", "98765 43210", "ananya.iyer@dakmail.in", "50100234567812", "Hunter2!2026", "551920"],
    check: (page) => page.evaluate(() => ({ occ: document.querySelector("#occ").value, inc: document.querySelector("#inc").value, done: !document.querySelector("#done").hidden })),
    pass: (r) => !!r && r.occ === "Salaried" && /10/.test(r.inc) && r.done,
  },
  social: {
    url: `${SERVER}/demo/social.html`,
    prompt: "Summarise in two sentences what people are posting about on this feed.",
    secrets: ["Vikram Singh", "Kavya Nair", "Imran Qureshi", "Rohan Mehta", "98290 55123", "jobs@quantumleaf.in"],
    pass: (r, st) => (st.answer || "").length > 40,
  },
  checkout: {
    url: `${SERVER}/demo/checkout.html`,
    prompt: "What is my order total and where is it being delivered?",
    // CVV/expiry are short: check them in field context, not as bare substrings
    secrets: ["4111 1111 1111 1111", "Rohan Mehta", "House No. 12", "+91 98111 22334", 'CVV | value: \\"123', "12/28"],
    pass: (r, st) => /2,?347/.test(st.answer || ""),
  },
};

const T = TASKS[which];
const auditBefore = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
const { browser, ctl } = await launch({ headless: !argv.includes("--headful") });
await saveSettings(ctl, { perceptionMode: "balanced", humanize: false, sendScreenshot: true });
const page = await openPage(browser, T.url);
const tabId = await tabIdFor(ctl, T.url);

const t0 = Date.now();
await ctl.evaluate(
  (prompt) => chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl: "http://localhost:8000/agent/step", localOnly: false, multiAgentEnabled: false, maxIterations: 12 } }),
  T.prompt,
);
// RUN_TASK acts on the active tab of the last-focused window: make sure it's ours
let state;
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  state = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state);
  if (["DONE", "ERROR"].includes(state.status) || Date.now() - t0 > 240000) break;
}
const wallMs = Date.now() - t0;
const outcome = T.check ? await T.check(page).catch((e) => ({ error: String(e.message), url: page.url() })) : null;

// privacy: scan everything the server logged for this run
const received = (await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json())).slice(auditBefore.length ? -Math.max(1, (state.metrics?.iterations?.length ?? 1)) : 0);
const serverText = JSON.stringify(received);
const leaks = T.secrets.filter((s) => serverText.includes(s) || serverText.includes(s.replace(/\s/g, "")));

const report = {
  task: which,
  prompt: T.prompt,
  status: state.status,
  answer: state.answer,
  error: state.error,
  passed: !!T.pass(outcome, state) && leaks.length === 0,
  outcome,
  wallMs,
  steps: state.metrics?.iterations ?? [],
  serverSaw: { prompt: received[0]?.prompt, tokens: received.at(-1)?.redactionScheme?.tokens, visualContext: received.at(-1)?.visualContext },
  leakCheck: { secretsChecked: T.secrets.length, leaked: leaks, requestsInspected: received.length },
  privacy: state.privacy,
  engine: state.engineStats,
  log: state.log.slice(-25).map((l) => l.msg),
};
await mkdir("eval/results", { recursive: true });
await writeFile(`eval/results/e2e_${which}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ task: which, status: report.status, passed: report.passed, wallMs, steps: report.steps.length, answer: report.answer, outcome, leaks, serverPrompt: report.serverSaw.prompt }, null, 2));
console.log(report.log.join("\n"));
await browser.close();
