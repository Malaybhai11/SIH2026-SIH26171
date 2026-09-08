// Shared message + status constants for popup <-> background <-> content script.
// See docs/api-contract.md for the server contract.

export const MSG = Object.freeze({
  // popup -> background
  RUN_TASK: "RUN_TASK",
  CANCEL_TASK: "CANCEL_TASK",
  GET_STATE: "GET_STATE",
  // background -> popup
  STATE_UPDATE: "STATE_UPDATE",
  // background -> content script
  EXTRACT_SNAPSHOT: "EXTRACT_SNAPSHOT",
  COLLECT_WITH_SCROLL: "COLLECT_WITH_SCROLL",
  EXECUTE_ACTION: "EXECUTE_ACTION",
  PING: "PING",
  // content script -> background
  SNAPSHOT: "SNAPSHOT",
  ACTION_RESULT: "ACTION_RESULT",
});

export const STATUS = Object.freeze({
  IDLE: "IDLE",
  PERCEIVING: "PERCEIVING",
  REDACTING: "REDACTING",
  REASONING: "REASONING",
  ACTING: "ACTING",
  DONE: "DONE",
  ERROR: "ERROR",
});

export const CONTRACT_VERSION = 1;

export const DEFAULTS = Object.freeze({
  maxIterations: 8,
  iterationTimeoutMs: 15000,
  serverUrl: "http://localhost:8000/agent/step",
  scrollAmount: 900,
  settleMs: 700,
});

// chrome.storage.session key holding the live task state object.
export const STATE_KEY = "agentTaskState";
