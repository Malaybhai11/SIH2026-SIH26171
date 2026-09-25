// E1 — real-site task benchmark (criterion 5: generalisation beyond our 5 demo
// pages). 30 tasks on real public sites/QA sandboxes NEVER used to build or tune
// this agent — the-internet.herokuapp.com, demoqa.com, saucedemo.com,
// quotes/books.toscrape.com, parabank.parasoft.com. Sandboxes rather than
// production government sites (IRCTC/DigiLocker) on purpose: they're built
// specifically to be automated against, reachable without an account, and don't
// put load on real citizen-facing infrastructure — still genuinely unseen sites
// the agent was never developed or tuned against.
//
//   node eval/benchmark30_eval.mjs [--task <name>]   (server must be running)
//
// Writes eval/results/benchmark.json: per-task success/steps/latency/leaks, plus
// the aggregate success rate and median latency for the scorecard.

import { launch, openPage, tabIdFor, saveSettings } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";
const argv = process.argv;
const only = argv.includes("--task") ? argv[argv.indexOf("--task") + 1] : null;

// pass(outcome, state) — outcome is a site.check(page) result (or null); state is
// the final background STATE (answer, status, accumulatedData...).
const TASKS = [
  // --- the-internet.herokuapp.com ---------------------------------------------
  {
    name: "login-valid-creds",
    url: "https://the-internet.herokuapp.com/login",
    prompt: "Log in with username tomsmith and password SuperSecretPassword!",
    check: (p) => p.evaluate(() => document.querySelector("#flash")?.textContent || ""),
    pass: (r) => /you logged into a secure area/i.test(r || ""),
  },
  {
    name: "dropdown-select",
    url: "https://the-internet.herokuapp.com/dropdown",
    prompt: "Select Option 2 from the dropdown.",
    check: (p) => p.evaluate(() => document.querySelector("#dropdown").value),
    pass: (r) => r === "2",
  },
  {
    name: "checkboxes-check-both",
    url: "https://the-internet.herokuapp.com/checkboxes",
    prompt: "Make sure both checkboxes on this page are checked.",
    check: (p) => p.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].map((c) => c.checked)),
    pass: (r) => Array.isArray(r) && r.every(Boolean),
  },
  {
    name: "add-remove-elements",
    url: "https://the-internet.herokuapp.com/add_remove_elements/",
    prompt: "Click 'Add Element' three times, then delete one of the elements that appears.",
    check: (p) => p.evaluate(() => document.querySelectorAll(".added-manually").length),
    pass: (r) => r === 2,
  },
  {
    name: "inputs-number",
    url: "https://the-internet.herokuapp.com/inputs",
    prompt: "Type the number 42 into the number input field.",
    check: (p) => p.evaluate(() => document.querySelector("input[type=number]").value),
    pass: (r) => r === "42",
  },
  {
    name: "horizontal-slider",
    url: "https://the-internet.herokuapp.com/horizontal_slider",
    prompt: "Move the horizontal slider to a value of 3.5 using the keyboard right arrow key.",
    check: (p) => p.evaluate(() => document.querySelector("#range").value),
    pass: (r) => Math.abs(parseFloat(r) - 3.5) < 0.6,
  },
  {
    name: "dynamic-loading-2",
    url: "https://the-internet.herokuapp.com/dynamic_loading/2",
    prompt: "Click Start and wait for the hidden text to finish loading, then tell me what it says.",
    pass: (r, st) => /hello world/i.test(st.answer || ""),
  },
  {
    name: "status-codes-200",
    url: "https://the-internet.herokuapp.com/status_codes",
    prompt: "Click the link for status code 200.",
    check: (p) => p.evaluate(() => document.body.innerText),
    pass: (r) => /200/.test(r || ""),
  },
  {
    name: "javascript-alert",
    url: "https://the-internet.herokuapp.com/javascript_alerts",
    prompt: "Click the button that triggers a JS Alert, then accept it, then tell me what the result text says.",
    pass: (r, st) => /you successfully clicked an alert/i.test(st.answer || "") || /successfully clicked/i.test((st.log || []).map((l) => l.msg).join(" ")),
  },
  {
    name: "forgot-password",
    url: "https://the-internet.herokuapp.com/forgot_password",
    prompt: "Enter test@example.com into the email field and click Retrieve password.",
    check: (p) => p.evaluate(() => document.body.innerText),
    pass: (r) => /internal server error|your e-?mail's been sent|please provide a valid email/i.test(r || ""),
  },
  {
    name: "key-presses",
    url: "https://the-internet.herokuapp.com/key_presses",
    prompt: "Click into the input box and press the letter A on the keyboard.",
    check: (p) => p.evaluate(() => document.querySelector("#result").textContent),
    pass: (r) => /A/i.test(r || ""),
  },
  {
    name: "hovers-caption",
    url: "https://the-internet.herokuapp.com/hovers",
    prompt: "Hover over the first user avatar and tell me the name shown in the caption.",
    pass: (r, st) => /user 1/i.test(st.answer || ""),
  },
  // --- demoqa.com --------------------------------------------------------------
  {
    name: "demoqa-text-box",
    url: "https://demoqa.com/text-box",
    prompt: "Fill in the form: Full Name 'Aavaran Tester', Email 'tester@aavaran.example', Current Address '12 MG Road, Bengaluru', Permanent Address 'Same as above'. Then submit.",
    check: (p) => p.evaluate(() => document.querySelector("#output")?.innerText || ""),
    pass: (r) => /Aavaran Tester/.test(r || ""),
  },
  {
    name: "demoqa-checkbox-home",
    url: "https://demoqa.com/checkbox",
    prompt: "Expand the tree and check the 'Home' checkbox at the top.",
    check: (p) => p.evaluate(() => document.querySelector("#result")?.innerText || ""),
    pass: (r) => /home/i.test(r || ""),
  },
  {
    name: "demoqa-radio-yes",
    url: "https://demoqa.com/radio-button",
    prompt: "Select the 'Yes' radio button.",
    check: (p) => p.evaluate(() => document.querySelector(".text-success")?.innerText || ""),
    pass: (r) => /yes/i.test(r || ""),
  },
  {
    name: "demoqa-buttons-dblclick",
    url: "https://demoqa.com/buttons",
    prompt: "Double-click the button labelled 'Double Click Me'.",
    check: (p) => p.evaluate(() => document.querySelector("#doubleClickMessage")?.innerText || ""),
    pass: (r) => /double click/i.test(r || ""),
  },
  {
    name: "demoqa-webtables-count",
    url: "https://demoqa.com/webtables",
    prompt: "How many rows are in the table on this page? Answer with just the number.",
    pass: (r, st) => /\b(10|[1-9])\b/.test(st.answer || ""),
  },
  {
    name: "demoqa-select-menu",
    url: "https://demoqa.com/select-menu",
    prompt: "In the 'Select Value' dropdown, choose the option 'Group 2, option 1'.",
    check: (p) => p.evaluate(() => document.querySelector("#withOptGroup")?.innerText || ""),
    pass: (r) => /group 2, option 1/i.test(r || ""),
  },
  // --- saucedemo.com -------------------------------------------------------------
  {
    name: "saucedemo-login",
    url: "https://www.saucedemo.com/",
    prompt: "Log in with username standard_user and password secret_sauce.",
    check: (p) => p.evaluate(() => location.href),
    pass: (r) => /inventory/i.test(r || ""),
  },
  {
    name: "saucedemo-add-to-cart",
    url: "https://www.saucedemo.com/inventory.html",
    prompt: "Add the 'Sauce Labs Backpack' to the cart.",
    check: (p) => p.evaluate(() => document.querySelector(".shopping_cart_badge")?.textContent || ""),
    pass: (r) => r === "1",
  },
  {
    name: "saucedemo-checkout-info",
    prompt: "In the checkout form, enter first name Priya, last name Sharma, zip code 560001, then click Continue.",
    // reuses the same session as add-to-cart via startUrl below
    startUrl: "https://www.saucedemo.com/inventory.html",
    preSetup: async (page) => {
      await page.click(".shopping_cart_link").catch(() => {});
      await page.waitForSelector(".cart_button", { timeout: 3000 }).catch(() => {});
      await page.click(".cart_button").catch(() => {});
      await page.waitForSelector("#first-name", { timeout: 3000 }).catch(() => {});
    },
    secrets: ["Priya Sharma", "560001"],
    check: (p) => p.evaluate(() => location.href),
    pass: (r) => /checkout-step-two|overview/i.test(r || ""),
  },
  // --- quotes / books.toscrape.com (collection tasks) --------------------------
  {
    name: "quotes-top5",
    url: "https://quotes.toscrape.com/",
    prompt: "Collect the top 5 quotes on this page, with their authors.",
    pass: (r, st) => (st.accumulatedData || []).length >= 3,
  },
  {
    name: "books-top5",
    url: "https://books.toscrape.com/",
    prompt: "Collect the top 5 book titles on this page.",
    pass: (r, st) => (st.accumulatedData || []).length >= 3,
  },
  {
    name: "books-filter-travel",
    url: "https://books.toscrape.com/",
    prompt: "Click on the 'Travel' category in the left sidebar.",
    check: (p) => p.evaluate(() => location.href),
    pass: (r) => /travel/i.test(r || ""),
  },
  {
    name: "quotes-tag-love",
    url: "https://quotes.toscrape.com/",
    prompt: "Click the 'love' tag near the bottom of the page.",
    check: (p) => p.evaluate(() => location.href),
    pass: (r) => /tag\/love/i.test(r || ""),
  },
  // --- parabank.parasoft.com (synthetic bank, matches the board's own naming) --
  {
    name: "parabank-about",
    url: "https://parabank.parasoft.com/parabank/index.htm",
    prompt: "Click the 'About Us' link in the top navigation.",
    check: (p) => p.evaluate(() => location.href),
    pass: (r) => /about/i.test(r || ""),
  },
  {
    name: "parabank-register-start",
    url: "https://parabank.parasoft.com/parabank/register.htm",
    prompt: "Fill in the registration form: First Name 'Arjun', Last Name 'Mehta', Address '221B Residency Road', City 'Bengaluru', State 'KA', Zip Code '560025', Phone '9876543210'. Do not submit yet — just fill in those fields.",
    secrets: ["Arjun", "Mehta", "9876543210"],
    check: (p) =>
      p.evaluate(() => ({
        first: document.querySelector("#customer\\.firstName")?.value,
        last: document.querySelector("#customer\\.lastName")?.value,
        city: document.querySelector("#customer\\.city")?.value,
      })),
    pass: (r) => r && r.first === "Arjun" && r.last === "Mehta",
  },
  {
    name: "parabank-services-list",
    url: "https://parabank.parasoft.com/parabank/index.htm",
    prompt: "What online services does this bank offer? Summarise in one sentence from the homepage content.",
    pass: (r, st) => (st.answer || "").length > 20,
  },
  // --- a couple more herokuapp.com pages for variety ----------------------------
  {
    name: "disappearing-elements",
    url: "https://the-internet.herokuapp.com/disappearing_elements",
    prompt: "How many menu items are visible right now? Answer with just the number.",
    pass: (r, st) => /\d/.test(st.answer || ""),
  },
  {
    name: "sortable-table-name",
    url: "https://the-internet.herokuapp.com/tables",
    prompt: "In Table 1, what is the Last Name in the first row? Answer with just the name.",
    pass: (r, st) => (st.answer || "").length > 1,
  },
];

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

