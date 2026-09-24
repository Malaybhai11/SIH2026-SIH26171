// Shared Puppeteer harness: launches real Chrome with the built extension (dist/),
// opens pages, and calls the extension's PRIVACY_PREVIEW / RUN_TASK from an extension
// page. Used by eval/redaction_eval.mjs, eval/latency_eval.mjs and eval/screens_eval.mjs.

import puppeteer from "puppeteer-core";
import path from "node:path";
import { existsSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

export async function launch({ headless = true, dist = "dist", width = 1280, height = 800 } = {}) {
  const ext = path.resolve(dist);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: headless ? "new" : false,
    defaultViewport: null,
    // branded Chrome ignores --load-extension since v137; install over CDP instead
    pipe: true,
    enableExtensions: [ext],
    args: [
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
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
