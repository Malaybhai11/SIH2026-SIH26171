// Firefox build: run the engine inside the background page and answer content-script
// requests ({target:"perception"}) directly — same protocol as the Chrome offscreen doc.
import { PerceptionEngine } from "./perception/engine.js";

export const isInProcess = true;
const engine = new PerceptionEngine({ urlFor: (p) => chrome.runtime.getURL(p) });

export function hostPerception(op, payload) {
  return engine.handle(op, payload);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "perception") return false;
  engine
    .handle(msg.op, msg.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
