// Face detection — OpenCV YuNet (2023mar, INT8, ~100 KB). Anchor-free, three strides,
// outputs box + 5 landmarks. Chosen for the resource metric: two orders of magnitude
// smaller than BlazeFace/RetinaFace ports, while detecting faces down to ~10 px.
//
// Input: letterboxed 640x640, BGR, raw 0..255 float, NCHW (cv::dnn::blobFromImage
// defaults — no mean/scale).

import { resize } from "./image.js";

export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32];

/** Letterbox RGBA -> BGR CHW float tensor data. Returns scale/pad to undo it. */
export function preprocessYunet(img) {
  const S = YUNET_SIZE;
  const scale = Math.min(S / img.width, S / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const r = resize(img, w, h);
  const chw = new Float32Array(3 * S * S); // zero padding (black) right/bottom
  const plane = S * S;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * S + x;
      chw[o] = r.data[i + 2]; // B
      chw[plane + o] = r.data[i + 1]; // G
      chw[2 * plane + o] = r.data[i]; // R
    }
  }
  return { chw, scale };
}

export function decodeYunet(out, { scale = 1, scoreThresh = 0.6, nmsThresh = 0.3 } = {}) {
  const S = YUNET_SIZE;
  const dets = [];
  for (const s of STRIDES) {
    const cols = S / s;
    const cls = out[`cls_${s}`].data;
    const obj = out[`obj_${s}`].data;
    const bb = out[`bbox_${s}`].data;
    const n = cls.length;
    for (let i = 0; i < n; i++) {
      const c = Math.min(1, Math.max(0, cls[i]));
      const o = Math.min(1, Math.max(0, obj[i]));
      const score = Math.sqrt(c * o);
      if (score < scoreThresh) continue;
      const r = Math.floor(i / cols);
      const col = i % cols;
      const cx = (col + bb[i * 4]) * s;
      const cy = (r + bb[i * 4 + 1]) * s;
      const w = Math.exp(bb[i * 4 + 2]) * s;
      const h = Math.exp(bb[i * 4 + 3]) * s;
      dets.push({ x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, score });
    }
  }
  return nms(dets, nmsThresh);
}

function nms(dets, thresh) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) {
    let ok = true;
    for (const k of keep) {
      const ix = Math.max(0, Math.min(d.x + d.w, k.x + k.w) - Math.max(d.x, k.x));
      const iy = Math.max(0, Math.min(d.y + d.h, k.y + k.h) - Math.max(d.y, k.y));
      const inter = ix * iy;
      if (inter / (d.w * d.h + k.w * k.h - inter) > thresh) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(d);
  }
  return keep;
}

export class FaceDetector {
  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
  }

  /**
   * @param {{data,width,height}} img RGBA
   * @returns {Promise<Array<{x,y,w,h,score}>>} boxes in img pixels
   */
  async detect(img, opts = {}) {
    const { chw, scale } = preprocessYunet(img);
    const input = new this.ort.Tensor("float32", chw, [1, 3, YUNET_SIZE, YUNET_SIZE]);
    const out = await this.session.run({ [this.session.inputNames[0]]: input });
    return decodeYunet(out, { scale, ...opts }).map((d) => ({
      x: Math.max(0, d.x),
      y: Math.max(0, d.y),
      w: Math.min(img.width, d.x + d.w) - Math.max(0, d.x),
      h: Math.min(img.height, d.y + d.h) - Math.max(0, d.y),
      score: +d.score.toFixed(3),
    }));
  }
}