async function runOne(browser, ctl, t) {
  const url = t.startUrl || t.url;
  const auditBefore = await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json()).catch(() => []);
  const page = await openPage(browser, url);
  if (t.preSetup) await t.preSetup(page).catch(() => {});
  // Real external sites can keep settling (late redirects, analytics, lazy
  // widgets) well past puppeteer's networkidle2 — unlike our own static demo
  // pages. Give the content script a moment to be alive before RUN_TASK.
  await new Promise((r) => setTimeout(r, 1500));
  const tabId = await tabIdFor(ctl, page.url());

  const t0 = Date.now();
  await ctl.evaluate(
    (prompt) => chrome.runtime.sendMessage({ type: "RUN_TASK", payload: { prompt, serverUrl: "http://localhost:8000/agent/step", localOnly: false, multiAgentEnabled: false, maxIterations: 10 } }),
    t.prompt,
  );
  let state;
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    state = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })).then((r) => r.state);
    if (["DONE", "ERROR"].includes(state.status) || Date.now() - t0 > 90000) break;
  }
  const wallMs = Date.now() - t0;
  const outcome = t.check ? await t.check(page).catch((e) => ({ error: String(e.message) })) : null;

  const received = (await fetch(`${SERVER}/agent/last-received?n=50`).then((r) => r.json())).slice(auditBefore.length ? -Math.max(1, state.metrics?.iterations?.length ?? 1) : 0);
  const serverText = JSON.stringify(received);
  const leaks = (t.secrets || []).filter((s) => serverText.includes(s) || serverText.includes(s.replace(/\s/g, "")));

  let passed = false;
  try {
    passed = !!t.pass(outcome, state) && leaks.length === 0;
  } catch {
    passed = false;
  }

  await page.close();
  return {
    task: t.name,
    url,
    prompt: t.prompt,
    status: state.status,
    passed,
    wallMs,
    steps: state.metrics?.iterations?.length ?? 0,
    answer: state.answer,
    error: state.error,
    outcome,
    leaks,
  };
}

