// On-device PII NER — BERT-small (4 layers, 512 hidden) fine-tuned for PII entity
// types, INT8-quantized (~29 MB). Catches what regex can't: person names and places.
//
// Environment-agnostic: takes an onnxruntime module (`onnxruntime-web` in the
// extension, `onnxruntime-node` in eval) and a session, so the numbers eval/ reports
// come from exactly this decode path.

import { WordPiece } from "./wordpiece.js";

// label -> our PII type. Everything else (ORGANIZATION, DATE_TIME, TITLE, ...) is
// task-relevant context and is deliberately NOT redacted; structured types (email,
// phone, card, ...) are owned by the checksum-validated regex layer.
const KEEP = {
  PERSON: { type: "NAME", minScore: 0.6 },
  LOCATION: { type: "LOCATION", minScore: 0.6 },
};

// Single-word "entities" that are UI vocabulary, not people/places. BERT-small tags
// isolated field labels ("Aadhaar", "Mobile") as PERSON surprisingly often; country
// names are not identifying and stay as useful context.
const STOP = new Set(
  (
    "aadhaar aadhar adhaar pan upi ifsc gstin otp kyc email e-mail mobile phone name address dob account accounts customer " +
    "login logout signin signup register profile home dashboard settings submit cancel search menu help support payments " +
    "india bharat usa uk china japan europe asia africa america earth moon mars isro nasa pslv gslv chandrayaan gaganyaan " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december today yesterday tomorrow inbox sent drafts spam trash"
  ).split(" "),
);

function softmaxRow(arr, off, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) max = Math.max(max, arr[off + i]);
  let sum = 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(arr[off + i] - max);
    sum += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}

export class PiiNer {
  /**
   * @param {object} ort       onnxruntime module (web or node)
   * @param {object} session   InferenceSession for the token-classification model
   * @param {object} tokenizerJson  parsed tokenizer.json
   * @param {object} config    parsed config.json (id2label)
   */
  constructor(ort, session, tokenizerJson, config) {
    this.ort = ort;
    this.session = session;
    this.tok = new WordPiece(tokenizerJson);
    this.id2label = config.id2label;
    this.numLabels = Object.keys(config.id2label).length;
    this.maxLen = 160; // per chunk; attention cost is quadratic, UI strings are short
    this.chunkWords = 100;
  }

  /** Split text into word-bounded chunks so long paragraphs are fully covered (no truncation). */
  chunk(text) {
    const words = [...text.matchAll(/\S+/g)];
    if (words.length <= this.chunkWords) return [{ text, offset: 0 }];
    const out = [];
    for (let i = 0; i < words.length; i += this.chunkWords) {
      const a = words[i].index;
      const last = words[Math.min(words.length, i + this.chunkWords) - 1];
      out.push({ text: text.slice(a, last.index + last[0].length), offset: a });
    }
    return out;
  }

  /**
   * Tag many strings in padded batches.
   * @param {string[]} texts
   * @returns {Promise<Array<Array<{start,end,type,score,value}>>>} spans per text
   */
  async tagBatch(texts, batchSize = 16) {
    // Names and places carry at least one uppercase letter in real UI text; strings
    // without one skip the model entirely (most of a page: numbers, labels, prose
    // fragments). Long strings are chunked, then spans are shifted back.
    const results = texts.map(() => []);
    const jobs = [];
    texts.forEach((t, i) => {
      if (!t || !/\p{Lu}/u.test(t)) return;
      for (const c of this.chunk(t)) jobs.push({ i, ...c });
    });
    jobs.sort((a, b) => a.text.length - b.text.length); // similar lengths batch with less padding
    const spans = await this.runBatches(jobs.map((j) => j.text), batchSize);
    jobs.forEach((j, k) => {
      for (const sp of spans[k]) results[j.i].push({ ...sp, start: sp.start + j.offset, end: sp.end + j.offset });
    });
    return results;
  }

  async runBatches(texts, batchSize) {
    const results = new Array(texts.length);
    for (let b = 0; b < texts.length; b += batchSize) {
      const slice = texts.slice(b, b + batchSize);
      const encs = slice.map((t) => this.tok.encode(t, this.maxLen));
      const T = Math.max(...encs.map((e) => e.ids.length));
      const B = encs.length;
      const ids = new BigInt64Array(B * T);
      const mask = new BigInt64Array(B * T);
      const types = new BigInt64Array(B * T);
      encs.forEach((e, r) => {
        for (let i = 0; i < T; i++) {
          const v = i < e.ids.length ? e.ids[i] : this.tok.padId;
          ids[r * T + i] = BigInt(v);
          mask[r * T + i] = i < e.ids.length ? 1n : 0n;
        }
      });
      const feeds = {};
      const names = this.session.inputNames;
      if (names.includes("input_ids")) feeds.input_ids = new this.ort.Tensor("int64", ids, [B, T]);
      if (names.includes("attention_mask")) feeds.attention_mask = new this.ort.Tensor("int64", mask, [B, T]);
      if (names.includes("token_type_ids")) feeds.token_type_ids = new this.ort.Tensor("int64", types, [B, T]);
      const out = await this.session.run(feeds);
      const logits = (out.logits ?? out[this.session.outputNames[0]]).data;
      encs.forEach((e, r) => {
        results[b + r] = this.decode(slice[r], e, logits, r * T * this.numLabels);
      });
    }
    return results;
  }

  async tag(text) {
    return (await this.tagBatch([text]))[0];
  }

  decode(text, enc, logits, base) {
    const L = this.numLabels;
    // word-level labels from each word's FIRST sub-token
    const wordLab = new Map();
    for (let i = 0; i < enc.ids.length; i++) {
      const w = enc.wordIdx[i];
      if (w < 0 || wordLab.has(w)) continue;
      const p = softmaxRow(logits, base + i * L, L);
      let best = 0;
      for (let k = 1; k < L; k++) if (p[k] > p[best]) best = k;
      wordLab.set(w, { label: this.id2label[best], score: p[best] });
    }
    const spans = [];
    let cur = null;
    const close = () => {
      if (!cur) return;
      const keep = KEEP[cur.ent];
      const score = cur.scoreSum / cur.n;
      const value = text.slice(cur.start, cur.end);
      const single = !/\s/.test(value.trim());
      if (single && STOP.has(value.toLowerCase().replace(/[^\p{L}-]/gu, ""))) {
        cur = null;
        return;
      }
      if (keep && score >= keep.minScore && /\p{L}{2,}/u.test(value)) {
        spans.push({ start: cur.start, end: cur.end, type: keep.type, score: +score.toFixed(3), value, source: "ner" });
      }
      cur = null;
    };
    for (let w = 0; w < enc.words.length; w++) {
      const lab = wordLab.get(w);
      if (!lab) break; // truncated
      const [bio, ent] = lab.label === "O" ? ["O", null] : lab.label.split(/-(.+)/);
      const word = enc.words[w];
      if (bio === "O") {
        close();
        continue;
      }
      // punctuation inside an entity ("Dr." / "St.") joins it; a new B- or type change splits
      if (cur && cur.ent === ent && bio === "I") {
        cur.end = word.end;
        cur.scoreSum += lab.score;
        cur.n++;
      } else {
        close();
        cur = { ent, start: word.start, end: word.end, scoreSum: lab.score, n: 1 };
      }
    }
    close();
    return spans;
  }
}
