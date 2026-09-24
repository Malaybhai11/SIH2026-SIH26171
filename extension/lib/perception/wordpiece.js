// Minimal BERT (uncased) WordPiece tokenizer that keeps character offsets.
//
// Offsets are the whole point: NER spans must map back to exact character ranges in
// the ORIGINAL text so the content script can (a) tokenize the payload and (b) turn
// the span into pixel rectangles via Range.getClientRects() for screenshot redaction.
// A generic tokenizer library would need a second alignment pass; this one doesn't.
//
// Mirrors HF `BertNormalizer(lowercase, strip_accents=None→follow lowercase)` +
// `BertPreTokenizer` + `WordPiece(##, max_input_chars_per_word=100)`.

const PUNCT_RE = /[\p{P}\p{S}]/u;
const MARK_RE = /\p{Mn}/u;
const WS_RE = /\s/u;
const CTRL_RE = /[\p{Cc}\p{Cf}]/u;

function isCjk(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

export class WordPiece {
  /** @param {object} tokenizerJson parsed HF tokenizer.json */
  constructor(tokenizerJson) {
    const m = tokenizerJson.model;
    this.vocab = new Map(Object.entries(m.vocab));
    this.unk = m.unk_token ?? "[UNK]";
    this.prefix = m.continuing_subword_prefix ?? "##";
    this.maxChars = m.max_input_chars_per_word ?? 100;
    this.lowercase = tokenizerJson.normalizer?.lowercase ?? true;
    this.clsId = this.vocab.get("[CLS]");
    this.sepId = this.vocab.get("[SEP]");
    this.padId = this.vocab.get("[PAD]") ?? 0;
    this.unkId = this.vocab.get(this.unk);
  }

  /** Split into words with [start,end) offsets into the original string. */
  words(text) {
    const out = [];
    let cur = "";
    let curStart = -1;
    let lastEnd = -1;
    const flush = () => {
      if (cur) out.push({ word: cur, start: curStart, end: lastEnd });
      cur = "";
      curStart = -1;
    };
    // iterate by code point, tracking UTF-16 index
    let i = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const idx = i;
      i += ch.length;
      if (cp === 0 || cp === 0xfffd || CTRL_RE.test(ch)) {
        if (!WS_RE.test(ch)) continue;
      }
      if (WS_RE.test(ch)) {
        flush();
        continue;
      }
      let norm = ch;
      if (this.lowercase) {
        norm = ch.toLowerCase().normalize("NFD");
        norm = [...norm].filter((c) => !MARK_RE.test(c)).join("");
        if (!norm) continue;
      }
      if (PUNCT_RE.test(ch) || isCjk(cp)) {
        flush();
        out.push({ word: norm, start: idx, end: i });
        continue;
      }
      if (curStart < 0) curStart = idx;
      cur += norm;
      lastEnd = i;
    }
    flush();
    return out;
  }

  /**
   * @returns {{ ids:number[], offsets:Array<[number,number]>, wordIdx:number[] }}
   * offsets/wordIdx are aligned with ids and exclude nothing: special tokens get
   * [-1,-1] / -1. Continuation pieces share their word's index.
   */
  encode(text, maxLen = 512) {
    const ids = [this.clsId];
    const offsets = [[-1, -1]];
    const wordIdx = [-1];
    const words = this.words(text);
    for (let w = 0; w < words.length; w++) {
      const { word, start, end } = words[w];
      const pieces = this.wordPieces(word);
      // piece offsets: proportional within the word is good enough for span edges,
      // since entity spans are expanded to whole words anyway.
      for (const p of pieces) {
        if (ids.length >= maxLen - 1) break;
        ids.push(p);
        offsets.push([start, end]);
        wordIdx.push(w);
      }
      if (ids.length >= maxLen - 1) break;
    }
    ids.push(this.sepId);
    offsets.push([-1, -1]);
    wordIdx.push(-1);
    return { ids, offsets, wordIdx, words };
  }

  wordPieces(word) {
    if ([...word].length > this.maxChars) return [this.unkId];
    const out = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = null;
      while (start < end) {
        const sub = (start > 0 ? this.prefix : "") + word.slice(start, end);
        const id = this.vocab.get(sub);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found === null) return [this.unkId];
      out.push(found);
      start = end;
    }
    return out;
  }
}
