// Redaction precision/recall ON PIXELS (criteria 2 + 3), through the real extension.
//
//   node eval/redaction_eval.mjs            (server must serve /demo — any provider)
//
// Ground truth comes from the demo pages' annotations, which the extension never
// reads: data-pii="TYPE" (text spans / fields), data-face (photos),
// data-sensitive-img (ID card, signature). For each page the harness renders a
// CSS-pixel mask of GT and of what the extension painted, then reports:
//   pixel precision = painted ∩ GT / painted      (over-redaction hurts it)
//   pixel recall    = painted ∩ GT / GT           (leaks hurt it)
//   object recall   = GT elements >= 90% covered   (a half-covered email is a leak)
//   IoU per object, and a list of any GT object left < 90% covered.
// Images: the WHOLE image element counts as GT for data-sensitive-img; for data-face
// the face box is inside the photo, so any painted pixel inside the photo is correct
// (precision) and recall is measured on the image's central 50% (where the face is).

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";
const PAGES = ["kyc", "inbox", "social", "checkout", "register"];

function rasterize(boxes, W, H) {
  const m = new Uint8Array(W * H);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(W, Math.ceil(b.x + b.w)), y1 = Math.min(H, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
  }
  return m;
}
const count = (m) => m.reduce((a, v) => a + v, 0);
const and = (a, b) => a.reduce((s, v, i) => s + (v & b[i]), 0);

const { browser, ctl } = await launch();
const results = [];
for (const name of PAGES) {
  const url = `${SERVER}/demo/${name}.html`;
  const page = await openPage(browser, url);
  const tabId = await tabIdFor(ctl, url);
  const r = await preview(ctl, tabId, "balanced");
  if (!r?.ok) {
    results.push({ page: name, error: r?.error });
    continue;
  }
  const { w: W, h: H } = r.viewport;
  // ground truth (viewport CSS px); text spans use their own rects, fields/images the element
  const gt = await page.evaluate(() => {
    const vis = (rc) => rc.width > 0 && rc.height > 0 && rc.bottom > 0 && rc.top < innerHeight;
    const out = [];
    for (const el of document.querySelectorAll("[data-pii]")) {
      const rects = el.tagName === "INPUT" || el.tagName === "SELECT" ? [el.getBoundingClientRect()] : [...(() => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getClientRects(); })()];
      for (const rc of rects) if (vis(rc)) out.push({ kind: "pii", type: el.dataset.pii, x: rc.x, y: rc.y, w: rc.width, h: rc.height });
    }
    for (const el of document.querySelectorAll("[data-face], [data-sensitive-img]")) {
      const rc = el.getBoundingClientRect();
      if (vis(rc)) out.push({ kind: el.hasAttribute("data-face") ? "face" : "image", type: el.dataset.sensitiveImg || "FACE", x: rc.x, y: rc.y, w: rc.width, h: rc.height });
    }
    return out;
  });

  // predicted painted regions: text/field boxes + faces + sensitive image regions (ROI rects)
  const roiById = Object.fromEntries(r.rois.map((x) => [x.id, x]));
  const painted = [
    ...r.boxes.map((b) => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 })),
    ...r.sensitiveRegions.map((id) => roiById[id]).filter(Boolean),
  ];
  const P = rasterize(painted, W, H);
  // GT mask: images count whole element (any paint inside a photo/ID card is correct)
  const G = rasterize(gt, W, H);
  const inter = and(P, G);
  const objects = gt.map((g) => {
    const core = g.kind === "face" ? { x: g.x + g.w * 0.25, y: g.y + g.h * 0.2, w: g.w * 0.5, h: g.h * 0.6 } : g;
    const gm = rasterize([core], W, H);
    const cov = count(gm) ? and(gm, P) / count(gm) : 1;
    return { kind: g.kind, type: g.type, coverage: +cov.toFixed(3) };
  });
  const missed = objects.filter((o) => o.coverage < 0.9);
  results.push({
    page: name,
    gtObjects: gt.length,
    paintedBoxes: painted.length,
    pixelPrecision: count(P) ? +(inter / count(P)).toFixed(3) : null,
    pixelRecall: count(G) ? +(inter / count(G)).toFixed(3) : null,
    px: { painted: count(P), gt: count(G), inter },
    objectRecall: +((objects.length - missed.length) / Math.max(1, objects.length)).toFixed(3),
    missed,
    screen: r.screen?.state,
    perceptionMs: r.timings?.perceptionTotalMs,
  });
  await page.close();
}
await browser.close();

const valid = results.filter((x) => !x.error);
const sum = (k) => valid.reduce((a, x) => a + x.px[k], 0);
const agg = {
  pages: valid.length,
  gtObjects: valid.reduce((a, x) => a + x.gtObjects, 0),
  // micro-averaged over all pixels of all pages
  pixelPrecision: +(sum("inter") / Math.max(1, sum("painted"))).toFixed(3),
  pixelRecall: +(sum("inter") / Math.max(1, sum("gt"))).toFixed(3),
  objectRecall: +(valid.reduce((a, x) => a + (x.gtObjects - x.missed.length), 0) / Math.max(1, valid.reduce((a, x) => a + x.gtObjects, 0))).toFixed(3),
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/redaction.json", JSON.stringify({ generatedAt: new Date().toISOString(), aggregate: agg, pages: results }, null, 2));
console.log(JSON.stringify({ aggregate: agg, pages: results.map(({ page, pixelPrecision, pixelRecall, objectRecall, missed }) => ({ page, pixelPrecision, pixelRecall, objectRecall, missed })) }, null, 1));
