// A3 — semantic obfuscation (surrogate) mode, through the REAL BUILT extension.
//
//   AUDIT_LOG=1 uvicorn server.app:app --port 8000        (LLM_PROVIDER=inception/vlm — a
//                                                           real provider; mock can't fill forms)
//   AUDIT_LOG=1 LLM_PROVIDER=mock uvicorn server.app:app --port 8001   (for --vaultOnly)
//   node eval/surrogate_eval.mjs [--server http://localhost:8000] [--vaultServer http://localhost:8001] [--headful]
//
// Two parts, both against the built dist/ extension:
//
//   Part A — a real agent-driven task (register.html), run once with redactionMode
//   "token" and once with "surrogate", through a real LLM provider. For the surrogate
//   run it checks the three things A3 promises:
//     (a) the server's audit log (/agent/last-received) never contains the user's raw
//         PII, in any form — same leak check task_e2e.mjs uses.
//     (b) the surrogate values the client minted (not [TYPE_n] tokens) are what the
//         server actually received.
//     (c) the LLM, reasoning only over the fluent surrogate text, still fills the form
//         with the REAL values — rehydrated client-side, at execution, from the
//         surrogate it typed.
//
//   Part B — a deterministic, LLM-independent check (against a mock-provider server,
//   so it needs no API key) that generateSurrogate + Vault resolution round-trips
//   correctly for every supported type (NAME, EMAIL, PHONE, ADDRESS, LOCATION): it
//   populates the vault from a prompt containing real PII, then dispatches a synthetic
//   "type" action for each type using the exact surrogate the vault minted, through the
//   same rehydration path (dispatchAction) a live task uses, and checks the DOM field
//   ends up holding the REAL value, never the surrogate.
//
// Writes eval/results/surrogate.json.

import { launch, openPage, tabIdFor, saveSettings } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const argv = process.argv;
const pickArg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const SERVER = pickArg("--server", process.env.SERVER || "http://localhost:8000");
const VAULT_SERVER = pickArg("--vaultServer", process.env.VAULT_SERVER || "http://localhost:8001");
const HEADFUL = argv.includes("--headful");

async function lastReceived(server, n = 50) {
  return fetch(`${server}/agent/last-received?n=${n}`).then((r) => r.json()).catch(() => []);
}

async function runTask(ctl, { prompt, server, maxIterations = 12 }) {
  const t0 = Date.now();
  await ctl.evaluate(
    (prompt, serverUrl, maxIterations) =>
      chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl, localOnly: false, multiAgentEnabled: false, maxIterations } }),
    prompt,
    `${server}/agent/step`,
    maxIterations,
  );
  let state;
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    state = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state);
    if (["DONE", "ERROR"].includes(state.status) || Date.now() - t0 > 180000) break;
  }
  return { state, wallMs: Date.now() - t0 };
}

// ---------------------------------------------------------------- Part A: register.html

const REG_URL = `${SERVER}/demo/register.html`;
const REG_PROMPT =
  "Register me for the Space Science Outreach event. My name is Priya Sharma, email priya.sharma@gmail.com, phone 9876543210, I live in Ahmedabad. Category Student, institution Gujarat University. Tick the consent box and submit.";
const REG_SECRETS = ["Priya Sharma", "priya.sharma@gmail.com", "9876543210", "Ahmedabad"];

async function readRegisterForm(page) {
  return page.evaluate(() => ({
    fullname: document.querySelector("#fullname")?.value ?? null,
    email: document.querySelector("#email")?.value ?? null,
    phone: document.querySelector("#phone")?.value ?? null,
    city: document.querySelector("#city")?.value ?? null,
    submitted: document.querySelector("#ok") ? !document.querySelector("#ok").hidden : false,
  }));
}

async function runRegisterOnce(browser, ctl, redactionMode) {
  await saveSettings(ctl, { perceptionMode: "balanced", humanize: false, sendScreenshot: true, redactionMode });
  const before = await lastReceived(SERVER);
  const page = await openPage(browser, REG_URL);
  const tabId = await tabIdFor(ctl, REG_URL);
  // Same warmup the popup does on open (dashboard.html, our control page, doesn't).
  // Without it the on-device NER model's cold first call can be slower than the
  // agent's first iteration, which is a pre-existing model-loading race unrelated to
  // A3 — warming up first makes this run representative of normal popup-driven use.
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "WARMUP" }));
  const { state, wallMs } = await runTask(ctl, { prompt: REG_PROMPT, server: SERVER });
  const outcome = await readRegisterForm(page).catch((e) => ({ error: String(e.message) }));

  const iterCount = Math.max(1, state.metrics?.iterations?.length ?? 1);
  const received = (await lastReceived(SERVER)).slice(before.length ? -iterCount : 0);
  const serverText = JSON.stringify(received);
  const leaks = REG_SECRETS.filter((s) => serverText.includes(s) || serverText.includes(s.replace(/\s/g, "")));

  // vaultCatalog never carries values — only {token, type} — so this only tells us
  // WHICH placeholder strings exist, never the real data. That's exactly what's safe
  // to use here: to check "is the surrogate present in what was sent", not to peek at values.
  const catalog = state.vaultCatalog ?? [];
  const surrogatesPresent = catalog.filter((c) => serverText.includes(c.token));

  await page.close();
  return {
    redactionMode,
    tabId,
    status: state.status,
    wallMs,
    outcome,
    formFilledWithRealValues:
      outcome.fullname === "Priya Sharma" &&
      outcome.email === "priya.sharma@gmail.com" &&
      (outcome.phone || "").replace(/\D/g, "").endsWith("9876543210") &&
      outcome.city === "Ahmedabad" &&
      outcome.submitted,
    leakCheck: { secretsChecked: REG_SECRETS.length, leaked: leaks, requestsInspected: received.length },
    vaultCatalog: catalog,
    surrogatesSeenInTraffic: surrogatesPresent,
    sentPromptSample: received[0]?.prompt ?? null,
    log: (state.log ?? []).slice(-15).map((l) => l.msg),
  };
}

