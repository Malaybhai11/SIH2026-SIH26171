// Visual redaction — paints opaque black rectangles over sensitive regions on an
// offscreen copy of the screenshot BEFORE it can be sent anywhere.
//
// Hard black-box only (no blur): blur is partially reversible via deconvolution.

/**
 * @param {string} screenshotDataUrl  captureVisibleTab PNG data URL
 * @param {Array<{x1,y1,x2,y2}>} boxes  face boxes in natural screenshot pixels
 * @param {Array<{x,y,w,h}>} regionBoxes  extra regions (password/payment fields) in page px
 * @returns {Promise<{ dataUrl: string, painted: number }>}  redacted PNG (base64 data URL)
 */
export async function redactScreenshot(screenshotDataUrl, boxes = [], regionBoxes = []) {
  const blob = await (await fetch(screenshotDataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  ctx.fillStyle = "#000";
  let painted = 0;

  for (const b of boxes) {
    const w = b.x2 - b.x1;
    const h = b.y2 - b.y1;
    if (w > 0 && h > 0) {
      // pad 15% so redaction survives slightly loose boxes
      const px = w * 0.15;
      const py = h * 0.15;
      ctx.fillRect(b.x1 - px, b.y1 - py, w + 2 * px, h + 2 * py);
      painted++;
    }
  }
  for (const r of regionBoxes) {
    if (r.w > 0 && r.h > 0) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
      painted++;
    }
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return { dataUrl: `data:image/png;base64,${btoa(bin)}`, painted };
}

/** Bare base64 (no `data:` prefix) for the API payload. */
export function stripDataUrlPrefix(dataUrl) {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}
