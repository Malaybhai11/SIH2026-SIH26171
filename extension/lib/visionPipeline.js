// Client-side vision pipeline.
//
//   Model A — face detector (BlazeFace)      -> bounding boxes for visual redaction
//   Model B — screen/region classifier (TinyViT) -> screenState + region labels
//   Model C — PII NER (DistilBERT)           -> name/location spans (lazy)
//
// Execution provider order: webgpu -> wasm -> mock. `mock` is a real fallback, not a
// stub: it derives deterministic outputs from the input + DOM hints so the whole
// agent loop is demoable with zero model files (see docs/model-contract.md).
//
// onnxruntime-web is dynamically imported and marked external in the build, so its
// absence is not a build or runtime error — it just means mock mode.

import { resourceUrl } from "./browserApi.js";

const MODEL_FILES = {
  face: "models/blazeface_int8.onnx",
  screen: "models/tinyvit_screen_int8.onnx",
  ner: "models/distilbert_ner_int8.onnx",
};

const SCREEN_LABELS = [
  "sensitive-form-field",
  "password-input",
  "payment-info",
  "body-text",
  "image-content",
  "navigation",
];

let _mode = null; // "webgpu" | "wasm" | "mock"
let _ort = null;
let _sessions = { face: null, screen: null, ner: null };
let _initPromise = null;

