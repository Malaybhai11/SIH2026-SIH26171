// PerceptionEngine — the on-device vision + PII brain. Hosted ONCE per browser:
//   Chrome:  offscreen document (WebGPU/WASM available, unlike the service worker)
//   Firefox: the background page (it is a real document; no offscreen API needed)
// Every tab shares the same loaded models, so memory cost is paid once, not per tab.
//
// Models (all local files under models/, never fetched remotely):
//   YuNet FP32 (0.2 MB)            faces
//   MobileCLIP-S0 image FP16 (23 MB) screen state + region semantics (zero-shot)
//   BERT-small PII INT8 (29 MB)    names / places in text
//
// Adaptive compute — what keeps the resource and latency metrics low:
//   * lazy model load (NER only when text needs it, CLIP only when asked)
//   * frame cache: dHash of the screenshot; an unchanged screen reuses last results
//   * ROI mosaic: every on-page image is packed into ONE 640x640 YuNet pass, so
//     avatars/thumbnails are upscaled into detectable size at the cost of one run
//   * region cache: CLIP labels cached per image content hash across steps/tabs
//   * NER cache: per-string LRU; most UI strings repeat between agent steps

import * as ort from "onnxruntime-web/webgpu";
import { FaceDetector } from "./faces.js";
import { ClipClassifier } from "./clip.js";
import { PiiNer } from "./ner.js";
import { OcrEngine, joinOcrWords, mapSpansToWordBoxes } from "./ocr.js";
import { crop, dHash, hamming, resize } from "./image.js";
import { fuseScreen, COARSE_OF } from "../screenFeatures.js";
import { detectSpans } from "../redact.js";

const FILES = {
  // fp32 (0.2 MB): 2.6x faster than the INT8 graph on the WASM CPU backend (measured)
  face: "models/yunet/face_detection_yunet_2023mar.onnx",
  clip: "models/Xenova/mobileclip_s0/onnx/vision_model_fp16.onnx",
  clipLabels: "models/clip_labels.json",
  ner: "models/onnx-community/bert-small-pii-detection-ONNX/onnx/model_quantized.onnx",
  nerTok: "models/onnx-community/bert-small-pii-detection-ONNX/tokenizer.json",
  nerCfg: "models/onnx-community/bert-small-pii-detection-ONNX/config.json",
};

const CELL = 160; // ROI mosaic cell (4x4 grid in a 640 input)
const MAX_REGION_CLIP = 4; // new (uncached) region classifications per frame
const REGION_SENSITIVE_MIN_P = 0.35;
// A1: only ROI kinds that CAN'T have DOM text (an <img>/<canvas>/<object>/<embed> is
// always a replaced element — its pixels are never text nodes) get OCR'd; text
// already covered by the DOM layer is much cheaper to find there.
const OCR_ROI_KINDS = new Set(["img", "canvas", "object", "embed", "picture"]);
const MAX_OCR_REGIONS = 3; // new (uncached) OCR passes per frame — LSTM inference is not free
const OCR_MIN_SIZE = 32; // skip icons/avatars too small to hold readable text

class LRU {
  constructor(n) {
    this.n = n;
    this.m = new Map();
  }
  get(k) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.m.set(k, v);
    if (this.m.size > this.n) this.m.delete(this.m.keys().next().value);
  }
}

export class PerceptionEngine {
  constructor({ urlFor }) {
    this.urlFor = urlFor; // relative path -> absolute extension URL
    this.ep = null;
    this.models = {};
    this.loading = {};
    this.stats = { ep: null, models: {}, calls: {}, cache: { frame: 0, region: 0, ner: 0 } };
    this.nerCache = new LRU(8000);
    this.regionCache = new LRU(500);
    this.lastFrame = null;
    this.faceCache = new LRU(200);
    this.screenCache = new LRU(100);
    this.ocrCache = new LRU(300); // region content hash -> recognised spans (device px, offset 0,0)
  }

