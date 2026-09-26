// Generates synthetic "scanned document" PNGs for the OCR eval (A1) — pixel text
// baked into a raster image via a real browser canvas (not selectable DOM text),
// same as a photographed/scanned ID card or a PDF rendered to canvas would look.
// Ground truth for each fixture is recorded alongside it in fixtures.json.
//
//   node scripts/gen_ocr_fixtures.mjs
//
// Uses only SPECIMEN data: synthetic names + Verhoeff-valid but clearly-fake
// Aadhaar numbers, generated the same way eval/pii_eval.mjs does (never a real ID).

import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { verhoeffValid } from "../extension/lib/redact.js";

const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
// Images live under server/demo/ (already mounted as static /demo by server/app.py)
// so the eval can load them through the real server, same as every other demo page —
// StaticFiles won't serve a path that escapes its mounted directory.
const OUT = "server/demo/img/ocr";
const FIXTURES_JSON = "eval/fixtures/ocr_fixtures.json";

let seed = 42;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
function aadhaar() {
  for (;;) {
    const p = String(2 + Math.floor(rnd() * 8)) + digits(10);
    for (let d = 0; d < 10; d++) if (verhoeffValid(p + d)) return `${(p + d).slice(0, 4)} ${(p + d).slice(4, 8)} ${(p + d).slice(8)}`;
  }
}
const NAMES = ["Rohan Mehta", "Priya Sharma", "Ananya Iyer", "Vikram Singh", "Kavya Nair", "Arjun Patel", "Sunita Rao", "Imran Qureshi", "Deepika Joshi", "Harpreet Kaur"];
const CITIES = ["New Delhi", "Mumbai", "Bengaluru", "Chennai", "Pune", "Ahmedabad", "Jaipur", "Kolkata", "Hyderabad", "Lucknow"];

function specimenCard(name, aad, dob, addr) {
  return `
    <div style="width:640px;height:400px;background:#eef2f7;border:3px solid #1e3a8a;border-radius:10px;
                font-family:Arial,sans-serif;padding:24px;box-sizing:border-box;position:relative;">
      <div style="position:absolute;top:8px;right:14px;font-size:11px;color:#b91c1c;font-weight:bold;
                   transform:rotate(-8deg);border:2px solid #b91c1c;padding:2px 8px;">SPECIMEN</div>
      <div style="font-size:20px;font-weight:bold;color:#1e3a8a;margin-bottom:18px;">GOVERNMENT OF INDIA</div>
      <div style="font-size:16px;margin-bottom:6px;">Name: ${name}</div>
      <div style="font-size:16px;margin-bottom:6px;">DOB: ${dob}</div>
      <div style="font-size:16px;margin-bottom:18px;">Address: ${addr}</div>
      <div style="font-size:26px;letter-spacing:3px;font-weight:bold;color:#111;">${aad}</div>
    </div>`;
}

function canvasReceipt(name, phone, amount) {
  return `
    <canvas id="c" width="500" height="260"></canvas>
    <script>
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,500,260);
      ctx.fillStyle = '#111'; ctx.font = '20px monospace';
      ctx.fillText('PAYMENT RECEIPT', 20, 34);
      ctx.font = '16px monospace';
      ctx.fillText('Paid by: ${name}', 20, 80);
      ctx.fillText('Phone: ${phone}', 20, 110);
      ctx.fillText('Amount: Rs ${amount}', 20, 140);
      ctx.fillText('Status: SUCCESS', 20, 170);
    </script>`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir("eval/fixtures/ocr", { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const fixtures = [];

  for (let i = 0; i < 12; i++) {
    const name = NAMES[i % NAMES.length];
    const aad = aadhaar();
    const dob = `${1 + Math.floor(rnd() * 27)}/0${1 + Math.floor(rnd() * 9)}/19${70 + Math.floor(rnd() * 29)}`;
    const addr = `${1 + Math.floor(rnd() * 200)} MG Road, ${CITIES[i % CITIES.length]}`;
    await page.setViewport({ width: 700, height: 450 });
    await page.setContent(`<body style="margin:0">${specimenCard(name, aad, dob, addr)}</body>`);
    const file = `${OUT}/id_card_${i + 1}.png`;
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 660, height: 420 } });
    await writeFile(`${OUT}/id_card_${i + 1}.html`, `<!doctype html><body style="margin:0"><img src="id_card_${i + 1}.png"></body>`);
    fixtures.push({ url: `/demo/img/ocr/id_card_${i + 1}.html`, kind: "id_card", gold: [{ type: "NAME", value: name }, { type: "AADHAAR", value: aad }] });
  }

  for (let i = 0; i < 8; i++) {
    const name = NAMES[(i + 3) % NAMES.length];
    const phone = `9${digits(9)}`;
    const amount = String(100 + Math.floor(rnd() * 9900));
    await page.setViewport({ width: 520, height: 280 });
    await page.setContent(`<body style="margin:0">${canvasReceipt(name, phone, amount)}</body>`);
    await new Promise((r) => setTimeout(r, 100));
    const file = `${OUT}/receipt_${i + 1}.png`;
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 500, height: 260 } });
    await writeFile(`${OUT}/receipt_${i + 1}.html`, `<!doctype html><body style="margin:0"><img src="receipt_${i + 1}.png"></body>`);
    fixtures.push({ url: `/demo/img/ocr/receipt_${i + 1}.html`, kind: "canvas_receipt", gold: [{ type: "NAME", value: name }, { type: "PHONE", value: phone }] });
  }

  await writeFile(FIXTURES_JSON, JSON.stringify(fixtures, null, 2));
  console.log(`wrote ${fixtures.length} fixtures to ${OUT}/ (manifest: ${FIXTURES_JSON})`);
  await browser.close();
}

main();
