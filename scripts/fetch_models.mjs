// Downloads the on-device models into extension/models/ so the extension runs fully
// offline (env.allowRemoteModels = false at runtime — no model bytes are fetched from
// the network once installed).
//
//   node scripts/fetch_models.mjs            # client models only (~41 MB)
//   node scripts/fetch_models.mjs --dev      # + MobileCLIP text tower (build-time only)
//
// Layout follows Transformers.js' local-model convention: models/<repo>/<file>.

import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = "extension/models";
const HF = "https://huggingface.co";

const CLIENT = [
  // Face detector — OpenCV YuNet (FP32, ~0.2 MB, CNN, anchor-free). FP32 not INT8:
  // the QDQ graph is 2.6x slower on the WASM CPU backend (eval/README.md).
  { repo: "opencv/face_detection_yunet", files: ["face_detection_yunet_2023mar.onnx"], out: "yunet" },
  // PII NER — BERT-small fine-tuned on PII entity types (INT8, ~29 MB)
  {
    repo: "onnx-community/bert-small-pii-detection-ONNX",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"],
  },
  // Screen / region understanding — MobileCLIP-S0 image tower (FP16, ~23 MB).
  // (INT8 dynamic quantization measurably breaks its zero-shot accuracy — see eval/README.md.)
  // Only the vision tower ships; label text embeddings are precomputed at build time.
  {
    repo: "Xenova/mobileclip_s0",
    files: ["config.json", "preprocessor_config.json", "onnx/vision_model_fp16.onnx"],
  },
  // OCR — PP-OCRv4 text detection + recognition (ONNX, ~15 MB total)
  // ppocr_keys_v1.txt: 6623-char recognition dictionary, one character per line.
  // Required by the CTC decoder: charset[k] = character for logit index k+1.
  {
    repo: "PaddlePaddle/PaddleOCR",
    files: [
      "inference/det/ch_PP-OCRv4_det_infer.onnx",
      "inference/rec/ch_PP-OCRv4_rec_infer.onnx",
      "ppocr/utils/ppocr_keys_v1.txt",
    ],
    out: "pp-ocrv4",
  },
];

const DEV = [
  {
    repo: "Xenova/mobileclip_s0",
    files: ["tokenizer.json", "tokenizer_config.json", "onnx/text_model.onnx"],
  },
  // Larger general NER — used only by eval to justify the model choice.
  {
    repo: "onnx-community/distilbert-NER-ONNX",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"],
  },
];

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function fetchOne(repo, file, outDir) {
  const dest = path.join(ROOT, outDir ?? repo, file);
  if (await exists(dest)) return { dest, cached: true };
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(`${HF}/${repo}/resolve/main/${file}`);
  if (!res.ok) throw new Error(`${repo}/${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return { dest, bytes: buf.length };
}

const sets = process.argv.includes("--dev") ? [...CLIENT, ...DEV] : CLIENT;
for (const m of sets) {
  for (const f of m.files) {
    const r = await fetchOne(m.repo, f, m.out);
    console.log(r.cached ? `  cached ${r.dest}` : `  fetched ${r.dest} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  }
}