  async pickEp() {
    if (this.ep) return this.ep;
    ort.env.wasm.wasmPaths = this.urlFor("ort/");
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.logLevel = "error";
    let ep = "wasm";
    try {
      if (navigator.gpu && (await navigator.gpu.requestAdapter())) ep = "webgpu";
    } catch {
      /* no adapter */
    }
    this.ep = ep;
    this.stats.ep = ep;
    this.stats.threads = ort.env.wasm.numThreads;
    return ep;
  }

  async session(key, file, { preferGpu = true } = {}) {
    const ep = await this.pickEp();
    const t0 = performance.now();
    const buf = await (await fetch(this.urlFor(file))).arrayBuffer();
    const providers = ep === "webgpu" && preferGpu ? ["webgpu", "wasm"] : ["wasm"];
    let s;
    try {
      s = await ort.InferenceSession.create(buf, { executionProviders: providers, graphOptimizationLevel: "all" });
    } catch (e) {
      if (providers[0] !== "webgpu") throw e;
      s = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      providers.splice(0, providers.length, "wasm");
    }
    this.stats.models[key] = { bytes: buf.byteLength, loadMs: Math.round(performance.now() - t0), ep: providers[0] };
    return s;
  }

  async json(file) {
    return (await fetch(this.urlFor(file))).json();
  }

  load(key) {
    if (this.models[key]) return Promise.resolve(this.models[key]);
    if (!this.loading[key]) {
      this.loading[key] = (async () => {
        let m;
        if (key === "face") {
          // tiny conv net: WASM CPU beats WebGPU dispatch overhead at this size
          m = new FaceDetector(ort, await this.session("face", FILES.face, { preferGpu: false }));
        } else if (key === "clip") {
          const [s, labels] = await Promise.all([this.session("clip", FILES.clip), this.json(FILES.clipLabels)]);
          m = new ClipClassifier(ort, s, labels);
        } else if (key === "ner") {
          const [s, tok, cfg] = await Promise.all([
            this.session("ner", FILES.ner, { preferGpu: false }),
            this.json(FILES.nerTok),
            this.json(FILES.nerCfg),
          ]);
          m = new PiiNer(ort, s, tok, cfg);
        } else if (key === "ocr") {
          m = new OcrEngine(this.urlFor); // owns its own Tesseract.js Worker, not an ORT session
        }
        this.models[key] = m;
        return m;
      })().catch((e) => {
        delete this.loading[key];
        throw e;
      });
    }
    return this.loading[key];
  }

  time(name, ms) {
    const c = (this.stats.calls[name] ??= { n: 0, totalMs: 0, lastMs: 0 });
    c.n++;
    c.totalMs += ms;
    c.lastMs = Math.round(ms);
  }

  async warmup(keys = ["face", "clip", "ner"]) {
    await Promise.all(keys.map((k) => this.load(k).catch((e) => console.warn("[perception] warmup", k, e))));
    return this.getStats();
  }

