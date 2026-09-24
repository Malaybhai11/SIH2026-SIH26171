// Train + evaluate the on-device screen classifier head.
//
//   node eval/screens_capture.mjs      # dataset: screenshot + DOM features per URL
//   node eval/screens_train.mjs        # -> eval/results/screens.json, extension/models/screen_head.json
//
// Input per screen x = [MobileCLIP-S0 image embedding (512, L2-normalised) ; structural
// DOM features (log-scaled counts, see screenFeatures.js)]. Head = multinomial logistic
// regression over 10 privacy-relevant screen categories (weights ~22 KB JSON). Fine
// sub-types (kyc/checkout/inbox/...) are refined on-device from DOM cues.
//
// Evaluation is LEAVE-DOMAIN-OUT (5 folds grouped by hostname): the head is always
// scored on websites it never saw in training. Baselines on the same folds:
//   zero-shot CLIP (18 prompts, mapped to categories), CLIP + hand-written DOM priors,
//   linear head on CLIP only, linear head on CLIP + DOM.

import ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { ClipClassifier } from "../extension/lib/perception/clip.js";
import { fuseScreen, featureVector, COARSE_OF, COARSE } from "../extension/lib/screenFeatures.js";

const DIR = "eval/.cache/screens_ds";
const overrides = JSON.parse(await readFile("eval/screens_labels.json", "utf8").catch(() => "{}"));

// ---- load dataset + embeddings (cached) ----
const labels = JSON.parse(await readFile("extension/models/clip_labels.json", "utf8"));
const session = await ort.InferenceSession.create("extension/models/Xenova/mobileclip_s0/onnx/vision_model_fp16.onnx", { intraOpNumThreads: 3 });
const clf = new ClipClassifier(ort, session, labels);
const cacheFile = `${DIR}/_emb.json`;
const embCache = JSON.parse(await readFile(cacheFile, "utf8").catch(() => "{}"));

