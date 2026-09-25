// On-device OCR — PP-OCRv4 (DBNet detection + CRNN/CTC recognition).
//
// Detection model:  ch_PP-OCRv4_det_infer.onnx
//   Input:  session.inputNames[0]   [1, 3, H, W]  float32, CHW, H/W = multiples of 32
//   Output: session.outputNames[0]  [1, 1, H, W]  float32 sigmoid probability map
//   Normalization: ImageNet mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]
//
// Recognition model: ch_PP-OCRv4_rec_infer.onnx
//   Input:  session.inputNames[0]   [1, 3, 48, W]  float32, CHW
//   Output: session.outputNames[0]  [1, T, 6625]  float32 softmax logits
//   Normalization: mean=0.5, std=0.5 (PP-OCR rec standard)
//
// Character dictionary: ppocr_keys_v1.txt (6623 chars) + space (class 6624).
//   CTC blank = index 0; character at dict line k -> logit index k+1; index 6624 = ' '.
//   Loaded at construction time and passed in as charset array.
//
// No placeholder text, no fake OCR, no full-ROI single box.
// Each detected box is individually cropped and recognized.

import { resize, crop } from './image.js';
import { detectSpans } from '../redact.js';

// --- Normalization constants ---

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD  = [0.229, 0.224, 0.225];

const REC_MEAN = 0.5;
const REC_STD  = 0.5;

const DET_LIMIT  = 960;
const DET_STRIDE = 32;
const DET_MIN    = 32;

const REC_H = 48;
const REC_W = 320;

const DET_SCORE_THRESH = 0.3;
const DET_BOX_THRESH   = 0.5;
const DET_MIN_AREA     = 16;
const DET_UNCLIP_RATIO = 1.5;

// --- Preprocessing helpers ---

function resizeForDetection(img) {
  const scale = Math.min(1, DET_LIMIT / Math.max(img.width, img.height));
  const nw = Math.min(DET_LIMIT, Math.max(DET_STRIDE, Math.round(img.width  * scale / DET_STRIDE) * DET_STRIDE));
  const nh = Math.min(DET_LIMIT, Math.max(DET_STRIDE, Math.round(img.height * scale / DET_STRIDE) * DET_STRIDE));
  return { img: resize(img, nw, nh), scaleX: img.width / nw, scaleY: img.height / nh };
}

