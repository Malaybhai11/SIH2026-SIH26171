// Shared Puppeteer harness: launches real Chrome with the built extension (dist/),
// opens pages, and calls the extension's PRIVACY_PREVIEW / RUN_TASK from an extension
// page. Used by eval/redaction_eval.mjs, eval/latency_eval.mjs and eval/screens_eval.mjs.

import puppeteer from "puppeteer-core";
import path from "node:path";
import { existsSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

export async function launch({ headless = true, dist = "dist", width = 1280, height = 800 } = {}) {
  const ext = path.resolve(dist);
  // Chrome doesn't read HTTPS_PROXY from the environment (unlike curl/node/etc) —
  // this sandbox's outbound HTTPS only works through the agent proxy, so a real
  // external site (e.g. eval/benchmark30_eval.mjs's unseen-site tasks) needs this
  // passed explicitly, or every navigation fails with chrome-error://chromewebdata.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: headless ? "new" : false,
    defaultViewport: null,
    pipe: true,
    args: [
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      // Chrome refuses its setuid sandbox when launched as root (CI containers,
      // this eval environment); containerised eval runners are typically root,
      // where the container itself is the isolation boundary instead.
      ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
      "--disable-dev-shm-usage",
      // Google-branded Chrome ignores --load-extension since v137 (CDP
      // Extensions.loadUnpacked would be the replacement, but that CDP domain
      // isn't present on a plain open-source Chromium build) — this repo's
      // pre-installed browser IS plain Chromium, where --load-extension still
      // works in the new headless mode.
      `--load-extension=${ext}`,
      `--disable-extensions-except=${ext}`,
      ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=localhost,127.0.0.1,::1,<local>"] : []),
      // Cut Chrome's own background chatter (safe-browsing pings, component
      // update checks, captive-portal probes) — plain-HTTP requests the agent
      // proxy rejects outright (CONNECT/HTTPS only), and noise unrelated to
      // whatever page this harness is actually testing.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
    ],
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  // an extension page to talk to the background from
  const ctl = await browser.newPage();
  // dashboard (not popup): the popup warms every model on open, which would skew eco-mode numbers
  await ctl.goto(`chrome-extension://${extId}/dashboard.html`);
  return { browser, extId, ctl };
}

export async function openPage(browser, url, { width = 1280, height = 800 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

/** Find the chrome tab id of a page (by URL) from the extension page. */
export async function tabIdFor(ctl, url) {
  return ctl.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u) || tabs.find((x) => x.url?.startsWith(u.split("#")[0]));
    return t?.id ?? null;
  }, url);
}

export async function preview(ctl, tabId, mode) {
  return ctl.evaluate(
    (tabId, mode) => chrome.runtime.sendMessage({ type: "PRIVACY_PREVIEW", payload: { tabId, mode } }),
    tabId,
    mode,
  );
}

export async function saveSettings(ctl, settings) {
  return ctl.evaluate((s) => chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: s }), settings);
}