const rows = [];
for (const f of (await readdir(DIR)).filter((x) => /^\d{3}\.json$/.test(x)).sort()) {
  const id = f.slice(0, 3);
  const meta = JSON.parse(await readFile(`${DIR}/${f}`, "utf8"));
  const label = id in overrides ? overrides[id] : meta.label;
  if (!label || !meta.features) continue;
  let emb = embCache[id];
  if (!emb) {
    const { data, info } = await sharp(`${DIR}/${id}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    emb = Array.from(await clf.embed({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }));
    embCache[id] = emb;
  }
  let host = "";
  try {
    host = new URL(meta.url).hostname.replace(/^www\./, "");
  } catch {}
  rows.push({ id, label, coarse: COARSE_OF[label], host, url: meta.url, emb, feats: meta.features });
}
await writeFile(cacheFile, JSON.stringify(embCache));
console.log(`${rows.length} labelled screens, ${new Set(rows.map((r) => r.host)).size} sites`);

// ---- softmax regression ----
function train(X, y, K, { epochs = 400, lr = 0.5, l2 = 1e-3 } = {}) {
  const D = X[0].length;
  const W = Array.from({ length: K }, () => new Float64Array(D));
  const b = new Float64Array(K);
  // class-balanced sample weights
  const cnt = new Array(K).fill(0);
  y.forEach((c) => cnt[c]++);
  const sw = y.map((c) => X.length / (K * Math.max(1, cnt[c])));
  for (let ep = 0; ep < epochs; ep++) {
    const gW = Array.from({ length: K }, () => new Float64Array(D));
    const gb = new Float64Array(K);
    for (let n = 0; n < X.length; n++) {
      const z = W.map((w, k) => b[k] + w.reduce((a, v, d) => a + v * X[n][d], 0));
      const m = Math.max(...z);
      const e = z.map((v) => Math.exp(v - m));
      const s = e.reduce((a, v) => a + v, 0);
      for (let k = 0; k < K; k++) {
        const g = (e[k] / s - (y[n] === k ? 1 : 0)) * sw[n];
        gb[k] += g;
        for (let d = 0; d < D; d++) gW[k][d] += g * X[n][d];
      }
    }
    for (let k = 0; k < K; k++) {
      b[k] -= (lr * gb[k]) / X.length;
      for (let d = 0; d < D; d++) W[k][d] -= lr * (gW[k][d] / X.length + l2 * W[k][d]);
    }
  }
  return { W: W.map((w) => Array.from(w)), b: Array.from(b) };
}
const predict = (m, x) => {
  const z = m.W.map((w, k) => m.b[k] + w.reduce((a, v, d) => a + v * x[d], 0));
  return z.indexOf(Math.max(...z));
};

const K = COARSE.length;
const X_clip = rows.map((r) => r.emb);
const X_full = rows.map((r) => [...r.emb, ...featureVector(r.feats)]);
const y = rows.map((r) => COARSE.indexOf(r.coarse));

// leave-domain-out folds
const hosts = [...new Set(rows.map((r) => r.host))].sort();
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
hosts.sort(() => rnd() - 0.5);
const foldOf = Object.fromEntries(hosts.map((h, i) => [h, i % 5]));

const preds = { zeroShot: [], priors: [], headClip: [], headFull: [] };
for (let f = 0; f < 5; f++) {
  const tr = rows.map((r, i) => i).filter((i) => foldOf[rows[i].host] !== f);
  const te = rows.map((r, i) => i).filter((i) => foldOf[rows[i].host] === f);
  const mClip = train(tr.map((i) => X_clip[i]), tr.map((i) => y[i]), K);
  const mFull = train(tr.map((i) => X_full[i]), tr.map((i) => y[i]), K);
  for (const i of te) {
    const zs = clf.classify(Float32Array.from(rows[i].emb), "screen");
    preds.zeroShot[i] = COARSE.indexOf(COARSE_OF[zs.top]);
    preds.priors[i] = COARSE.indexOf(COARSE_OF[fuseScreen(zs.all, rows[i].feats).top]);
    preds.headClip[i] = predict(mClip, X_clip[i]);
    preds.headFull[i] = predict(mFull, X_full[i]);
  }
}
const acc = (p) => +(p.filter((v, i) => v === y[i]).length / y.length).toFixed(3);
const perClass = (p) =>
  Object.fromEntries(COARSE.map((c, k) => {
    const idx = y.map((v, i) => (v === k ? i : -1)).filter((i) => i >= 0);
    return [c, { n: idx.length, acc: idx.length ? +(idx.filter((i) => p[i] === k).length / idx.length).toFixed(2) : null }];
  }));
const confusion = (p) => {
  const out = {};
  y.forEach((v, i) => {
    if (p[i] !== v) {
      const key = `${COARSE[v]}->${COARSE[p[i]]}`;
      out[key] = (out[key] || 0) + 1;
    }
  });
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

// head trained on all data (kept for research; not shipped — see report.shipped)
const final = train(X_full, y, K);
await writeFile(
  "eval/.cache/screen_head.json",
  JSON.stringify({ classes: COARSE, dim: X_full[0].length, W: final.W.map((w) => w.map((v) => +v.toFixed(5))), b: final.b.map((v) => +v.toFixed(5)), trainedOn: rows.length }),
);

const report = {
  generatedAt: new Date().toISOString(),
  protocol: `leave-domain-out 5-fold CV, ${rows.length} screens from ${hosts.length} sites, ${K} categories`,
  categories: COARSE,
  accuracy: { zeroShotClip: acc(preds.zeroShot), clipPlusDomPriors: acc(preds.priors), linearHeadClip: acc(preds.headClip), linearHeadClipPlusDom: acc(preds.headFull) },
  shipped: "clipPlusDomPriors (best under leave-domain-out; the linear head needs more site diversity)",
  perClass_shipped: perClass(preds.priors),
  confusions_shipped: confusion(preds.priors),
  perClass_linearHeadClipPlusDom: perClass(preds.headFull),
  errors_shipped: rows.map((r, i) => (preds.priors[i] !== y[i] ? { id: r.id, label: r.label, pred: COARSE[preds.priors[i]], url: r.url } : null)).filter(Boolean),
};
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/screens.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ protocol: report.protocol, accuracy: report.accuracy, perClass: report.perClass_shipped, confusions: report.confusions_shipped }));