function rgbaToCHW(img, mean, std) {
  const d = img.data, n = img.width * img.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[          i] = (d[p    ] / 255 - mean[0]) / std[0];
    out[    n + i  ] = (d[p + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i  ] = (d[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

function rgbaToCHWScalar(img, mean, std) {
  const d = img.data, n = img.width * img.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[          i] = (d[p    ] / 255 - mean) / std;
    out[    n + i  ] = (d[p + 1] / 255 - mean) / std;
    out[2 * n + i  ] = (d[p + 2] / 255 - mean) / std;
  }
  return out;
}

// --- DBNet postprocessing ---

function decodeDetMap(mapData, mapH, mapW, origH, origW, scaleX, scaleY) {
  const binary = new Uint8Array(mapH * mapW);
  for (let i = 0; i < mapH * mapW; i++) {
    binary[i] = mapData[i] >= DET_SCORE_THRESH ? 1 : 0;
  }

  const label = new Int32Array(mapH * mapW).fill(-1);
  const boxes = [];
  const stack = [];

  for (let sy = 0; sy < mapH; sy++) {
    for (let sx = 0; sx < mapW; sx++) {
      const si = sy * mapW + sx;
      if (!binary[si] || label[si] >= 0) continue;

      const compId = boxes.length;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;

      stack.push(si);
      label[si] = compId;

      while (stack.length > 0) {
        const idx = stack.pop();
        const cy = (idx / mapW) | 0;
        const cx = idx % mapW;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cy > 0        && binary[idx - mapW] && label[idx - mapW] < 0) { label[idx - mapW] = compId; stack.push(idx - mapW); }
        if (cy < mapH - 1 && binary[idx + mapW] && label[idx + mapW] < 0) { label[idx + mapW] = compId; stack.push(idx + mapW); }
        if (cx > 0        && binary[idx - 1]    && label[idx - 1]    < 0) { label[idx - 1]    = compId; stack.push(idx - 1);    }
        if (cx < mapW - 1 && binary[idx + 1]    && label[idx + 1]    < 0) { label[idx + 1]    = compId; stack.push(idx + 1);    }
      }

      let rectSum = 0, rectCnt = 0;
      for (let ry = minY; ry <= maxY; ry++) {
        for (let rx = minX; rx <= maxX; rx++) {
          rectSum += mapData[ry * mapW + rx];
          rectCnt++;
        }
      }
      const boxScore = rectCnt > 0 ? rectSum / rectCnt : 0;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (boxScore < DET_BOX_THRESH || (bw * scaleX) * (bh * scaleY) < DET_MIN_AREA) continue;

      const dist = Math.round((bw * bh) * DET_UNCLIP_RATIO / (2 * (bw + bh)));
      boxes.push({
        x:     Math.round(Math.max(0,        minX - dist) * scaleX),
        y:     Math.round(Math.max(0,        minY - dist) * scaleY),
        w:     Math.round((Math.min(mapW - 1, maxX + dist) - Math.max(0, minX - dist) + 1) * scaleX),
        h:     Math.round((Math.min(mapH - 1, maxY + dist) - Math.max(0, minY - dist) + 1) * scaleY),
        score: +boxScore.toFixed(4),
      });
    }
  }
  return boxes;
}

// --- CTC greedy decoder ---

function ctcDecode(logits, T, V, charset) {
  const chars = [];
  let lastIdx = -1;
  for (let t = 0; t < T; t++) {
    let bestIdx = 0, bestVal = logits[t * V];
    for (let v = 1; v < V; v++) {
      if (logits[t * V + v] > bestVal) { bestVal = logits[t * V + v]; bestIdx = v; }
    }
    if (bestIdx !== 0 && bestIdx !== lastIdx) {
      const ch = charset[bestIdx - 1];
      if (ch !== undefined) chars.push(ch);
    }
    lastIdx = bestIdx;
  }
  return chars.join('');
}

// --- OCR Engine ---

export class OcrEngine {
  /**
   * @param {object}   ort        onnxruntime module (web or node)
   * @param {object}   detSession InferenceSession for DBNet detection
   * @param {object}   recSession InferenceSession for CRNN recognition
   * @param {string[]} charset    ppocr_keys_v1.txt split into per-char array (6623 entries)
   *                              charset[k] is the character for logit index k+1
   */
  constructor(ort, detSession, recSession, charset) {
    this.ort     = ort;
    this.det     = detSession;
    this.rec     = recSession;
    this.charset = charset;
  }

  /**
   * Run full OCR on a pixel region buffer.
   * @param {{data: Uint8ClampedArray, width: number, height: number}} img
   * @returns {Promise<Array<{text: string, bbox: {x,y,w,h}, score: number}>>}
   */
  async run(img) {
    if (img.width < DET_MIN || img.height < DET_MIN) return [];

    // 1. Text detection
    const det = resizeForDetection(img);
    const detTensor = rgbaToCHW(det.img, DET_MEAN, DET_STD);
    const detInName  = this.det.inputNames[0];
    const detOutName = this.det.outputNames[0];
    const detOut = await this.det.run({
      [detInName]: new this.ort.Tensor('float32', detTensor, [1, 3, det.img.height, det.img.width]),
    });
    const detMap = detOut[detOutName];
    if (!detMap || !detMap.data) return [];

    const mapH = detMap.dims[2];
    const mapW = detMap.dims[3];

    // 2. Box decoding
    const boxes = decodeDetMap(detMap.data, mapH, mapW, img.height, img.width, det.scaleX, det.scaleY);
    if (!boxes.length) return [];

    // 3. Recognition — each box individually
    const recInName  = this.rec.inputNames[0];
    const recOutName = this.rec.outputNames[0];
    const results    = [];

    for (const box of boxes) {
      const x0 = Math.max(0, box.x);
      const y0 = Math.max(0, box.y);
      const cw = Math.max(1, Math.min(img.width,  box.x + box.w) - x0);
      const ch = Math.max(1, Math.min(img.height, box.y + box.h) - y0);

      const cropImg  = crop(img, { x: x0, y: y0, w: cw, h: ch });
      const targetW  = Math.min(REC_W, Math.max(1, Math.round((cw / ch) * REC_H)));
      const resized  = resize(cropImg, targetW, REC_H);

      let paddedImg;
      if (targetW >= REC_W) {
        paddedImg = resized;
      } else {
        const padBuf = new Uint8ClampedArray(REC_H * REC_W * 4);
        for (let ry = 0; ry < REC_H; ry++) {
          padBuf.set(resized.data.subarray(ry * targetW * 4, (ry + 1) * targetW * 4), ry * REC_W * 4);
        }
        paddedImg = { data: padBuf, width: REC_W, height: REC_H };
      }

      const recTensor = rgbaToCHWScalar(paddedImg, REC_MEAN, REC_STD);
      let recOut;
      try {
        recOut = await this.rec.run({
          [recInName]: new this.ort.Tensor('float32', recTensor, [1, 3, REC_H, REC_W]),
        });
      } catch (e) {
        console.warn('[ocr] rec failed', box, e);
        continue;
      }
      const recLogits = recOut[recOutName];
      if (!recLogits || !recLogits.data) continue;

      const T = recLogits.dims[1];
      const V = recLogits.dims[2];
      const text = ctcDecode(recLogits.data, T, V, this.charset);
      if (!text) continue;

      results.push({ text, bbox: { x: x0, y: y0, w: cw, h: ch }, score: box.score });
    }
    return results;
  }

  /**
   * Run OCR and pass each recognized line through the EXISTING detectSpans().
   * Returns only lines where PII was found, with ROI-local bounding boxes.
   *
   * detectSpans() is called exactly as the DOM-text pipeline does —
   * NOT rewritten, NOT duplicated; just called.
   *
   * @param {{data: Uint8ClampedArray, width: number, height: number}} img
   * @param {{ nerTag?: Function, known?: Array }} [opts]
   * @returns {Promise<Array<{text, bbox, score, piiSpans}>>}
   */
  async runAndDetectPii(img, opts) {
    const nerTag = opts && opts.nerTag;
    const known  = (opts && opts.known) || [];
    const lines  = await this.run(img);
    if (!lines.length) return [];

    const piiLines = [];
    for (const line of lines) {
      const spans = await detectSpans(line.text, { nerTag: nerTag, known: known });
      if (spans.length > 0) {
        piiLines.push({ text: line.text, bbox: line.bbox, score: line.score, piiSpans: spans });
      }
    }
    return piiLines;
  }
}

export default OcrEngine;