  getStats() {
    const mem = performance.memory
      ? { jsHeapUsedMB: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1), jsHeapTotalMB: +(performance.memory.totalJSHeapSize / 1e6).toFixed(1) }
      : null;
    const modelMB = Object.values(this.stats.models).reduce((a, m) => a + m.bytes, 0) / 1e6;
    return { ...this.stats, modelMB: +modelMB.toFixed(1), memory: mem };
  }

  // --- NER --------------------------------------------------------------------

  /** @returns {Promise<Array<Array<span>>>} spans per input string (cached). */
  async ner(texts) {
    const out = new Array(texts.length);
    const todo = [];
    texts.forEach((t, i) => {
      const hit = this.nerCache.get(t);
      if (hit) {
        out[i] = hit;
        this.stats.cache.ner++;
      } else todo.push(i);
    });
    if (todo.length) {
      const t0 = performance.now();
      const ner = await this.load("ner");
      const uniq = [...new Set(todo.map((i) => texts[i]))];
      const res = await ner.tagBatch(uniq);
      uniq.forEach((t, k) => this.nerCache.set(t, res[k]));
      todo.forEach((i) => (out[i] = this.nerCache.get(texts[i])));
      this.time("ner", performance.now() - t0);
      this.stats.lastNerStrings = uniq.length;
    }
    return out;
  }

  // --- vision -----------------------------------------------------------------

  async decode(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const c = typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height }) : new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { bmp, img: { data: id.data, width: bmp.width, height: bmp.height } };
  }

  /**
   * @param {object} p
   * @param {string} p.screenshot  data URL (raw pixels — never leaves this document)
   * @param {{w,h}}  p.viewport    CSS px viewport; scale = screenshot px / CSS px
   * @param {Array<{id,x,y,w,h}>} p.rois  image-like regions, viewport CSS px
   * @param {"eco"|"balanced"|"max"} [p.mode]
   */
  async analyze({ screenshot, viewport, rois = [], mode = "balanced", pageKey = null, fullFrame = false, features = null }) {
    const T = { start: performance.now() };
    const { img } = await this.decode(screenshot);
    T.decode = performance.now();
    const scale = viewport?.w ? img.width / viewport.w : 1;
    const hash = dHash(img);
    const roiSig = rois.map((r) => `${r.id}:${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}`).join("|");

    if (this.lastFrame && hamming(hash, this.lastFrame.hash) <= 3 && roiSig === this.lastFrame.roiSig && mode === this.lastFrame.mode) {
      this.stats.cache.frame++;
      return { ...this.lastFrame.result, cacheHit: true, timings: { totalMs: Math.round(performance.now() - T.start) } };
    }

    // faces: every image ROI is covered — small ones packed into ONE mosaic pass,
    // large ones cropped (cached by content). The full-frame pass only runs when
    // pixels may hold faces outside any enumerable element (iframes) or in "max".
    const face = await this.load("face");
    const t1 = performance.now();
    let faces = [];
    const devRois = rois
      .map((r) => ({ ...r, dx: r.x * scale, dy: r.y * scale, dw: r.w * scale, dh: r.h * scale }))
      .filter((r) => r.dw >= 16 && r.dh >= 16);
    if (fullFrame || mode === "max" || !devRois.length) {
      faces = (await face.detect(img, { scoreThresh: 0.5 })).map((f) => ({ ...f, via: "frame" }));
    }
    const large = devRois.filter((r) => Math.max(r.dw, r.dh) > CELL * 2).sort((a, b) => b.dw * b.dh - a.dw * a.dh).slice(0, 3);
    for (const r of large) {
      const c = crop(img, { x: r.dx, y: r.dy, w: r.dw, h: r.dh });
      const key = `${dHash(c)}:${c.width}x${c.height}`;
      let dets = this.faceCache.get(key);
      if (!dets) {
        dets = await face.detect(c, { scoreThresh: 0.5 });
        this.faceCache.set(key, dets);
      }
      for (const d of dets) faces.push({ ...d, x: d.x + c.offsetX, y: d.y + c.offsetY, via: "roi", roiId: r.id });
    }
    const small = devRois.filter((r) => Math.max(r.dw, r.dh) <= CELL * 2).sort((a, b) => b.dw * b.dh - a.dw * a.dh).slice(0, 16);
    if (small.length) {
      const { mosaic, cells } = this.buildMosaic(img, small);
      const mdets = await face.detect(mosaic, { scoreThresh: 0.5 });
      for (const d of mdets) {
        const cx = d.x + d.w / 2;
        const cy = d.y + d.h / 2;
        const cell = cells.find((c) => cx >= c.mx && cx < c.mx + c.mw && cy >= c.my && cy < c.my + c.mh);
        if (!cell) continue;
        faces.push({
          x: cell.r.dx + (d.x - cell.mx) / cell.s,
          y: cell.r.dy + (d.y - cell.my) / cell.s,
          w: d.w / cell.s,
          h: d.h / cell.s,
          score: d.score,
          via: "roi-mosaic",
          roiId: cell.r.id,
        });
      }
    }
    faces = dedupe(faces);
    this.time("faces", performance.now() - t1);
    T.faces = performance.now();

    // One batched CLIP run covers: the screen-state frame (once per page) + every
    // uncached image ROI that YuNet did NOT already explain as a face.
    let screen = null;
    const regions = [];
    if (mode !== "eco") {
      const t2 = performance.now();
      const clip = await this.load("clip");
      const sensitiveSet = clip.sets.region.sensitive;
      screen = pageKey ? this.screenCache.get(pageKey) : null;
      // an ROI is "explained" as a face photo only when the face dominates it (avatar,
      // profile picture); a large image with a small face (ID card, group photo)
      // still gets classified — the face itself is boxed either way
      const faceArea = new Map();
      for (const f of faces) if (f.roiId) faceArea.set(f.roiId, (faceArea.get(f.roiId) || 0) + f.w * f.h);
      const faceRoi = new Set(devRois.filter((r) => (faceArea.get(r.id) || 0) >= 0.2 * r.dw * r.dh).map((r) => r.id));
      const batch = [];
      const pending = [];
      if (!screen) batch.push({ kind: "screen", img });
      const cand = devRois.filter((r) => r.dw >= 40 && r.dh >= 40).sort((a, b) => b.dw * b.dh - a.dw * a.dh).slice(0, 12);
      for (const r of cand) {
        if (faceRoi.has(r.id)) {
          regions.push({ id: r.id, label: "face_photo", confidence: 1, sensitive: true, source: "yunet", x: r.dx, y: r.dy, w: r.dw, h: r.dh });
          continue;
        }
        const c = crop(img, { x: r.dx, y: r.dy, w: r.dw, h: r.dh });
        const key = `${dHash(c)}:${Math.round((r.dw / r.dh) * 10)}`;
        const cached = this.regionCache.get(key);
        if (cached) {
          this.stats.cache.region++;
          pending.push({ r, cls: cached });
        } else if (batch.length < (mode === "max" ? 12 : MAX_REGION_CLIP + 1)) {
          batch.push({ kind: "region", img: c, r, key });
        } else if (r.domHint) {
          pending.push({ r, cls: null }); // over budget: DOM semantics still apply
        }
      }
      const embs = await clip.embedBatch(batch.map((b) => b.img));
      batch.forEach((b, i) => {
        if (b.kind === "screen") {
          screen = clip.classify(embs[i], "screen");
          if (pageKey) this.screenCache.set(pageKey, screen);
        } else {
          const cls = clip.classify(embs[i], "region");
          this.regionCache.set(b.key, cls);
          pending.push({ r: b.r, cls });
        }
      });
      for (const { r, cls } of pending) {
        // vision: top class sensitive, or the sensitive classes jointly dominate;
        // DOM: alt/aria/filename semantics (fused — either source can flag)
        const pSensitive = cls ? cls.all.filter((c) => sensitiveSet.includes(c.id)).reduce((a, c) => a + c.p, 0) : 0;
        const byVision = !!cls && ((sensitiveSet.includes(cls.top) && cls.confidence >= REGION_SENSITIVE_MIN_P) || pSensitive >= 0.5);
        const byDom = !!r.domHint;
        const label = byVision || !byDom ? cls?.top ?? "image" : r.domHint;
        regions.push({ id: r.id, label, confidence: cls?.confidence ?? 0, sensitive: byVision || byDom, source: byVision ? (byDom ? "vision+dom" : "vision") : byDom ? "dom" : "vision", x: r.dx, y: r.dy, w: r.dw, h: r.dh });
      }
      if (batch.length) this.time("clip", performance.now() - t2);
      this.stats.lastClipBatch = batch.length;
    }
    T.screen = T.faces;
    T.regions = performance.now();

    // A1: on-device OCR — text drawn in PIXELS (scanned ID cards, PDF pages, canvas
    // apps) that the DOM text layer structurally cannot see. Only regions that can
    // never hold DOM text (img/canvas/object/embed), only when the mode budget
    // allows it (same tier as CLIP), and cached by region content hash exactly like
    // face/region classification — an unchanged crop is not re-OCR'd.
    let ocrSpans = [];
    if (mode !== "eco") {
      const t3 = performance.now();
      const candidates = devRois
        .filter((r) => OCR_ROI_KINDS.has(r.kind) && r.dw >= OCR_MIN_SIZE && r.dh >= OCR_MIN_SIZE)
        .sort((a, b) => b.dw * b.dh - a.dw * a.dh);
      let newOcrRuns = 0;
      let ocrError = null;
      for (const r of candidates) {
        const c = crop(img, { x: r.dx, y: r.dy, w: r.dw, h: r.dh });
        const key = `${dHash(c)}:${c.width}x${c.height}`;
        let spans = this.ocrCache.get(key);
        if (!spans) {
          if (newOcrRuns >= MAX_OCR_REGIONS) continue; // over budget this frame — try again once cached elsewhere
          const ocr = await this.load("ocr");
          const t4 = performance.now();
          spans = [];
          try {
            const { words } = await ocr.recognize(c);
            if (words.length) {
              const { text, offsets } = joinOcrWords(words);
              // NER for the same reason the DOM text layer needs it: a bare name
              // ("Rohan Mehta") has no rule-based signal in English, only the model.
              const nerTag = async (t) => (await this.ner([t]))[0];
              spans = mapSpansToWordBoxes(await detectSpans(text, { nerTag }), offsets);
            }
          } catch (e) {
            ocrError = String(e?.message || e);
          }
          this.time("ocr", performance.now() - t4);
          newOcrRuns++;
          this.ocrCache.set(key, spans);
        }
        for (const s of spans) ocrSpans.push({ ...s, x: s.x + c.offsetX, y: s.y + c.offsetY });
      }
      if (newOcrRuns) this.stats.lastOcrRegions = newOcrRuns;
      if (ocrError) this.stats.lastOcrError = ocrError;
      T.ocr = performance.now();
    } else {
      T.ocr = T.regions;
    }

    const result = {
      ep: this.ep,
      scale,
      imageSize: { w: img.width, h: img.height },
      // pixels (MobileCLIP zero-shot) x structure (DOM counts): 56% -> 73% on unseen sites
      screen: screen && (() => {
        const f = fuseScreen(screen.all, features);
        return { state: f.top, category: COARSE_OF[f.top], confidence: f.confidence, probs: f.probs, pixelsOnly: screen.top, cues: f.cues };
      })(),
      faces: faces.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h), score: f.score, via: f.via })),
      regions,
      ocrSpans,
      cacheHit: false,
      timings: {
        decodeMs: Math.round(T.decode - T.start),
        facesMs: Math.round(T.faces - T.decode),
        clipMs: Math.round(T.regions - T.faces),
        ocrMs: Math.round(T.ocr - T.regions),
        totalMs: Math.round(T.ocr - T.start),
      },
    };
    this.lastFrame = { hash, roiSig, mode, result };
    return result;
  }

  buildMosaic(img, rois) {
    const S = 640;
    const data = new Uint8ClampedArray(S * S * 4);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const cells = [];
    rois.forEach((r, i) => {
      const gx = (i % 4) * CELL;
      const gy = Math.floor(i / 4) * CELL;
      const c = crop(img, { x: r.dx, y: r.dy, w: r.dw, h: r.dh });
      const s = Math.min(CELL / c.width, CELL / c.height);
      const w = Math.max(1, Math.floor(c.width * s));
      const h = Math.max(1, Math.floor(c.height * s));
      const rs = resize(c, w, h);
      for (let y = 0; y < h; y++) data.set(rs.data.subarray(y * w * 4, (y + 1) * w * 4), ((gy + y) * S + gx) * 4);
      cells.push({ r: { ...r, dx: c.offsetX, dy: c.offsetY }, mx: gx, my: gy, mw: w, mh: h, s });
    });
    return { mosaic: { data, width: S, height: S }, cells };
  }

  // --- redaction ----------------------------------------------------------------

  /**
   * Paint opaque boxes (never blur — blur is partly invertible) and, optionally,
   * Set-of-Marks labels for interactive elements. Everything in device pixels.
   * @param {object} p
   * @param {Array<{x,y,w,h,label?}>} p.boxes
   * @param {Array<{id,label,x,y,w,h}>} [p.marks]
   * @param {number} [p.maxWidth]  downscale the OUTGOING image (latency)
   */
  async redact({ screenshot, boxes = [], marks = [], maxWidth = 1280, quality = 0.8 }) {
    const t0 = performance.now();
    const bmp = await createImageBitmap(await (await fetch(screenshot)).blob());
    const k = Math.min(1, maxWidth / bmp.width);
    const W = Math.round(bmp.width * k);
    const H = Math.round(bmp.height * k);
    // A DOM canvas encodes synchronously; OffscreenCanvas.convertToBlob in a hidden
    // (offscreen/background) document waits on throttled frames (~1 s measured).
    const c = typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: W, height: H }) : new OffscreenCanvas(W, H);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, W, H);

    // marks first, so a redaction box always paints over a mark that overlaps it
    ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.font = `bold ${Math.max(9, Math.round(11 * k))}px sans-serif`;
    ctx.textBaseline = "top";
    for (const m of marks) {
      const x = m.x * k, y = m.y * k, w = m.w * k, h = m.h * k;
      ctx.strokeStyle = "#e0118a";
      ctx.strokeRect(x, y, w, h);
      const tw = ctx.measureText(m.label).width + 4;
      ctx.fillStyle = "#e0118a";
      ctx.fillRect(x, Math.max(0, y - 12 * k), tw, 12 * k);
      ctx.fillStyle = "#fff";
      ctx.fillText(m.label, x + 2, Math.max(0, y - 12 * k) + 1);
    }

    let painted = 0;
    for (const b of boxes) {
      const pad = b.pad ?? 2;
      const x = (b.x - pad) * k, y = (b.y - pad) * k, w = (b.w + 2 * pad) * k, h = (b.h + 2 * pad) * k;
      if (w <= 0 || h <= 0) continue;
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      painted++;
      // typed visual token, same vocabulary as the text tokens ("EMAIL_1", "FACE")
      if (b.label && h >= 9) {
        const fs = Math.max(7, Math.min(h * 0.62, 12 * k));
        ctx.font = `${fs}px monospace`;
        ctx.fillStyle = "#fff";
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.fillText(b.label, x + 2, y + (h - fs) / 2);
        ctx.restore();
      }
    }
    const dataUrl = c.toDataURL ? c.toDataURL("image/jpeg", quality) : await blobToDataUrl(await c.convertToBlob({ type: "image/jpeg", quality }));
    const bytes = Math.round(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
    this.time("redact", performance.now() - t0);
    return { dataUrl, painted, width: W, height: H, bytes, ms: Math.round(performance.now() - t0) };
  }

  /** Dispatch for message hosts. */
  async handle(op, p = {}) {
    switch (op) {
      case "ner":
        return { spans: await this.ner(p.texts || []) };
      case "analyze":
        return await this.analyze(p);
      case "redact":
        return await this.redact(p);
      case "warmup":
        return await this.warmup(p.keys);
      case "stats":
        return this.getStats();
      case "memory":
        // full memory of this document incl. WASM heaps + model weights (needs
        // cross-origin isolation, which the manifest enables); JS-heap fallback otherwise
        if (globalThis.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
          const m = await performance.measureUserAgentSpecificMemory();
          return { totalMB: +(m.bytes / 1e6).toFixed(1), method: "measureUserAgentSpecificMemory" };
        }
        return { totalMB: this.getStats().memory?.jsHeapUsedMB ?? null, method: "performance.memory (JS heap only)" };
      default:
        throw new Error(`unknown perception op ${op}`);
    }
  }
}

/** Merge duplicate detections of the same face (frame pass vs ROI pass): keep the union box. */
function dedupe(faces) {
  const out = [];
  for (const f of faces.sort((a, b) => b.score - a.score)) {
    const hit = out.find((o) => {
      const ix = Math.max(0, Math.min(o.x + o.w, f.x + f.w) - Math.max(o.x, f.x));
      const iy = Math.max(0, Math.min(o.y + o.h, f.y + f.h) - Math.max(o.y, f.y));
      return ix * iy > 0.3 * Math.min(o.w * o.h, f.w * f.h);
    });
    if (!hit) out.push({ ...f });
    else {
      const x2 = Math.max(hit.x + hit.w, f.x + f.w);
      const y2 = Math.max(hit.y + hit.h, f.y + f.h);
      hit.x = Math.min(hit.x, f.x);
      hit.y = Math.min(hit.y, f.y);
      hit.w = x2 - hit.x;
      hit.h = y2 - hit.y;
    }
  }
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