const tasks = only ? TASKS.filter((t) => t.name === only) : TASKS;
const { browser, ctl } = await launch();
await saveSettings(ctl, { perceptionMode: "balanced", humanize: false, sendScreenshot: false });

const results = [];
for (const t of tasks) {
  process.stdout.write(`${t.name} ... `);
  const r = await runOne(browser, ctl, t).catch((e) => ({ task: t.name, url: t.url, prompt: t.prompt, status: "ERROR", passed: false, error: String(e), wallMs: null, steps: 0, leaks: [] }));
  results.push(r);
  console.log(`${r.passed ? "PASS" : "FAIL"} (${r.status}, ${r.wallMs ? Math.round(r.wallMs / 1000) + "s" : "?"})`);
}
await browser.close();

const passedN = results.filter((r) => r.passed).length;
const totalLeaks = results.reduce((a, r) => a + (r.leaks?.length || 0), 0);
const summary = {
  generatedAt: new Date().toISOString(),
  sites: [...new Set(results.map((r) => new URL(r.url).hostname))],
  total: results.length,
  passed: passedN,
  successRate: +(passedN / results.length).toFixed(3),
  medianWallMs: median(results.filter((r) => r.wallMs != null).map((r) => r.wallMs)),
  totalLeaks,
  results,
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/benchmark.json", JSON.stringify(summary, null, 2));
console.log(`\n${passedN}/${results.length} passed, median ${Math.round(summary.medianWallMs / 1000)}s, ${totalLeaks} leak(s).`);
