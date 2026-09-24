// Capture the screen-state dataset: screenshot + structural DOM features at the same
// instant, for every URL in eval/screens_urls.mjs. Output: eval/.cache/screens_ds/.
//
//   node eval/screens_capture.mjs [--recapture]

import puppeteer from "puppeteer-core";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { URLS } from "./screens_urls.mjs";
import { domScreenFeatures } from "../extension/lib/screenFeatures.js";

const DIR = "eval/.cache/screens_ds";
const RECAPTURE = process.argv.includes("--recapture");
await mkdir(DIR, { recursive: true });
const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: ["--no-first-run", "--lang=en-US"] });

const jobs = URLS.map(([label, url], i) => ({ i, label, url, f: `${DIR}/${String(i).padStart(3, "0")}` }));
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    if (!RECAPTURE && existsSync(`${j.f}.png`) && existsSync(`${j.f}.json`)) continue;
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36");
      await page.goto(j.url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const feats = await page.evaluate(`(${domScreenFeatures.toString()})()`).catch(() => null);
      await page.screenshot({ path: `${j.f}.png` });
      await writeFile(`${j.f}.json`, JSON.stringify({ label: j.label, url: j.url, finalUrl: page.url(), features: feats }));
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("x");
    } finally {
      await page.close().catch(() => {});
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
await browser.close();
console.log(`\ncaptured ${jobs.length} -> ${DIR}`);
