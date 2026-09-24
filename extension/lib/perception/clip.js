// Zero-shot visual understanding — MobileCLIP-S0 image tower (FP16, ~23 MB).
//
// Two jobs, one model:
//   1. Screen state: what kind of screen is this (login, checkout, KYC form, feed...)?
//   2. Region semantics: what is in this <img>/<canvas>/<video> region — an identity
//      document? a face photo? a QR code? a signature? a chart? — so sensitive
//      imagery the DOM can't describe gets black-boxed, and harmless imagery gets a
//      short caption the server can use as visual context.
//
// Only the IMAGE tower ships. Prompt ("label") embeddings are computed once at build
// time by scripts/build_clip_labels.mjs with the text tower and stored in
// clip_labels.json — saves 170 MB and a second model load on every client.

import { resize } from "./image.js";

export const CLIP_SIZE = 256;

/** shortest-edge resize to 256, center crop 256, rescale 1/255, CHW RGB. */
export function preprocessClip(img) {
  const S = CLIP_SIZE;
  const scale = S / Math.min(img.width, img.height);
  const w = Math.max(S, Math.round(img.width * scale));
  const h = Math.max(S, Math.round(img.height * scale));
  const r = resize(img, w, h);
  const ox = Math.floor((w - S) / 2);
  const oy = Math.floor((h - S) / 2);
  const chw = new Float32Array(3 * S * S);
  const plane = S * S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = ((y + oy) * w + (x + ox)) * 4;
      const o = y * S + x;
      chw[o] = r.data[i] / 255;
      chw[plane + o] = r.data[i + 1] / 255;
      chw[2 * plane + o] = r.data[i + 2] / 255;
    }
  }
  return chw;
}

function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

export class ClipClassifier {
  /**
   * @param {object} ort
   * @param {object} session  vision tower session
   * @param {object} labels   clip_labels.json: { logitScale, sets: { name: { classes:[{id, emb, sensitive?}] } } }
   */
  constructor(ort, session, labels) {
    this.ort = ort;
    this.session = session;
    this.logitScale = labels.logitScale ?? 100;
    this.sets = labels.sets;
  }

  async embed(img) {
    const chw = preprocessClip(img);
    const t = new this.ort.Tensor("float32", chw, [1, 3, CLIP_SIZE, CLIP_SIZE]);
    const out = await this.session.run({ [this.session.inputNames[0]]: t });
    const e = out.image_embeds ?? out[this.session.outputNames[0]];
    return l2norm(e.data);
  }

  /** Classify an embedding against a label set. Classes with several prompts are max-pooled. */
  classify(emb, setName) {
    const set = this.sets[setName];
    const byClass = new Map();
    for (const c of set.classes) {
      let dot = 0;
      for (let i = 0; i < emb.length; i++) dot += emb[i] * c.emb[i];
      const cur = byClass.get(c.id);
      if (cur === undefined || dot > cur) byClass.set(c.id, dot);
    }
    const ids = [...byClass.keys()];
    const logits = ids.map((id) => byClass.get(id) * this.logitScale);
    const m = Math.max(...logits);
    const ex = logits.map((l) => Math.exp(l - m));
    const sum = ex.reduce((a, b) => a + b, 0);
    const probs = ids
      .map((id, i) => ({ id, p: ex[i] / sum }))
      .sort((a, b) => b.p - a.p);
    return { top: probs[0].id, confidence: +probs[0].p.toFixed(3), probs: probs.slice(0, 3), all: probs };
  }

  /** One batched run for several images (dynamic batch dim) — better WASM thread use. */
  async embedBatch(imgs) {
    if (!imgs.length) return [];
    const S = CLIP_SIZE;
    const per = 3 * S * S;
    const data = new Float32Array(per * imgs.length);
    imgs.forEach((im, i) => data.set(preprocessClip(im), i * per));
    const t = new this.ort.Tensor("float32", data, [imgs.length, 3, S, S]);
    const out = await this.session.run({ [this.session.inputNames[0]]: t });
    const e = (out.image_embeds ?? out[this.session.outputNames[0]]).data;
    const D = e.length / imgs.length;
    return imgs.map((_, i) => l2norm(e.subarray(i * D, (i + 1) * D)));
  }

  async classifyImage(img, setName) {
    return this.classify(await this.embed(img), setName);
  }
}
