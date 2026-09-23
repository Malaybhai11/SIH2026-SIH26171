// Background-side access to the PerceptionEngine.
//   Chrome:  engine lives in an offscreen document; we message it.
//   Firefox: no offscreen API, but the background page IS a document — the engine
//            runs in-process (see perceptionHost.firefox.js, swapped in at build).

import { hostPerception, isInProcess } from "./perceptionHost.js";

const OFFSCREEN_URL = "offscreen.html";
let creating = null;

export async function ensureOffscreen() {
  if (isInProcess) return;
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (existing?.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run on-device vision and PII models (WebGPU/WASM) so raw screen content never leaves the browser.",
      })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e?.message))) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

/** Call a PerceptionEngine op. Throws on failure. */
export async function perception(op, payload = {}) {
  if (isInProcess) return hostPerception(op, payload);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "perception", op, payload });
  if (!res?.ok) throw new Error(res?.error || `perception ${op} failed`);
  return res.result;
}
