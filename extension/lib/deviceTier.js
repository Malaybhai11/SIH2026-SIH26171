// Device-adaptive default for the perception mode ("eco" | "balanced" | "max",
// see extension/lib/perception/engine.js and popup.html). Used only as a one-time
// default when the user has not saved an explicit choice yet — see loadSettings()
// in background.js, which never re-runs this once agentSettings.perceptionMode
// exists in chrome.storage.local.

// Pure and browser-free so it's unit-testable (extension/lib/deviceTier.test.mjs).
export function pickPerceptionTier({ hardwareConcurrency, deviceMemory } = {}) {
  const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 4;
  // navigator.deviceMemory is Chrome-only (unavailable in Firefox and older Chrome);
  // treat "unknown" as neutral rather than assuming a low-end device.
  const memory = Number.isFinite(deviceMemory) ? deviceMemory : null;

  if (cores <= 2 || (memory !== null && memory <= 2)) return "eco";
  if (cores >= 8 && (memory === null || memory >= 8)) return "max";
  return "balanced";
}

// Reads navigator capabilities in whatever context this runs (service worker,
// Firefox background page, popup) and never throws when navigator or a field is
// missing.
export function detectDeviceTier() {
  const nav = typeof navigator === "undefined" ? {} : navigator;
  return pickPerceptionTier({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory });
}
