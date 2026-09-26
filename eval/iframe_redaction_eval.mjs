// D1 — cross-origin iframe redaction eval.
//
// A genuine cross-origin embed: checkout_iframe.html (served from 127.0.0.1)
// embeds payment_widget.html from `localhost` — same server/port, different
// hostname, so the browser treats it as a real cross-origin frame, the same
// shape as a Razorpay/Stripe checkout widget. The extension can only see into it
// because manifest.json injects content.js into every frame (all_frames: true),
// not because it shares an origin with the top page.
//
//   node eval/iframe_redaction_eval.mjs        (server must be running: uvicorn server.app:app --port 8000)

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const URL = process.env.IFRAME_URL || "http://127.0.0.1:8000/demo/checkout_iframe.html";

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
const page = await openPage(browser, URL);
// give the iframe's own content script a moment to inject + the frame to load
await new Promise((r) => setTimeout(r, 800));
const tabId = await tabIdFor(ctl, URL);
const r = await preview(ctl, tabId, "balanced");

if (!r?.ok) {
  console.error("FAIL:", r?.error ?? "privacy preview failed");
  process.exitCode = 1;
} else {
  const { w: W, h: H } = r.viewport;
  const painted = r.boxes.map((b) => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }));
  const P = rasterize(painted, W, H);

  // ground truth for the iframe's OWN fields — read from inside the iframe's
  // document, which puppeteer can reach directly via page.frames() even though
  // the extension had to work harder (all_frames content script + offset merge).
  const frame = page.frames().find((f) => f.url().includes("payment_widget.html"));
  const iframeEl = await page.$("#pay-frame");
  const frameRect = iframeEl ? await iframeEl.boundingBox() : null;
  let gt = [];
  if (frame && frameRect) {
    const localGt = await frame.evaluate(() => {
      const vis = (rc) => rc.width > 0 && rc.height > 0;
      const out = [];
      for (const el of document.querySelectorAll("[data-pii]")) {
        const rc = el.getBoundingClientRect();
        if (vis(rc)) out.push({ type: el.dataset.pii, x: rc.x, y: rc.y, w: rc.width, h: rc.height });
      }
      return out;
    });
    gt = localGt.map((g) => ({ ...g, x: g.x + frameRect.x, y: g.y + frameRect.y }));
  }

  const G = rasterize(gt, W, H);
  const inter = and(P, G);
  const objects = gt.map((g) => {
    const gm = rasterize([g], W, H);
    const cov = count(gm) ? and(gm, P) / count(gm) : 1;
    return { type: g.type, coverage: +cov.toFixed(3) };
  });
  const missed = objects.filter((o) => o.coverage < 0.9);

  const iframeFieldsFoundInSanitizedDom = (r.sanitizedDom || []).filter((n) => /^f\d+_/.test(n.id)).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    url: URL,
    frameCount: r.frameCount,
    unreachableFrames: r.unreachableFrames,
    iframeReached: !!frame,
    iframeFieldsFoundInSanitizedDom,
    gtObjects: gt.length,
    objectCoverage: objects,
    objectRecall: gt.length ? +((objects.length - missed.length) / objects.length).toFixed(3) : null,
    missed,
    pixelPrecision: count(P) ? +(inter / count(P)).toFixed(3) : null,
    pixelRecall: count(G) ? +(inter / count(G)).toFixed(3) : null,
  };

  await mkdir("eval/results", { recursive: true });
  await writeFile("eval/results/iframe_redaction.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  if (!frame || gt.length === 0 || missed.length > 0 || r.frameCount < 2) {
    console.error("\nFAIL: cross-origin iframe fields were not fully redacted.");
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: ${r.frameCount} frames extracted, ${gt.length}/${gt.length} iframe PII objects boxed (0 missed).`);
  }
}

await page.close();
await browser.close();
