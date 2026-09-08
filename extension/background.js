// Background service worker — the agent loop orchestrator + state machine.
//
//   IDLE -> PERCEIVING -> REDACTING -> REASONING -> ACTING -> (loop) -> DONE / ERROR
//
// Stateless server: the full task memory is passed on every /agent/step call.
// State is mirrored to chrome.storage.session so a reopened popup can catch up.

import { MSG, STATUS, CONTRACT_VERSION, DEFAULTS, STATE_KEY } from "./lib/messages.js";

let STATE = freshState();
let RUNNING = false;

function freshState() {
  return {
    taskId: null,
    prompt: "",
    iteration: 0,
    maxIterations: DEFAULTS.maxIterations,
    status: STATUS.IDLE,
    serverUrl: DEFAULTS.serverUrl,
    localOnly: false,
    tabId: null,
    targetCount: 0,
    log: [],
    accumulatedData: [],
    answer: null,
    error: null,
    lastRedactionSummary: null,
    lastRedactionLog: [],
    lastVisionMode: null,
    lastScreenState: null,
    cancelRequested: false,
    metrics: { iterations: [] },
  };
}

async function persist() {
  try {
    await chrome.storage.session.set({ [STATE_KEY]: STATE });
  } catch (e) {
    /* session storage may be unavailable in some contexts */
  }
}

function log(msg, level = "info") {
  STATE.log.push({ t: Date.now(), level, msg });
  if (STATE.log.length > 200) STATE.log.shift();
}

async function broadcast() {
  await persist();
  try {
    await chrome.runtime.sendMessage({ type: MSG.STATE_UPDATE, state: STATE });
  } catch (e) {
    /* no popup open — fine */
  }
}

function parseTargetCount(prompt) {
  const m =
    prompt.match(/\btop\s+(\d{1,3})\b/i) ||
    prompt.match(/\b(\d{1,3})\s+(?:posts|items|results|articles|tweets|links|stories)\b/i);
  return m ? Math.min(parseInt(m[1], 10), 50) : 0; // 0 = not a collection task
}

const NAV_ACTIONS = new Set(["navigate", "open_tab", "switch_tab", "back"]);

function waitForTabLoad(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve(true);
      } catch (e) {
        return resolve(false);
      }
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 250);
    };
    check();
  });
}

async function getOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((t, i) => ({
      index: i,
      active: t.id === STATE.tabId,
      title: (t.title || "").slice(0, 80),
      url: t.url || "",
    }));
  } catch (e) {
    return [];
  }
}

async function getCurrentUrl() {
  try {
    return (await chrome.tabs.get(STATE.tabId))?.url ?? null;
  } catch (e) {
    return null;
  }
}