async function modelExists(file) {
  try {
    const res = await fetch(resourceUrl(file), { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryLoadOrt() {
  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = await import("onnxruntime-web/webgpu");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function createSession(ort, file, providers) {
  return ort.InferenceSession.create(resourceUrl(file), {
    executionProviders: providers,
    graphOptimizationLevel: "all",
  });
}

/**
 * Initialise the pipeline. Idempotent. Resolves to the active mode string.
 */
export function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const haveFace = await modelExists(MODEL_FILES.face);
    const haveScreen = await modelExists(MODEL_FILES.screen);
    if (!haveFace && !haveScreen) {
      _mode = "mock";
      return _mode;
    }
    _ort = await tryLoadOrt();
    if (!_ort) {
      _mode = "mock";
      return _mode;
    }

    _ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    _ort.env.wasm.simd = true;

    const providerSets = [
      [{ name: "webgpu", preferredLayout: "NHWC" }, "wasm"],
      ["wasm"],
    ];
    for (const providers of providerSets) {
      try {
        if (haveFace) _sessions.face = await createSession(_ort, MODEL_FILES.face, providers);
        if (haveScreen) _sessions.screen = await createSession(_ort, MODEL_FILES.screen, providers);
        _mode = providers[0] === "wasm" ? "wasm" : "webgpu";
        return _mode;
      } catch (err) {
        console.warn("[vision] provider set failed, trying next", providers, err);
        _sessions = { face: null, screen: null, ner: null };
      }
    }
    _mode = "mock";
    return _mode;
  })();
  return _initPromise;
}

export function getMode() {
  return _mode || "uninitialised";
}

// --- image helpers -------------------------------------------------------------

/** dataURL / Blob -> ImageData at a target size. */
export async function toImageData(source, w, h) {
  const bmp =
    source instanceof ImageBitmap
      ? source
      : await createImageBitmap(
          typeof source === "string" ? await (await fetch(source)).blob() : source,
        );
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  return { imageData: ctx.getImageData(0, 0, w, h), natural: { w: bmp.width, h: bmp.height } };
}

function hashImageData(img) {
  // cheap deterministic digest of pixel data for mock outputs
  let h = 2166136261;
  const d = img.data;
  for (let i = 0; i < d.length; i += 997) {
    h ^= d[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tileLuma(img, tile = 64) {
  // returns list of {x,y,w,h,luma} tiles that are unusually bright/dark (mock "faces")
  const { width, height, data } = img;
  const out = [];
  for (let ty = 0; ty < height; ty += tile) {
    for (let tx = 0; tx < width; tx += tile) {
      let sum = 0;
      let n = 0;
      for (let y = ty; y < Math.min(ty + tile, height); y += 8) {
        for (let x = tx; x < Math.min(tx + tile, width); x += 8) {
          const o = (y * width + x) * 4;
          sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          n++;
        }
      }
      out.push({ x: tx, y: ty, w: tile, h: tile, luma: n ? sum / n : 0 });
    }
  }
  return out;
}

// --- Model A: faces ----------------------------------------------------------

export async function detectFaces(imageData, naturalSize) {
  const t0 = performance.now();
  let boxes = [];

  if (_mode === "mock" || !_sessions.face) {
    // Deterministic pseudo-detection: flag skin-ish mid-luma tiles so the visual
    // redaction path is demoable. Tuned to fire rarely.
    const tiles = tileLuma(imageData);
    const mean = tiles.reduce((a, t) => a + t.luma, 0) / (tiles.length || 1);
    boxes = tiles
      .filter((t) => t.luma > mean * 1.35 && t.luma > 120 && t.luma < 210)
      .slice(0, 3)
      .map((t) => ({ x1: t.x, y1: t.y, x2: t.x + t.w, y2: t.y + t.h, score: 0.6, mock: true }));
  } else {
    const { width, height, data } = imageData;
    const chw = new Float32Array(3 * width * height);
    for (let i = 0; i < width * height; i++) {
      chw[i] = data[i * 4] / 127.5 - 1;
      chw[width * height + i] = data[i * 4 + 1] / 127.5 - 1;
      chw[2 * width * height + i] = data[i * 4 + 2] / 127.5 - 1;
    }
    const tensor = new _ort.Tensor("float32", chw, [1, 3, height, width]);
    const out = await _sessions.face.run({ input: tensor });
    const b = out.boxes?.data ?? [];
    const s = out.scores?.data ?? [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] >= 0.5) {
        boxes.push({ x1: b[i * 4], y1: b[i * 4 + 1], x2: b[i * 4 + 2], y2: b[i * 4 + 3], score: s[i] });
      }
    }
  }

  // scale from model input space to natural screenshot space
  if (naturalSize) {
    const sx = naturalSize.w / imageData.width;
    const sy = naturalSize.h / imageData.height;
    boxes = boxes.map((bx) => ({
      x1: Math.round(bx.x1 * sx),
      y1: Math.round(bx.y1 * sy),
      x2: Math.round(bx.x2 * sx),
      y2: Math.round(bx.y2 * sy),
      score: bx.score,
      mock: bx.mock,
    }));
  }
  return { boxes, ms: performance.now() - t0 };
}

// --- Model B: screen state -------------------------------------------------

function screenStateFromDom(domHints = {}) {
  if (domHints.hasPasswordField) return { screenState: "login", confidence: 0.72 };
  if (domHints.hasPaymentField) return { screenState: "checkout", confidence: 0.7 };
  if ((domHints.articleRoleCount || 0) >= 4) return { screenState: "feed", confidence: 0.68 };
  if ((domHints.formFieldCount || 0) >= 3) return { screenState: "form", confidence: 0.6 };
  if ((domHints.paragraphCount || 0) >= 3) return { screenState: "content", confidence: 0.62 };
  return { screenState: "unknown", confidence: 0.5 };
}

export async function classifyScreen(imageData, domHints = {}) {
  const t0 = performance.now();

  if (_mode === "mock" || !_sessions.screen) {
    const base = screenStateFromDom(domHints);
    return { ...base, regions: [], ms: performance.now() - t0, source: "dom-heuristic" };
  }

  const size = 224;
  const { data } = imageData;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const chw = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      chw[c * size * size + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  const tensor = new _ort.Tensor("float32", chw, [1, 3, size, size]);
  const out = await _sessions.screen.run({ input: tensor });
  const logits = Array.from(out.logits?.data ?? []);
  const max = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const probs = exp.map((v) => v / sum);
  const top = probs.indexOf(Math.max(...probs));
  const label = SCREEN_LABELS[top];

  const mapping = {
    "password-input": "login",
    "sensitive-form-field": "login",
    "payment-info": "checkout",
    "body-text": (domHints.articleRoleCount || 0) >= 4 ? "feed" : "content",
    "image-content": "content",
    navigation: "unknown",
  };
  return {
    screenState: mapping[label] || "unknown",
    confidence: probs[top],
    regions: SCREEN_LABELS.map((name, i) => ({ name, prob: probs[i] })).filter((r) => r.prob > 0.15),
    ms: performance.now() - t0,
    source: _mode,
  };
}

// --- Model C: NER (lazy) -------------------------------------------------

let _nerReady = null;
export async function ensureNer() {
  if (_nerReady) return _nerReady;
  _nerReady = (async () => {
    if (_mode === "mock" || !_ort) return null;
    if (!(await modelExists(MODEL_FILES.ner))) return null;
    try {
      _sessions.ner = await createSession(_ort, MODEL_FILES.ner, ["wasm"]);
      return _sessions.ner;
    } catch (err) {
      console.warn("[vision] NER load failed", err);
      return null;
    }
  })();
  return _nerReady;
}

/** Returns a `nerTag(text) -> [{start,end,label}]` fn, or null in mock mode. */
export async function getNerTagger() {
  const session = await ensureNer();
  if (!session) return null;
  // Real WordPiece tokenisation + decode would live here; kept minimal for MVP.
  // Until wired, return an empty tagger so redact.js relies on the regex layer.
  return async () => [];
}

// --- Combined pass ---------------------------------------------------------

/**
 * @param {ImageData} faceInput   image at face model input size (128x128)
 * @param {ImageData} screenInput image at screen model input size (224x224)
 * @param {object}    domHints
 * @param {{w,h}}     naturalSize screenshot natural resolution
 */
export async function run({ faceInput, screenInput, domHints, naturalSize }) {
  const [faces, screen] = await Promise.all([
    detectFaces(faceInput, naturalSize),
    classifyScreen(screenInput, domHints),
  ]);
  return {
    mode: _mode,
    boxes: faces.boxes,
    screenState: screen.screenState,
    screenStateConfidence: screen.confidence,
    regions: screen.regions,
    timings: { faceMs: Math.round(faces.ms), screenMs: Math.round(screen.ms) },
  };
}

/** Whether the client should attach the redacted screenshot this turn. */
export function shouldSendScreenshot(screenState, confidence) {
  if (confidence < 0.6) return true;
  return ["login", "checkout", "unknown"].includes(screenState);
}
