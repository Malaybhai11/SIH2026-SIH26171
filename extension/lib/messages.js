// Shared message + status constants for popup <-> background <-> content script.
// See docs/api-contract.md for the server contract.

export const MSG = Object.freeze({
  // popup -> background
  RUN_TASK: "RUN_TASK",
  CANCEL_TASK: "CANCEL_TASK",
  GET_STATE: "GET_STATE",
  PAUSE_TASK: "PAUSE_TASK",
  RESUME_TASK: "RESUME_TASK",
  CONFIRM_ACTION: "CONFIRM_ACTION", // payload: { allow: boolean }
  PRIVACY_PREVIEW: "PRIVACY_PREVIEW", // payload: { tabId?, mode? } -> what would leave the device
  SAVE_SETTINGS: "SAVE_SETTINGS",
  WARMUP: "WARMUP", // popup opened: load models while the user types
  // background -> popup
  STATE_UPDATE: "STATE_UPDATE",
  // background -> content script
  EXTRACT_SNAPSHOT: "EXTRACT_SNAPSHOT",
  COLLECT_WITH_SCROLL: "COLLECT_WITH_SCROLL",
  EXECUTE_ACTION: "EXECUTE_ACTION",
  GEOMETRY: "GEOMETRY",
  PING: "PING",
  // content script -> background
  SNAPSHOT: "SNAPSHOT",
  ACTION_RESULT: "ACTION_RESULT",
});

export const STATUS = Object.freeze({
  IDLE: "IDLE",
  PLANNING: "PLANNING",
  PERCEIVING: "PERCEIVING",
  REDACTING: "REDACTING",
  REASONING: "REASONING",
  ACTING: "ACTING",
  DELEGATING: "DELEGATING",
  SYNTHESIZING: "SYNTHESIZING",
  PAUSED: "PAUSED",
  AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
  DONE: "DONE",
  ERROR: "ERROR",
});

export const CONTRACT_VERSION = 1;

export const DEFAULTS = Object.freeze({
  // A fixed low cap was cutting off genuinely big tasks before they could finish.
  // There's no truly "unlimited" option — a broken loop with no ceiling at all would
  // burn LLM calls, tabs, and battery forever — but this is high enough that a
  // sane task finishes long before hitting it; the loop-guards (repeated-action,
  // repeated-host) are what actually stop a stuck task, not this number. Users can
  // raise it further (up to maxIterationsCeiling) from the popup.
  maxIterations: 40,
  maxIterationsCeiling: 300,
  iterationTimeoutMs: 15000,
  serverUrl: "http://localhost:8000/agent/step",
  planServerUrl: "http://localhost:8000/agent/plan",
  synthesizeServerUrl: "http://localhost:8000/agent/synthesize",
  scrollAmount: 900,
  settleMs: 700,
  maxSubAgents: 5,
  // Parallel sub-agents multiply client compute; off by default (resource metric).
  multiAgentEnabled: false,
  // "eco" (faces + text only) | "balanced" (+ CLIP screen/regions, cached) | "max"
  perceptionMode: "balanced",
  // Human-like pointer/keystroke simulation. Off: direct DOM events, ~10x faster steps.
  humanize: false,
  // Attach the redacted, Set-of-Marks-annotated screenshot for the server VLM.
  sendScreenshot: true,
});

// chrome.storage.session key holding the live task state object.
export const STATE_KEY = "agentTaskState";

// chrome.storage.local keys — cross-session memory, never cleared on task start.
export const HISTORY_KEY = "agentTaskHistory";
export const MEMORY_KEY = "agentMemoryFacts";
export const NOTES_KEY = "agentNotes";
export const TEMPLATES_KEY = "agentTemplates";
export const HISTORY_LIMIT = 200;
export const MEMORY_LIMIT = 100;
export const NOTES_LIMIT = 300;
export const TEMPLATES_LIMIT = 50;
