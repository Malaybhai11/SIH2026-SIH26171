// Red-team leak suite (E2) — criteria 2 + 3 under adversarial page formatting.
//
//   node eval/redteam_eval.mjs            (server must serve /demo/redteam; any provider)
//
// Each attack page in server/demo/redteam/ tries one real evasion technique against the
// SHIPPED extension (real Chrome, real content script, real perception engine — this is
// not a unit test of redact.js in isolation). Ground truth is `data-pii="TYPE"` on the
// element carrying the value, which the extension never reads.
//
// Two independent checks per PII element, and BOTH must pass — the two channels leak
// independently, and an early version of this script that only checked one channel
// missed a real finding (see svg-text below):
//   pixelCaught — a painted redaction box (text box, face box, or sensitive image
//                 region) covers >= 50% of the element's on-screen bounding box. This
//                 is what a vision model reading the (redacted) screenshot would see.
//   textLeaked  — the element's raw text value appears anywhere in the tokenized DOM
//                 payload the server would receive (sanitizedDom). This is the text
//                 channel, independent of what the screenshot shows.
//
// canvas-bitmap.html is marked data-pii-visual (pixels only, no DOM text at all) and
// scored on pixelCaught alone — it is EXPECTED to fail until on-device OCR (A1) ships;
// this suite exists to make that gap measured, not to hide it.
//
// prompt-injection.html carries `data-pii-injection` elements instead of `data-pii` —
// these are not PII and are reported separately, informationally: whether the hidden
// instruction text reaches the payload verbatim is B2's problem (prompt-injection
// shield), not a redaction pass/fail.

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir, readdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";
const DIR = "server/demo/redteam";
const PAGES = (await readdir(DIR)).filter((f) => f.endsWith(".html") && f !== "index.html").sort();

function rectCovered(rect, boxes) {
  const { x, y, width: w, height: h } = rect;
  if (w <= 0 || h <= 0) return 0;
  const gx0 = x, gy0 = y, gx1 = x + w, gy1 = y + h;
  const area = w * h;
  // sum of intersection areas, clamped (boxes may overlap each other; good enough at this scale)
  let covered = 0;
  for (const b of boxes) {
    const ix = Math.max(0, Math.min(gx1, b.x + b.w) - Math.max(gx0, b.x));
    const iy = Math.max(0, Math.min(gy1, b.y + b.h) - Math.max(gy0, b.y));
    covered += ix * iy;
  }
  return Math.min(1, covered / area);
}

const { browser, ctl } = await launch();
const pages = [];
let injection = null;

for (const file of PAGES) {
  const url = `${SERVER}/demo/redteam/${file}`;
  const page = await openPage(browser, url);
  const tabId = await tabIdFor(ctl, url);
  const r = await preview(ctl, tabId, "balanced");
  if (!r?.ok) {
    pages.push({ page: file, error: r?.error });
    await page.close();
    continue;
  }

  // ground truth, in DEVICE px to match r.boxes/rois (viewport.dpr, same convention
  // background.js's privacyPreview() uses for its own `boxes` field)
  const scale = r.viewport?.dpr || 1;
  const gt = await page.evaluate((scale) => {
    const out = [];
    for (const el of document.querySelectorAll("[data-pii]")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({
        type: el.dataset.pii,
        value: (el.textContent || "").trim(),
        visualOnly: el.hasAttribute("data-pii-visual"),
        adversarial: el.hasAttribute("data-pii-adversarial"),
        rect: { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale },
      });
    }
    return out;
  }, scale);

  const injectionEls = await page.evaluate(() =>
    [...document.querySelectorAll("[data-pii-injection]")].map((el) => (el.textContent || "").trim()),
  );

  const boxes = [
    ...(r.boxes || []).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    ...(r.sensitiveRegions || [])
      .map((id) => (r.rois || []).find((x) => x.id === id))
      .filter(Boolean)
      .map((roi) => ({ x: roi.x * scale, y: roi.y * scale, w: roi.w * scale, h: roi.h * scale })),
  ];
  const payloadText = JSON.stringify(r.sanitizedDom || []);

  const elements = gt.map((g) => {
    const pixelCoverage = +rectCovered(g.rect, boxes).toFixed(2);
    const pixelCaught = pixelCoverage >= 0.5;
    // a value this short (e.g. a 3-digit CVV fragment) can occur by chance in an
    // unrelated token; require it to be reasonably specific before calling it a leak
    const textLeaked = g.value.length >= 4 && payloadText.includes(g.value);
    // visualOnly (canvas bitmap): no DOM text exists to check, pixel coverage is the
    // whole story. Everything else needs BOTH channels clean — text-safe alone isn't
    // enough if the screenshot still shows the raw pixels to a vision model.
    const caught = g.visualOnly ? pixelCaught : pixelCaught && !textLeaked;
    return { type: g.type, value: g.value, visualOnly: g.visualOnly, adversarial: g.adversarial, pixelCoverage, textLeaked, caught };
  });

  if (injectionEls.length) {
    injection = {
      page: file,
      instructions: injectionEls.length,
      reachedPayload: injectionEls.filter((t) => t.length >= 8 && payloadText.includes(t)).length,
      note: "informational — B2 (prompt-injection shield) is not built yet; a hidden instruction reaching the payload is an expected, tracked gap, not a redaction failure",
    };
  }

  pages.push({
    page: file,
    technique: file.replace(".html", "").replace(/-/g, " "),
    elements,
    caught: elements.filter((e) => e.caught).length,
    total: elements.length,
  });
  await page.close();
}
await browser.close();

const scored = pages.filter((p) => !p.error && p.total > 0);
const totalEl = scored.reduce((a, p) => a + p.total, 0);
const totalCaught = scored.reduce((a, p) => a + p.caught, 0);
const report = {
  generatedAt: new Date().toISOString(),
  protocol: "real extension (Puppeteer + Chrome) against 6 PII-evasion pages, ground truth data-pii; caught = raw value absent from the payload sent to the server",
  aggregate: { elements: totalEl, caught: totalCaught, leakRate: +((totalEl - totalCaught) / Math.max(1, totalEl)).toFixed(3) },
  byTechnique: Object.fromEntries(scored.map((p) => [p.technique, { caught: p.caught, total: p.total, leaks: p.elements.filter((e) => !e.caught).map((e) => ({ type: e.type, adversarial: e.adversarial, visualOnly: e.visualOnly, pixelCoverage: e.pixelCoverage, textLeaked: e.textLeaked })) }])),
  promptInjectionBaseline: injection,
  pages,
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/redteam.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ aggregate: report.aggregate, byTechnique: report.byTechnique, promptInjectionBaseline: report.promptInjectionBaseline }, null, 1));
