// On-device OCR (A1) — reads text drawn in PIXELS: scanned ID cards, PDFs
// rendered to canvas, screenshots pasted into a form, Figma/Docs-style canvas
// apps. The DOM-text layer (redact.js + domExtractor.js) never sees this text at
// all, so without OCR a photographed Aadhaar card leaks in full.
//
// Engine: Tesseract.js (WASM, LSTM-only English model) — same "load once, share
// across calls, never fetch remotely after install" pattern as the other models
// in this directory (ner.js, clip.js, faces.js), just with its own worker instead
// of an onnxruntime-web session (Tesseract.js manages its own Worker + WASM core).
//
// Runs ONLY on regions the DOM extractor found no text in (image/canvas ROIs,
// PDF-viewer embeds) — see engine.js's caller. A region that already has DOM
// text is handled by the (much cheaper) text layer instead.

let tesseractApi = null;
async function loadTesseractApi(urlFor) {
  if (tesseractApi) return tesseractApi;
  const mod = await import(/* webpackIgnore: true */ urlFor("tesseract/tesseract.esm.min.js"));
  tesseractApi = mod.default; // the ESM build's only export is the whole Tesseract namespace
  return tesseractApi;
}

export class OcrEngine {
  constructor(urlFor) {
    this.urlFor = urlFor;
    this.worker = null;
    this.loading = null;
    this.stats = { loadMs: 0, calls: 0, totalMs: 0 };
  }

  async ensureWorker() {
    if (this.worker) return this.worker;
    if (!this.loading) {
      this.loading = (async () => {
        const { createWorker } = await loadTesseractApi(this.urlFor);
        const t0 = performance.now();
        const worker = await createWorker("eng", 1 /* OEM.LSTM_ONLY */, {
          workerPath: this.urlFor("tesseract/worker.min.js"),
          corePath: this.urlFor("tesseract/tesseract-core-simd-lstm.js"),
          langPath: this.urlFor("models/tesseract/"),
          // A blob-URL worker would be blocked by this extension's CSP
          // (script-src 'self') — load the worker script directly instead.
          workerBlobURL: false,
          logger: () => {},
        });
        this.stats.loadMs = Math.round(performance.now() - t0);
        this.worker = worker;
        return worker;
      })().catch((e) => {
        this.loading = null;
        throw e;
      });
    }
    return this.loading;
  }

  /**
   * Recognise text in one cropped region (already device pixels, RGBA).
   * @param {{data:Uint8ClampedArray,width:number,height:number}} crop
   * @returns {Promise<{text:string, words:Array<{text,x,y,w,h,confidence}>}>}
   */
  async recognize(crop) {
    const worker = await this.ensureWorker();
    const t0 = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);

    // tesseract.js v6+ dropped the old flat `data.words` convenience array — word
    // boxes now only come through the nested block -> paragraph -> line -> word
    // tree when `blocks: true` is requested (see tesseract.js's worker-script
    // dump.js: `output.blocks ? JSON.parse(api.GetJSONText()).blocks : null`).
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true, hocr: false, tsv: false });
    this.stats.calls++;
    this.stats.totalMs += performance.now() - t0;

    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            const text = (w.text || "").trim();
            if (!text || w.confidence < 40) continue;
            const { x0, y0, x1, y1 } = w.bbox;
            words.push({ text, confidence: w.confidence, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
          }
        }
      }
    }
    return { text: (data.text || "").trim(), words };
  }

  getStats() {
    return { ...this.stats, avgMs: this.stats.calls ? Math.round(this.stats.totalMs / this.stats.calls) : 0 };
  }

  async terminate() {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

/**
 * Join OCR words into one string with per-word [start,end) offsets — the same
 * string detectSpans() (redact.js) scans, so a PII span's character range can be
 * mapped back to the exact words that make it up (not just "the whole region").
 */
export function joinOcrWords(words) {
  let text = "";
  const offsets = [];
  for (const w of words) {
    if (text) text += " ";
    offsets.push({ start: text.length, end: text.length + w.text.length, word: w });
    text += w.text;
  }
  return { text, offsets };
}

/** PII spans (character ranges on the joined text) -> the word boxes they cover. */
export function mapSpansToWordBoxes(spans, offsets) {
  const boxes = [];
  for (const s of spans) {
    for (const o of offsets) {
      if (o.start < s.end && o.end > s.start) {
        boxes.push({ x: o.word.x, y: o.word.y, w: o.word.w, h: o.word.h, type: s.type, value: o.word.text });
      }
    }
  }
  return boxes;
}
