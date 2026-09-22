// Thin shim over the extension API so the rest of the code never touches `chrome.*`
// directly. This is the Firefox seam: `browser.*` is promise-native, `chrome.*` is
// callback-based but modern Chrome also returns promises for most APIs, so for MV3
// Chrome we can use `chrome` as-is. Firefox parity = point this at `browser`.

const api = globalThis.browser ?? globalThis.chrome;

if (!api) {
  // Not fatal for unit tests / node; only the extension runtime needs it.
  console.warn("[browserApi] no extension API available (running outside a browser?)");
}

export const runtime = api?.runtime;
export const tabs = api?.tabs;
export const scripting = api?.scripting;
export const storageSession = api?.storage?.session;
export const storageLocal = api?.storage?.local;

/** getURL for a packaged resource (models, pages). */
export function resourceUrl(path) {
  return api?.runtime?.getURL ? api.runtime.getURL(path) : path;
}

/** Promise wrapper for sending a message to a specific tab. */
export function sendTabMessage(tabId, message) {
  return api.tabs.sendMessage(tabId, message);
}

/** Promise wrapper for runtime.sendMessage (popup <-> background). */
export function sendRuntimeMessage(message) {
  return api.runtime.sendMessage(message);
}

export default api;
