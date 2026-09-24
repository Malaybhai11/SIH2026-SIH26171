// Chrome host for the PerceptionEngine. Receives {target:"perception", op, payload}
// from the background worker AND directly from content scripts (NER requests), so
// text never makes an extra hop through the service worker.

import { PerceptionEngine } from "./lib/perception/engine.js";

const engine = new PerceptionEngine({ urlFor: (p) => chrome.runtime.getURL(p) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "perception") return false;
  engine
    .handle(msg.op, msg.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