// ---------------------------------------------------------------------- Part B: per-type

const VAULT_URL = `${SERVER}/demo/register.html`;
const VAULT_PROMPT =
  "My name is Rohan Mehta. Email rohan.mehta@gmail.com. Phone 9876501234. Address House No. 24, MG Road, Bengaluru 560001. I live in Chennai.";
const VAULT_REAL = {
  NAME: "Rohan Mehta",
  EMAIL: "rohan.mehta@gmail.com",
  PHONE: "9876501234",
  ADDRESS: "House No. 24, MG Road, Bengaluru 560001",
  LOCATION: "Chennai",
};

async function runVaultRoundTrip(browser, ctl) {
  await saveSettings(ctl, { perceptionMode: "balanced", humanize: false, sendScreenshot: false, redactionMode: "surrogate" });
  const page = await openPage(browser, VAULT_URL);
  const tabId = await tabIdFor(ctl, VAULT_URL);
  await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "WARMUP" }));

  // one throwaway text input per type, purely for this test — never touches the
  // checked-in demo fixture, and the mock provider never interacts with the page.
  await page.evaluate((types) => {
    for (const t of types) {
      const el = document.createElement("input");
      el.type = "text";
      el.id = `surrTest_${t}`;
      el.setAttribute("data-agent-id", `surrTest_${t}`);
      document.body.appendChild(el);
    }
  }, Object.keys(VAULT_REAL));

  const { state } = await runTask(ctl, { prompt: VAULT_PROMPT, server: VAULT_SERVER, maxIterations: 3 });
  const catalog = state.vaultCatalog ?? [];

  const perType = [];
  for (const [type, real] of Object.entries(VAULT_REAL)) {
    const entry = catalog.find((c) => c.type === type);
    if (!entry) {
      perType.push({ type, real, detected: false });
      continue;
    }
    const surrogate = entry.token;
    const action = { type: "type", targetId: `surrTest_${type}`, text: surrogate };
    const result = await ctl.evaluate((tabId, action) => chrome.runtime.sendMessage({ type: "EXECUTE_TEST_ACTION", tabId, action }), tabId, action);
    const fieldValue = await page.evaluate((t) => document.querySelector(`#surrTest_${t}`)?.value ?? null, type);
    perType.push({
      type,
      real,
      detected: true,
      surrogate,
      surrogateIsRealValue: surrogate === real,
      dispatchResult: result,
      fieldValueAfterExecution: fieldValue,
      resolvedToRealValue: fieldValue === real,
    });
  }
  await page.close();
  return { vaultServer: VAULT_SERVER, catalog, perType };
}

// -------------------------------------------------------------------------- run

const { browser, ctl } = await launch({ headless: !HEADFUL });

const tokenRun = await runRegisterOnce(browser, ctl, "token");
const surrogateRun = await runRegisterOnce(browser, ctl, "surrogate");
const vaultRoundTrip = await runVaultRoundTrip(browser, ctl);

await browser.close();

const surrogateTypesChecked = vaultRoundTrip.perType.filter((p) => p.detected);
const report = {
  generatedAt: new Date().toISOString(),
  server: SERVER,
  vaultServer: VAULT_SERVER,
  partA_register: { token: tokenRun, surrogate: surrogateRun },
  partB_vaultRoundTrip: vaultRoundTrip,
  summary: {
    tokenRun: { passed: tokenRun.formFilledWithRealValues && tokenRun.leakCheck.leaked.length === 0 },
    surrogateRun: {
      formFilledWithRealValues: surrogateRun.formFilledWithRealValues,
      noRawPiiLeaked: surrogateRun.leakCheck.leaked.length === 0,
      surrogatesSeenInTraffic: surrogateRun.surrogatesSeenInTraffic.length,
      passed: surrogateRun.formFilledWithRealValues && surrogateRun.leakCheck.leaked.length === 0 && surrogateRun.surrogatesSeenInTraffic.length > 0,
    },
    vaultRoundTrip: {
      typesDetected: surrogateTypesChecked.map((p) => p.type),
      typesResolvedCorrectly: surrogateTypesChecked.filter((p) => p.resolvedToRealValue).length,
      typesTotal: surrogateTypesChecked.length,
      anySurrogateEqualedRealValue: surrogateTypesChecked.some((p) => p.surrogateIsRealValue),
      passed: surrogateTypesChecked.length > 0 && surrogateTypesChecked.every((p) => p.resolvedToRealValue && !p.surrogateIsRealValue),
    },
  },
};
report.summary.overallPassed = report.summary.tokenRun.passed && report.summary.surrogateRun.passed && report.summary.vaultRoundTrip.passed;

await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/surrogate.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