// Navigation actions run here (need chrome.tabs); DOM actions go to the content script.
async function navAction(action) {
  try {
    if (action.type === "navigate") {
      await chrome.tabs.update(STATE.tabId, { url: action.url, active: true });
      await waitForTabLoad(STATE.tabId);
    } else if (action.type === "open_tab") {
      const t = await chrome.tabs.create({ url: action.url, active: true });
      STATE.tabId = t.id;
      await waitForTabLoad(STATE.tabId);
    } else if (action.type === "switch_tab") {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const idx = Math.max(0, Math.min(tabs.length - 1, action.index ?? 0));
      if (tabs[idx]) {
        await chrome.tabs.update(tabs[idx].id, { active: true });
        STATE.tabId = tabs[idx].id;
      }
    } else if (action.type === "back") {
      await chrome.tabs.goBack(STATE.tabId);
      await waitForTabLoad(STATE.tabId);
    }
    await new Promise((r) => setTimeout(r, DEFAULTS.settleMs));
    const ready = await ensureContentScript();
    return ready ? { ok: true } : { ok: false, error: "content script unavailable after navigation" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function dispatchAction(action) {
  if (NAV_ACTIONS.has(action.type)) return navAction(action);
  return withTimeout(
    chrome.tabs.sendMessage(STATE.tabId, { type: MSG.EXECUTE_ACTION, action }),
    DEFAULTS.iterationTimeoutMs,
    "content-action",
  );
}

function dedupeKey(item) {
  return item.href || item.url || item.text || JSON.stringify(item);
}

function mergeAccumulated(items = []) {
  const seen = new Set(STATE.accumulatedData.map(dedupeKey));
  for (const it of items) {
    const k = dedupeKey(it);
    if (!seen.has(k)) {
      seen.add(k);
      STATE.accumulatedData.push(it);
    }
  }
}

async function captureScreenshot() {
  try {
    const tab = await chrome.tabs.get(STATE.tabId);
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    log(`screenshot unavailable (${e.message}); vision falls back to DOM heuristics`, "warn");
    return null;
  }
}

async function ensureContentScript() {
  try {
    const res = await chrome.tabs.sendMessage(STATE.tabId, { type: MSG.PING });
    if (res?.ok) return true;
  } catch (e) {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: STATE.tabId }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, 300));
    return true;
  } catch (e) {
    log(`cannot inject content script: ${e.message}`, "error");
    return false;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function buildRequest(snapshot) {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: STATE.taskId,
    prompt: STATE.prompt,
    iteration: STATE.iteration,
    maxIterations: STATE.maxIterations,
    screenState: snapshot.screenState ?? "unknown",
    screenStateConfidence: snapshot.screenStateConfidence ?? 0.5,
    siteConfigId: snapshot.meta?.siteConfigId ?? "generic",
    currentUrl: await getCurrentUrl(),
    openTabs: await getOpenTabs(),
    sendScreenshot: !!snapshot.sendScreenshot,
    redactedScreenshot: snapshot.sendScreenshot ? snapshot.redactedScreenshot ?? null : null,
    sanitizedDom: snapshot.sanitizedDom ?? [],
    accumulatedData: STATE.accumulatedData,
  };
}

// --- Local-only fallback stepper (server unreachable / "local-only" toggle) ---
function mockStep(reqBody, snapshot) {
  const items = (snapshot.sanitizedDom || [])
    .filter((n) => n.role === "article" || n.href)
    .map((n) => ({ author: n.author, text: n.text, timestamp: n.timestamp, href: n.href }));

  if (!STATE.targetCount) {
    // Not a collection task — the local stepper can't browse/reason.
    return {
      status: "done",
      answer:
        `[local-only] "${STATE.prompt}" needs a real LLM provider to answer. ` +
        `Visible items on the page:\n` +
        (snapshot.sanitizedDom || [])
          .map((n) => (n.text || "").trim())
          .filter(Boolean)
          .slice(0, 15)
          .map((t) => `- ${t.slice(0, 160)}`)
          .join("\n"),
      reasoning: "local stepper cannot answer free-form questions",
    };
  }

  const projected = new Set([...STATE.accumulatedData, ...items].map(dedupeKey)).size;
  if (projected >= STATE.targetCount || STATE.iteration >= STATE.maxIterations) {
    return {
      status: "done",
      answer:
        `[local-only mode] Collected ${projected} item(s) for: "${STATE.prompt}". ` +
        `Server LLM was not used, so no natural-language summary is available.`,
      extractedItems: [...STATE.accumulatedData, ...items].slice(0, STATE.targetCount),
      reasoning: "local mock stepper",
    };
  }
  return {
    status: "action",
    action: { type: "scroll", amount: DEFAULTS.scrollAmount },
    extracted: items,
    reasoning: `local mock: ${projected}/${STATE.targetCount} collected, scrolling`,
  };
}

async function callServer(reqBody, snapshot) {
  if (STATE.localOnly) return mockStep(reqBody, snapshot);
  try {
    const res = await withTimeout(
      fetch(STATE.serverUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      }),
      DEFAULTS.iterationTimeoutMs,
      "server",
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    log(`server call failed (${e.message}); switching to local-only fallback`, "warn");
    STATE.localOnly = true;
    return mockStep(reqBody, snapshot);
  }
}

async function runLoop() {
  RUNNING = true;
  STATE.iteration = 0;

  while (STATE.iteration < STATE.maxIterations && !STATE.cancelRequested) {
    STATE.iteration += 1;
    const iterT0 = performance.now();
    log(`--- iteration ${STATE.iteration}/${STATE.maxIterations} ---`);

    // PERCEIVING + REDACTING (redaction runs inside the content script)
    STATE.status = STATUS.PERCEIVING;
    await broadcast();

    // Re-inject after navigations / SPA route changes.
    if (!(await ensureContentScript())) {
      STATE.status = STATUS.ERROR;
      STATE.error = "content script unavailable on this page";
      log(STATE.error, "error");
      break;
    }
    const screenshot = await captureScreenshot();

    let snapshot;
    try {
      snapshot = await withTimeout(
        chrome.tabs.sendMessage(STATE.tabId, {
          type: MSG.EXTRACT_SNAPSHOT,
          screenshot,
          targetCount: STATE.targetCount,
          collect: false,
        }),
        DEFAULTS.iterationTimeoutMs,
        "content-extract",
      );
    } catch (e) {
      STATE.status = STATUS.ERROR;
      STATE.error = `perception failed: ${e.message}`;
      log(STATE.error, "error");
      break;
    }
    if (!snapshot?.ok) {
      STATE.status = STATUS.ERROR;
      STATE.error = `perception failed: ${snapshot?.error ?? "unknown"}`;
      log(STATE.error, "error");
      break;
    }

    STATE.status = STATUS.REDACTING;
    STATE.lastRedactionSummary = snapshot.redactionSummary;
    STATE.lastRedactionLog = snapshot.redactionLog ?? [];
    STATE.lastVisionMode = snapshot.visionMode;
    STATE.lastScreenState = snapshot.screenState;
    log(
      `redacted ${snapshot.redactionSummary?.total ?? 0} span(s) across ` +
        `${snapshot.redactionSummary?.elements ?? 0} element(s); vision=${snapshot.visionMode}; ` +
        `screen=${snapshot.screenState} (${snapshot.screenStateConfidence}); ` +
        `visual boxes painted=${snapshot.visualBoxesPainted}`,
    );
    await broadcast();

    // REASONING
    STATE.status = STATUS.REASONING;
    await broadcast();
    const reqBody = await buildRequest(snapshot);
    const serverT0 = performance.now();
    const resp = await callServer(reqBody, snapshot);
    const serverMs = Math.round(performance.now() - serverT0);

    STATE.metrics.iterations.push({
      iteration: STATE.iteration,
      perceiveMs: snapshot.timings?.perceiveMs ?? null,
      redactMs: snapshot.timings?.redactMs ?? null,
      visionTotalMs: snapshot.timings?.visionTotalMs ?? null,
      faceMs: snapshot.timings?.faceMs ?? null,
      screenMs: snapshot.timings?.screenMs ?? null,
      serverMs,
      totalMs: Math.round(performance.now() - iterT0),
    });

    if (resp.status === "error") {
      STATE.status = STATUS.ERROR;
      STATE.error = `server: ${resp.code} — ${resp.message}`;
      log(STATE.error, "error");
      break;
    }

    if (resp.status === "done") {
      mergeAccumulated(resp.extractedItems ?? []);
      STATE.answer = resp.answer ?? "(no answer text)";
      STATE.status = STATUS.DONE;
      log(`done: ${resp.reasoning ?? ""}`);
      break;
    }

    // status === "action"
    mergeAccumulated(resp.extracted ?? []);
    const a = resp.action || {};
    const detail = a.url || a.targetId || (a.amount != null ? `${a.amount}px` : "");
    log(`server → ${a.type} ${detail} ${resp.reasoning ? "(" + resp.reasoning + ")" : ""}`);
    STATE.status = STATUS.ACTING;
    await broadcast();

    try {
      const actionRes = await dispatchAction(a);
      if (!actionRes?.ok) log(`action failed: ${actionRes?.error ?? "unknown"}`, "warn");
    } catch (e) {
      log(`action dispatch failed: ${e.message}`, "warn");
    }
  }

  // Loop ended without an explicit done → best-effort fallback.
  if (STATE.status !== STATUS.DONE && STATE.status !== STATUS.ERROR) {
    STATE.status = STATUS.DONE;
    if (STATE.cancelRequested) {
      STATE.answer = "Cancelled by user.";
    } else if (STATE.accumulatedData.length) {
      STATE.answer =
        `Stopped after ${STATE.maxIterations} iterations without a final answer. ` +
        `Collected ${STATE.accumulatedData.length} item(s) so far` +
        (STATE.targetCount ? ` (target ${STATE.targetCount}).` : ".");
    } else {
      STATE.answer =
        `Stopped after ${STATE.maxIterations} iterations without reaching an answer. ` +
        `Try a more specific task, or check the status log.`;
    }
    log(STATE.answer, "warn");
  }

  RUNNING = false;
  await broadcast();
}

async function startTask({ prompt, serverUrl, localOnly }) {
  if (RUNNING) {
    log("a task is already running; ignoring RUN_TASK", "warn");
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    STATE = freshState();
    STATE.status = STATUS.ERROR;
    STATE.error = "no active tab";
    await broadcast();
    return;
  }

  STATE = freshState();
  STATE.taskId = crypto.randomUUID();
  STATE.prompt = prompt.trim();
  STATE.serverUrl = serverUrl || DEFAULTS.serverUrl;
  STATE.localOnly = !!localOnly;
  STATE.tabId = tab.id;
  STATE.targetCount = parseTargetCount(STATE.prompt);
  STATE.status = STATUS.PERCEIVING;
  log(`task "${STATE.prompt}" on ${tab.url} (target=${STATE.targetCount || "n/a"}, localOnly=${STATE.localOnly})`);
  await broadcast();

  const restricted = /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(tab.url || "");
  if (restricted) {
    STATE.status = STATUS.ERROR;
    STATE.error =
      `This is a browser page (${(tab.url || "").split("/")[0]}). Open a normal website first ` +
      `(the agent acts on the active tab and can't inject into ${tab.url?.split(":")[0]}: pages).`;
    log(STATE.error, "error");
    await broadcast();
    return;
  }

  if (!(await ensureContentScript())) {
    STATE.status = STATUS.ERROR;
    STATE.error = "could not inject the content script on this page";
    await broadcast();
    return;
  }

  runLoop().catch(async (e) => {
    STATE.status = STATUS.ERROR;
    STATE.error = `loop crashed: ${e.message}`;
    log(STATE.error, "error");
    RUNNING = false;
    await broadcast();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MSG.RUN_TASK) {
    startTask(msg.payload ?? {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.CANCEL_TASK) {
    STATE.cancelRequested = true;
    log("cancel requested", "warn");
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.GET_STATE) {
    sendResponse({ type: MSG.STATE_UPDATE, state: STATE });
    return false;
  }
  return false;
});

// Restore mirrored state on worker wake-up.
chrome.storage.session.get(STATE_KEY).then((r) => {
  if (r?.[STATE_KEY]) STATE = { ...freshState(), ...r[STATE_KEY], cancelRequested: false };
});
