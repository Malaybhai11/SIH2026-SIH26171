// Face-detector precision/recall on WIDER FACE (val) using the SHIPPED decode path
// (extension/lib/perception/faces.js) with onnxruntime-node.
//
//   node eval/faces_eval.mjs [--n 300] [--min 24]
//
// Faces smaller than --min px (long side) are "ignore" regions: detections on them are
// neither TP nor FP. On a browser screen, a face smaller than ~24 px is not
// identifiable, and WIDER is dominated by tiny crowd faces irrelevant to this task.

import ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { FaceDetector } from "../extension/lib/perception/faces.js";
import { iou } from "../extension/lib/perception/image.js";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg("--n", 300);
const MIN = arg("--min", 24);
const THR = arg("--thr", 0.6);
const ROOT = "eval/.cache";
if (!existsSync(`${ROOT}/WIDER_val`)) {
  console.error("WIDER val missing — see eval/README.md (download WIDER_val.zip + wider_face_split.zip into eval/.cache)");
  process.exit(1);
}

function parseGt(txt) {
  const lines = txt.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length && lines[i].trim()) {
    const file = lines[i++].trim();
    const n = Number(lines[i++]);
    const boxes = [];
    for (let k = 0; k < Math.max(n, 1); k++) {
      const p = lines[i++].trim().split(/\s+/).map(Number);
      if (n === 0) break;
      const [x, y, w, h, , , , invalid] = p;
      boxes.push({ x, y, w, h, invalid: invalid === 1 });
    }
    out.push({ file, boxes });
  }
  return out;
}

const all = parseGt(await readFile(`${ROOT}/wider_face_split/wider_face_val_bbx_gt.txt`, "utf8"));
const step = Math.max(1, Math.floor(all.length / N));
const sample = all.filter((_, i) => i % step === 0).slice(0, N);

const session = await ort.InferenceSession.create("extension/models/yunet/face_detection_yunet_2023mar.onnx", {
  executionProviders: ["cpu"],
  intraOpNumThreads: 1, // match a single WASM thread — conservative client estimate
});
const det = new FaceDetector(ort, session);

let tp = 0, fp = 0, fn = 0, ms = 0;
const bySize = { "24-48": [0, 0], "48-96": [0, 0], "96+": [0, 0] };
for (const s of sample) {
  const { data, info } = await sharp(`${ROOT}/WIDER_val/images/${s.file}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
  const t0 = performance.now();
  const preds = await det.detect(img, { scoreThresh: THR });
  ms += performance.now() - t0;

  const gts = s.boxes.map((b) => ({ ...b, care: !b.invalid && Math.max(b.w, b.h) >= MIN, hit: false }));
  for (const p of preds) {
    let best = null, bestIou = 0;
    for (const g of gts) {
      const v = iou(p, g);
      if (v > bestIou) { bestIou = v; best = g; }
    }
    if (best && bestIou >= 0.5) {
      if (best.care && !best.hit) { best.hit = true; tp++; }
      // matches on ignore/duplicate boxes are neither TP nor FP
    } else if (bestIou >= 0.3 && best && !best.care) {
      // overlaps an ignored tiny face — not an FP
    } else fp++;
  }
  for (const g of gts) {
    if (!g.care) continue;
    const L = Math.max(g.w, g.h);
    const bucket = L < 48 ? "24-48" : L < 96 ? "48-96" : "96+";
    bySize[bucket][1]++;
    if (g.hit) bySize[bucket][0]++;
    else fn++;
  }
}

const report = {
  dataset: `WIDER FACE val, ${sample.length} images (every ${step}th), faces >= ${MIN}px, IoU >= 0.5`,
  model: "YuNet 2023mar FP32 (0.2 MB)",
  scoreThresh: THR,
  tp, fp, fn,
  precision: +(tp / (tp + fp)).toFixed(3),
  recall: +(tp / (tp + fn)).toFixed(3),
  recallBySize: Object.fromEntries(Object.entries(bySize).map(([k, [h, n]]) => [k, { recall: +(h / n).toFixed(3), n }])),
  avgMsPerImage_1thread: +(ms / sample.length).toFixed(1),
};
console.log(JSON.stringify(report, null, 2));
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/faces.json", JSON.stringify(report, null, 2));
