// Pure-JS image ops on RGBA buffers ({data, width, height}). Deliberately canvas-free
// so the exact same preprocessing runs in the extension (offscreen doc / Firefox
// background page) and in Node eval — the eval numbers describe the shipped code.

/** Bilinear resize of an RGBA image. */
export function resize(img, w, h) {
  const { data, width: sw, height: sh } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const xr = sw / w;
  const yr = sh / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, (y + 0.5) * yr - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, (x + 0.5) * xr - 0.5);
      const x0 = Math.min(sw - 1, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * w + x) * 4;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
        const bot = data[c + k] + (data[d + k] - data[c + k]) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Crop (clamped to bounds). Box in source pixels. */
export function crop(img, { x, y, w, h }) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  const cw = Math.max(1, x1 - x0);
  const ch = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let r = 0; r < ch; r++) {
    const src = ((y0 + r) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + cw * 4), r * cw * 4);
  }
  return { data: out, width: cw, height: ch, offsetX: x0, offsetY: y0 };
}

/**
 * 64-bit difference hash (9x8 grayscale). Two frames with Hamming distance ≤ 4 are
 * treated as "same screen" so vision results can be reused — the main lever for
 * client-side compute: most agent steps don't change the pixels much.
 */
export function dHash(img) {
  const s = resize(img, 9, 8);
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = (y * 9 + x) * 4;
      const b = a + 4;
      const la = s.data[a] * 0.299 + s.data[a + 1] * 0.587 + s.data[a + 2] * 0.114;
      const lb = s.data[b] * 0.299 + s.data[b + 1] * 0.587 + s.data[b + 2] * 0.114;
      bits += la > lb ? "1" : "0";
    }
  }
  return bits;
}

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}
