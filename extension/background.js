// Background service worker — the agent loop orchestrator + state machine.
//
//   IDLE -> PLANNING -> PERCEIVING -> REDACTING -> REASONING -> ACTING -> (loop) -> DONE / ERROR
//                    \-> DELEGATING -> (2-5 sub-agent loops, each own window, run concurrently) -> SYNTHESIZING -> DONE
//
// Single subtask plans skip DELEGATING/SYNTHESIZING entirely and behave exactly like the
// original single-tab agent. Stateless server: the full task memory is passed on every
// /agent/step call. State is mirrored to chrome.storage.session so a reopened popup can catch up.

import { MSG, STATUS, CONTRACT_VERSION, DEFAULTS, STATE_KEY } from "./lib/messages.js";
import { detectDeviceTier } from "./lib/deviceTier.js";
import { getMemoryFacts, addHistoryEntry, rememberFact, addNote } from "./lib/memoryStore.js";
import { Vault, applySpans, detectRuleSpans } from "./lib/redact.js";
import { perception } from "./lib/perceptionClient.js";
import {
  perceiveStep,
  egressGate,
  rehydrateAction,
  sanitizeUrl,
  tokenizeOutgoing,
  backgroundNerTag,
  checkTokenRelease,
  needsScreenshot,
} from "./lib/privacyPipeline.js";

const SETTINGS_KEY = "agentSettings";
async function loadSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({})))[SETTINGS_KEY] || {};
  let perceptionMode = stored.perceptionMode;
  if (perceptionMode === undefined) {
    // No saved choice yet (first run, or storage cleared): pick a one-time
    // device-adaptive default from rough capability signals and persist it, so
    // this never re-runs and never overrides a perceptionMode the user (via the
    // popup) or a prior run of this same logic already saved.
    perceptionMode = detectDeviceTier();
    chrome.storage.local.set({ [SETTINGS_KEY]: { ...stored, perceptionMode } }).catch(() => {});
  }
  return {
    perceptionMode: perceptionMode ?? DEFAULTS.perceptionMode,
    humanize: stored.humanize ?? DEFAULTS.humanize,
    sendScreenshot: stored.sendScreenshot ?? DEFAULTS.sendScreenshot,
  };
}

// B3: per-site privacy policy, set from the popup. "local-only" never calls the
// real server for that host; "never-screenshot" strips the redacted screenshot
// even when the global setting sends one; "ask-before-send" pauses for an
// explicit decision before every server call on that host, not just risky ones.
async function getSitePolicy(hostname) {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({})))[SETTINGS_KEY] || {};
  return stored.sitePolicies?.[hostname] || "none";
}

// Task-scoped pseudonym vault (token <-> real value). Memory only; never persisted,
// never broadcast, never sent. Shared by sub-agents so tokens agree across windows.
let VAULT = new Vault();

let STATE = freshState();
let RUNNING = false;

// MV3 kills an idle service worker after ~30s with no extension-API activity — a
// long multi-iteration/multi-window task can silently die mid-run (e.g. when the
// browser window loses focus/is backgrounded long enough for Chrome to consider it
// idle), leaving tabs it already opened stranded and the task stuck forever. A
// periodic alarm forces a chrome.* call while a task is running so the worker stays
// alive for the duration of the task instead of being torn down mid-loop.
const KEEPALIVE_ALARM = "agent-keepalive";

function startKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) chrome.storage.session.get(STATE_KEY).catch(() => {});
});

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
    pauseRequested: false,
    pendingConfirmation: null,
    metrics: { iterations: [] },
    plan: null,
    subAgents: [],
    memoryFacts: [],
    settings: null,
    engineStats: null,
    lastVisual: null,
    lastRedactedImage: null,
    vaultCatalog: [],
    privacy: { gateFixes: 0, boxesPainted: 0, tokens: 0, bytesSent: 0, tokenReleaseBlocks: 0 },
    tokenReleaseLog: [],
  };
}

// chrome.storage.session has a real quota, and persist() writes the whole STATE
// object on every broadcast (i.e. every iteration). sub.lastThumbnail is a base64
// JPEG data URL — fine for a live in-memory popup message, but would bloat every
// disk-backed write if persisted every iteration. Strip thumbnails from the
// persisted copy; the live chrome.runtime.sendMessage broadcast below keeps the
// full state (including thumbnails) since that's just an in-memory message to an
// open popup, not disk-backed storage.
async function persist() {
  try {
    const forStorage = {
      ...STATE,
      subAgents: (STATE.subAgents || []).map((s) => ({ ...s, lastThumbnail: null, lastRedactedImage: null })),
      lastRedactedImage: null,
    };
    await chrome.storage.session.set({ [STATE_KEY]: forStorage });
  } catch (e) {
    /* session storage may be unavailable in some contexts */
  }
}

function log(msg, level = "info") {
  STATE.log.push({ t: Date.now(), level, msg });
  if (STATE.log.length > 200) STATE.log.shift();
}

// Per-sub-agent logging: writes to the sub-agent's own log AND the combined
// top-level log (prefixed with the sub-agent id when there's more than one).
function subLog(sub, msg, level = "info") {
  const t = Date.now();
  sub.log.push({ t, level, msg });
  if (sub.log.length > 200) sub.log.shift();
  STATE.log.push({ t, level, msg: sub.logPrefix ? `${sub.logPrefix}${msg}` : msg });
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

function hostFromUrl(url) {
  return (url || "").replace(/^https?:\/\//, "").split("/")[0] || "unknown";
}

// --- Image saving + report compilation (save_image / compile_report actions) ---
// Both write real files via chrome.downloads — only available here (background),
// not in the content script, which is why these actions dispatch to the content
// script for resolution/perception first and do the actual download here.

function sanitizeFilenamePart(s, maxLen = 40) {
  const cleaned = String(s || "")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, maxLen);
  return cleaned || "untitled";
}

function guessImageExt(url) {
  const m = /\.(jpg|jpeg|png|gif|webp|svg)(?:[?#]|$)/i.exec(url || "");
  return m ? m[1].toLowerCase() : "jpg";
}

// btoa() only handles Latin1 — this is the standard trick to base64-encode
// arbitrary UTF-8 text (report content can include non-ASCII page text).
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportFolder(taskId) {
  return `browser-agent-reports/${sanitizeFilenamePart(taskId, 12)}`;
}

async function saveImageDownload(sub, ctx, actionRes, caption) {
  const ext = guessImageExt(actionRes.imageUrl);
  const label = sanitizeFilenamePart(caption || actionRes.alt || "image");
  const filename = `${reportFolder(ctx.taskId)}/images/${sub.id}_${sub.savedImages.length + 1}_${label}.${ext}`;
  await chrome.downloads.download({ url: actionRes.imageUrl, filename, saveAs: false });
  sub.savedImages.push({ t: Date.now(), filename, url: actionRes.imageUrl, caption: caption || "", alt: actionRes.alt || "" });
  subLog(sub, `saved image: ${filename}`);
}

// Builds a CSV (whatever's been collected so far, Excel-openable) + a Markdown
// report (the agent's own running notes + a list of saved images with captions)
// and downloads both. Client-side only — never round-trips through the server.
async function compileReport(sub, ctx, title) {
  const folder = reportFolder(ctx.taskId);
  const rows = [["#", "author", "text", "href", "timestamp"]];
  sub.accumulatedData.forEach((it, i) => {
    rows.push([i + 1, it.author || "", it.text || "", it.href || "", it.timestamp || ""]);
  });
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");

  const mdLines = [`# ${title || "Task report"}`, "", `Goal: ${sub.goal}`, ""];
  if (sub.notes.length) {
    mdLines.push("## Notes", "");
    for (const n of sub.notes) mdLines.push(`- ${n.label ? `**${n.label}:** ` : ""}${n.text}`);
    mdLines.push("");
  }
  if (sub.savedImages.length) {
    mdLines.push("## Saved images", "");
    for (const img of sub.savedImages) mdLines.push(`- \`${img.filename}\`${img.caption ? ` — ${img.caption}` : ""}`);
    mdLines.push("");
  }
  if (sub.accumulatedData.length) {
    mdLines.push(`## Collected items (${sub.accumulatedData.length}) — see report.csv for full data`, "");
  }
  const md = mdLines.join("\n");

  const files = [
    { filename: `${folder}/report.csv`, content: csv, mime: "text/csv" },
    { filename: `${folder}/report.md`, content: md, mime: "text/markdown" },
  ];
  const saved = [];
  for (const f of files) {
    const url = `data:${f.mime};charset=utf-8;base64,${utf8ToBase64(f.content)}`;
    await chrome.downloads.download({ url, filename: f.filename, saveAs: false });
    saved.push({ t: Date.now(), filename: f.filename });
  }
  return saved;
}

// Well-known site name -> canonical URL. The planner/step LLM is supposed to
// navigate first when a task names a specific site ("go to chatgpt and..."), but in
// practice that's not reliable — it sometimes tries to act on the CURRENT page as
// if it were already the named site. This is a deterministic fallback so common
// "go to X" tasks don't depend on the model getting that right.
const KNOWN_SITES = {
  chatgpt: "https://chatgpt.com",
  "chat gpt": "https://chatgpt.com",
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  gmail: "https://mail.google.com",
  github: "https://github.com",
  amazon: "https://www.amazon.com",
  wikipedia: "https://en.wikipedia.org",
  reddit: "https://www.reddit.com",
  twitter: "https://x.com",
  "x.com": "https://x.com",
  linkedin: "https://www.linkedin.com",
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  "hacker news": "https://news.ycombinator.com",
  hackernews: "https://news.ycombinator.com",
  "google maps": "https://maps.google.com",
};

function resolveKnownSiteUrl(text) {
  // PII first: "priya@gmail.com" must not read as "go to Gmail"
  const t = applySpans(text || "", detectRuleSpans(text || "")).toLowerCase();
  if (/https?:\/\//.test(t)) return null; // an explicit URL is already given
  const m = t.match(/\b(?:go to|open|visit|navigate to)\s+([a-z][a-z0-9.\s]{1,20}?)(?:\s+(?:and|,|to|then)\b|[.,!?]|$)/i);
  const named = (m ? m[1] : "").trim();
  if (named && KNOWN_SITES[named]) return KNOWN_SITES[named];
  // "... on youtube", "from reddit", "in gmail" — a site named as the place to act
  for (const [alias, url] of Object.entries(KNOWN_SITES)) {
    const a = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b(?:on|from|in|at|search|using)\\s+(?:the\\s+)?${a}\\b`, "i").test(t)) return url;
  }
  return null;
}

// Strip fragment + trailing slash so "open_tab" can recognize a page it already
// opened even if the LLM re-issues a slightly different-looking URL for it.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch (e) {
    return (url || "").split("#")[0].replace(/\/$/, "");
  }
}

const NAV_ACTIONS = new Set(["navigate", "open_tab", "switch_tab", "back"]);
// Actions where repeating the exact same target with no new page/state is a strong
// loop signal (unlike scroll/wait/extract, which are *expected* to repeat).
const LOOP_GUARD_ACTIONS = new Set(["open_tab", "navigate", "click", "back"]);
// Field-targeting actions where an immediate retry of the exact same (action,
// target) pair after a failure is never going to succeed.
const RETRY_GUARDED_ACTIONS = new Set(["type", "select", "check", "press_key"]);

// Clicks whose target looks irreversible/consequential (money, deletion,
// messaging someone, unsubscribing) pause the loop for an explicit user
// confirmation instead of dispatching automatically. Only "click" is gated —
// typing/scrolling/navigating aren't themselves irreversible. These words
// essentially never appear innocuously in unrelated UI text, so they're checked
// against the full node text regardless of length.
const HARD_RISKY_KEYWORDS =
  /\b(buy|purchase|checkout|check out|place order|pay|payment|confirm order|submit payment|delete|remove|unsubscribe|cancel subscription|send (message|email|dm)|transfer funds|wire transfer)\b/i;
// Social-media actions are also worth confirming (posting/following publicly is
// hard to undo), but these are common English words that show up constantly in
// ordinary prose ("customers also like this", "follow these steps") — only treat
// them as risky when the target is a short, button-like label (a real UI control),
// not a sentence that happens to contain the word.
const SOFT_RISKY_KEYWORDS = /\b(follow|unfollow|retweet|repost|like|favorite|tweet|post tweet)\b/i;
const SOFT_RISKY_LABEL_MAX_LEN = 24;

// A task that explicitly asks the agent to authenticate ("log in with username
// X and password Y") — see the loginWall check below: on this kind of page,
// filling and submitting the form IS the task, not something blocking it.
const LOGIN_TASK_RE = /\b(log\s*in|sign\s*in|login)\b.{0,80}\b(username|user\s*name|password|email)\b/i;

// How long an auto-detected CAPTCHA pause waits for a human to resume before the
// sub-agent gives up and ends as an ERROR instead of hanging forever.
const CAPTCHA_PAUSE_TIMEOUT_MS = 10 * 60 * 1000;

function isRiskyAction(a, snapshot) {
  if (a.type !== "click") return false;
  const node = (snapshot.sanitizedDom || []).find((n) => n.id === a.targetId);
  const text = (node?.text || "").trim();
  const label = `${text} ${node?.role || ""}`;
  if (HARD_RISKY_KEYWORDS.test(label)) return true;
  const isButtonLike = node?.role === "button" || node?.role === "link";
  return isButtonLike && text.length > 0 && text.length <= SOFT_RISKY_LABEL_MAX_LEN && SOFT_RISKY_KEYWORDS.test(label);
}

// This extension ships no icon asset (checked manifest.json + extension/ dir —
// none present), but chrome.notifications.create's "basic" type requires an
// iconUrl. Rather than block completion notifications on producing a real asset,
// fall back to a tiny inline 1x1 PNG data URL.
const FALLBACK_NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUAAscqmT4AAAAASUVORK5CYII=";

// Best-effort completion notification — must never affect the task result.
function notifyTaskComplete(status, summary) {
  try {
    const isError = status === STATUS.ERROR;
    chrome.notifications.create({
      type: "basic",
      iconUrl: FALLBACK_NOTIFICATION_ICON,
      title: "Browser Agent",
      message: String(summary || (isError ? "Task failed." : "Task complete.")).slice(0, 120),
    });
  } catch (e) {
    /* notifications are best-effort — never let this affect the task result */
  }
}

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

async function getOpenTabs(sub) {
  try {
    const tabs = await chrome.tabs.query({ windowId: sub.windowId });
    return tabs.map((t, i) => ({
      index: i,
      active: t.id === sub.tabId,
      title: (t.title || "").slice(0, 80),
      url: t.url || "",
    }));
  } catch (e) {
    return [];
  }
}

async function getCurrentUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId))?.url ?? null;
  } catch (e) {
    return null;
  }
}

// Navigation actions run here (need chrome.tabs); DOM actions go to the content script.
async function navAction(sub, action) {
  try {
    if (action.type === "navigate") {
      const currentUrl = await getCurrentUrl(sub.tabId);
      if (currentUrl && normalizeUrl(currentUrl) === normalizeUrl(action.url)) {
        subLog(sub, `already on ${action.url} — skipping redundant reload`, "warn");
        return {
          ok: false,
          error: `Already on ${action.url}. Do not navigate here again — interact with the page elements directly (click buttons/links, fill forms, or record a note).`,
        };
      }
      await chrome.tabs.update(sub.tabId, { url: action.url, active: true });
      await waitForTabLoad(sub.tabId);
    } else if (action.type === "open_tab") {
      // Reuse an already-open tab with the same URL instead of piling up duplicates —
      // the LLM sometimes re-issues open_tab for a page it already opened.
      const norm = normalizeUrl(action.url);
      const existing = (await chrome.tabs.query({ windowId: sub.windowId })).find(
        (t) => t.url && normalizeUrl(t.url) === norm,
      );
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        sub.tabId = existing.id;
      } else {
        const t = await chrome.tabs.create({ url: action.url, active: true, windowId: sub.windowId });
        sub.tabId = t.id;
        await waitForTabLoad(sub.tabId);
      }
    } else if (action.type === "switch_tab") {
      const tabs = await chrome.tabs.query({ windowId: sub.windowId });
      const idx = Math.max(0, Math.min(tabs.length - 1, action.index ?? 0));
      if (tabs[idx]) {
        await chrome.tabs.update(tabs[idx].id, { active: true });
        sub.tabId = tabs[idx].id;
      }
    } else if (action.type === "back") {
      await chrome.tabs.goBack(sub.tabId);
      await waitForTabLoad(sub.tabId);
    }
    // SPAs keep rendering well after `status: complete` — give them longer.
    let spaMs = DEFAULTS.settleMs;
    try {
      const h = new URL(action.url || (await getCurrentUrl(sub.tabId)) || "https://x").hostname;
      if (/(x|twitter|reddit|instagram|linkedin|facebook)\.com$/i.test(h)) spaMs = 2200;
    } catch (e) {
      /* keep default */
    }
    await new Promise((r) => setTimeout(r, spaMs));
    const ready = await ensureContentScript(sub.tabId);
    return ready ? { ok: true } : { ok: false, error: "content script unavailable after navigation" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// D1: sanitizedDom ids from a non-root frame carry an "fN_" prefix (added when the
// background script stitches every frame's snapshot into one, so ids stay unique
// across frames). A frame's own content script only knows its OWN local ids
// (it set the data-agent-id attributes), so the prefix has to come back off — and
// the message has to be routed to that specific frame — before dispatch.
function parseFrameTarget(id) {
  const m = /^f(\d+)_(.+)$/.exec(id || "");
  return m ? { frameId: Number(m[1]), localId: m[2] } : { frameId: 0, localId: id };
}

async function dispatchAction(sub, action) {
  // tokens ([PHONE_1], [NAME_2] ...) become real values only here, on-device
  action = rehydrateAction(action, VAULT);
  if (NAV_ACTIONS.has(action.type)) return navAction(sub, action);

  if (action.type === "fill_form" && Array.isArray(action.fields)) {
    const byFrame = new Map();
    for (const f of action.fields) {
      const { frameId, localId } = parseFrameTarget(f.targetId);
      if (!byFrame.has(frameId)) byFrame.set(frameId, []);
      byFrame.get(frameId).push({ ...f, targetId: localId });
    }
    const results = [];
    let filled = 0;
    for (const [frameId, fields] of byFrame) {
      const res = await withTimeout(
        chrome.tabs.sendMessage(
          sub.tabId,
          { type: MSG.EXECUTE_ACTION, action: { ...action, fields }, humanize: !!STATE.settings?.humanize },
          { frameId },
        ),
        DEFAULTS.iterationTimeoutMs,
        "content-action",
      ).catch((e) => ({ ok: false, error: e.message, filled: 0, results: fields.map((f) => ({ targetId: f.targetId, ok: false, error: e.message })) }));
      filled += res.filled || 0;
      const prefix = frameId ? `f${frameId}_` : "";
      results.push(...(res.results || []).map((r) => ({ ...r, targetId: prefix + r.targetId })));
    }
    return { ok: filled > 0, filled, results };
  }

  const { frameId, localId } = parseFrameTarget(action.targetId);
  const localAction = action.targetId ? { ...action, targetId: localId } : action;
  return withTimeout(
    chrome.tabs.sendMessage(sub.tabId, { type: MSG.EXECUTE_ACTION, action: localAction, humanize: !!STATE.settings?.humanize }, { frameId }),
    DEFAULTS.iterationTimeoutMs,
    "content-action",
  );
}

function dedupeKey(item) {
  return item.href || item.url || item.text || JSON.stringify(item);
}

function mergeAccumulated(sub, items = []) {
  const seen = new Set(sub.accumulatedData.map(dedupeKey));
  for (const it of items) {
    const k = dedupeKey(it);
    if (!seen.has(k)) {
      seen.add(k);
      sub.accumulatedData.push(it);
    }
  }
}

// Combine every sub-agent's collected items into one deduped list (used for the
// top-level STATE.accumulatedData mirror and the history entry's itemCount).
function mergeAllSubData(subAgents) {
  const out = [];
  const seen = new Set();
  for (const sub of subAgents) {
    for (const it of sub.accumulatedData || []) {
      const k = dedupeKey(it);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(it);
      }
    }
  }
  return out;
}

async function captureScreenshot(sub) {
  try {
    return await chrome.tabs.captureVisibleTab(sub.windowId, { format: "png" });
  } catch (e) {
    subLog(sub, `screenshot unavailable (${e.message}); vision falls back to DOM heuristics`, "warn");
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    if (res?.ok) return true;
  } catch (e) {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
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

async function buildRequest(sub, ctx, snapshot, visual) {
  const nerTag = backgroundNerTag(STATE.settings?.perceptionMode !== "eco");
  if (!sub.goalTokenized) sub.goalTokenized = await tokenizeOutgoing(sub.goal, VAULT, nerTag);
  const openTabs = await Promise.all(
    (await getOpenTabs(sub)).map(async (t) => ({ ...t, url: sanitizeUrl(t.url, VAULT), title: await tokenizeOutgoing(t.title || "", VAULT, nerTag) })),
  );
  const memoryFacts = await Promise.all(
    (ctx.memoryFacts ?? []).map(async (f) => (typeof f === "string" ? tokenizeOutgoing(f, VAULT, nerTag) : { ...f, value: await tokenizeOutgoing(String(f.value ?? ""), VAULT, nerTag) })),
  );
  // D3: the popup's "send redacted screenshot" toggle is the user's ceiling (off
  // means never, full stop); when it's on, the client still only actually attaches
  // the image on steps that need it — canvas-heavy pages, an image-centric task,
  // or when the on-device screen classifier itself isn't confident.
  const gate = STATE.settings?.sendScreenshot
    ? needsScreenshot({ prompt: sub.goal, rois: snapshot.rois, screen: visual?.screen })
    : { send: false, reason: "sendScreenshot setting is off" };
  sub.lastImageGate = gate;
  const includeImage = gate.send && !!visual?.redactedImage;
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: ctx.taskId,
    prompt: sub.goalTokenized,
    iteration: sub.iteration,
    maxIterations: sub.maxIterations,
    screenState: visual?.screen?.state ?? "unknown",
    screenStateConfidence: visual?.screen?.confidence ?? 0,
    // what the on-device vision saw, as non-sensitive labels only
    visualContext: {
      screen: visual?.screen ?? null,
      regions: (visual?.regions ?? []).map((r) => ({ id: r.id, label: r.sensitive ? `${r.label} (redacted)` : r.label, confidence: r.confidence })),
      facesRedacted: visual?.faces?.length ?? 0,
      boxCounts: visual?.boxCounts ?? null,
    },
    // the scheme the server must understand to use the sanitized context
    redactionScheme: {
      version: 2,
      textTokens: "[TYPE_n] — the same n always denotes the same real value within this task",
      visual: "opaque black boxes; each box is labelled with its token (e.g. EMAIL_1, FACE, PASSWORD, ID_CARD)",
      marks: "magenta boxes with a number = interactive element; number N refers to sanitizedDom id n_000N",
      tokens: VAULT.catalog(),
      actionsMayUseTokens: true,
    },
    siteConfigId: snapshot.meta?.siteConfigId ?? "generic",
    currentUrl: sanitizeUrl(await getCurrentUrl(sub.tabId), VAULT),
    openTabs,
    pageMeta: {
      nodeCount: snapshot.sanitizedDom?.length ?? 0,
      loginWall: !!snapshot.meta?.loginWall,
      scrollY: snapshot.meta?.scrollY ?? 0,
      scrollMax: snapshot.meta?.scrollMax ?? 0,
      title: snapshot.meta?.title ?? "",
      toasts: snapshot.meta?.toasts ?? [],
    },
    sendScreenshot: includeImage,
    redactedScreenshot: includeImage ? visual.redactedImage.slice(visual.redactedImage.indexOf(",") + 1) : null,
    sanitizedDom: snapshot.sanitizedDom ?? [],
    accumulatedData: sub.accumulatedData,
    // Cross-session facts the user has told the agent to remember (tokenised).
    memoryFacts,
    // Outcome of the action taken last turn — lets the model notice a failed guess
    // (wrong element, stale id, non-typeable field) instead of repeating it blind.
    lastActionResult: sub.lastActionResult ?? null,
  };
}

// --- Local-only fallback stepper (server unreachable / "local-only" toggle) ---
function mockStep(sub, reqBody, snapshot) {
  const items = (snapshot.sanitizedDom || [])
    .filter((n) => n.role === "article" || n.href)
    .map((n) => ({ author: n.author, text: n.text, timestamp: n.timestamp, href: n.href }));

  if (!sub.targetCount) {
    // Not a collection task — the local stepper can't browse/reason.
    return {
      status: "done",
      answer:
        `[local-only] "${sub.goal}" needs a real LLM provider to answer. ` +
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

  const projected = new Set([...sub.accumulatedData, ...items].map(dedupeKey)).size;
  if (projected >= sub.targetCount || sub.iteration >= sub.maxIterations) {
    return {
      status: "done",
      answer:
        `[local-only mode] Collected ${projected} item(s) for: "${sub.goal}". ` +
        `Server LLM was not used, so no natural-language summary is available.`,
      extractedItems: [...sub.accumulatedData, ...items].slice(0, sub.targetCount),
      reasoning: "local mock stepper",
    };
  }
  return {
    status: "action",
    action: { type: "scroll", amount: DEFAULTS.scrollAmount },
    extracted: items,
    reasoning: `local mock: ${projected}/${sub.targetCount} collected, scrolling`,
  };
}

async function callServer(sub, ctx, reqBody, snapshot, forceLocalOnly = false) {
  if (ctx.localOnly || forceLocalOnly) return mockStep(sub, reqBody, snapshot);
  // fail-closed egress gate: last check of every outgoing string before the network
  const gated = egressGate(reqBody, VAULT);
  if (gated.fixes) {
    STATE.privacy.gateFixes += gated.fixes;
    subLog(sub, `egress gate rewrote ${gated.fixes} string(s) that still held PII: ${gated.where.join(", ")}`, "warn");
  }
  const payload = JSON.stringify(gated.body);
  STATE.privacy.bytesSent += payload.length;
  try {
    const res = await withTimeout(
      fetch(ctx.serverUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
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
    subLog(sub, `server call failed (${e.message}); switching to local-only fallback`, "warn");
    ctx.localOnly = true;
    STATE.localOnly = true;
    return mockStep(sub, reqBody, snapshot);
  }
}

// Copy a sub-agent's live fields onto the top-level STATE so the existing popup UI
// (which reads STATE.iteration/accumulatedData/answer/etc directly) keeps working
// unchanged for the single-subtask path.
function mirrorSubToState(sub) {
  STATE.status = sub.status;
  STATE.iteration = sub.iteration;
  STATE.maxIterations = sub.maxIterations;
  STATE.accumulatedData = sub.accumulatedData;
  STATE.answer = sub.answer;
  STATE.error = sub.error;
  STATE.lastRedactionSummary = sub.lastRedactionSummary;
  STATE.lastRedactionLog = sub.lastRedactionLog;
  STATE.lastVisionMode = sub.lastVisionMode;
  STATE.lastScreenState = sub.lastScreenState;
  STATE.lastVisual = sub.lastVisual ?? null;
  STATE.lastRedactedImage = sub.lastRedactedImage ?? null;
  STATE.metrics = sub.metrics;
  STATE.tabId = sub.tabId;
}

// Idles a sub-agent while paused (either user-requested via MSG.PAUSE_TASK, or an
// automatic pause on a detected CAPTCHA wall) without exiting runSubLoop's while
// loop — a paused loop should idle, not be treated as finished. Callers are
// responsible for restoring sub.status once this returns (it only sets PAUSED).
// Pause and wait for an explicit user decision. STATE.pendingConfirmation is a
// single global slot — if another sub-agent already claimed it, wait for it to
// clear before claiming it for ourselves so two sub-agents never stomp each other.
// Shared by the risky-action gate (a click that looks irreversible) and the token
// release gate (B1: a token about to be typed somewhere it doesn't belong).
// Nobody may be at the popup to answer (an unattended/scheduled run, or the user
// just stepped away) — without a bound this blocks the current iteration forever,
// which blocks the whole sub-agent loop forever with it (iteration only advances
// once this call returns). The safe default on giving up is always deny, same as
// cancellation — never auto-allow a risky action or a PII release just because
// nobody answered in time.
const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;

async function awaitConfirmation(sub, ctx, { actionType, targetId = null, description, kind = "risky_action" }) {
  while (STATE.pendingConfirmation && !ctx.isCancelled()) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ctx.isCancelled()) return false;

  const prevSubStatus = sub.status;
  const prevStateStatus = STATE.status;
  STATE.pendingConfirmation = { subId: sub.id, actionType, targetId, description, kind, resolution: null };
  STATE.status = STATUS.AWAITING_CONFIRMATION;
  sub.status = STATUS.AWAITING_CONFIRMATION;
  subLog(sub, `awaiting confirmation (${kind}): ${description}`, "warn");
  await ctx.onUpdate();

  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  let timedOut = false;
  while (!STATE.pendingConfirmation?.resolution && !ctx.isCancelled()) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const resolution = ctx.isCancelled() || timedOut ? "deny" : STATE.pendingConfirmation?.resolution;
  STATE.pendingConfirmation = null;
  STATE.status = prevStateStatus;
  sub.status = prevSubStatus;
  await ctx.onUpdate();

  const allowed = resolution === "allow";
  const why = ctx.isCancelled() ? " (cancelled)" : timedOut ? " (no answer — timed out)" : "";
  subLog(sub, `${allowed ? "allowed by user" : `denied${why}`}: ${description}`, allowed ? "info" : "warn");
  return allowed;
}

// timeoutMs is left unset for a human-requested pause (MSG.PAUSE_TASK) — they'll
// resume when they're ready, no reason to give up on them. An AUTO-pause (e.g. the
// captcha wall below) passes one: unattended/automated runs have nobody to click
// Resume, and without a bound the sub-agent — and the global RUNNING flag with it —
// would hang forever, silently swallowing every future RUN_TASK for the rest of
// the browser session. Returns "timeout" if it gave up, "resumed" otherwise.
async function waitWhilePaused(sub, ctx, { timeoutMs = null } = {}) {
  if (!ctx.isPaused()) return "resumed";
  sub.status = STATUS.PAUSED;
  await ctx.onUpdate();
  const deadline = timeoutMs != null ? Date.now() + timeoutMs : null;
  while (ctx.isPaused() && !ctx.isCancelled()) {
    if (deadline != null && Date.now() >= deadline) {
      // Only clear the global flag if nothing else (a real, still-relevant pause)
      // claimed it in the meantime — this auto-pause is the one giving up, not
      // necessarily the only reason pauseRequested is set right now.
      if (STATE.pauseRequested) STATE.pauseRequested = false;
      return "timeout";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "resumed";
}

// The PERCEIVE -> REDACT -> REASON -> ACT loop, parameterized over a single sub-agent's
// state instead of the module-level STATE. Runs to DONE/ERROR and never throws — callers
// (single-agent or Promise.allSettled in multi-agent mode) can await it safely.
async function runSubLoop(sub, ctx) {
  sub.targetCount = parseTargetCount(sub.goal);
  // Tokenise the task first: the user's own values (name, phone...) enter the vault
  // before the first screen is perceived, so they are redacted wherever they appear.
  try {
    sub.goalTokenized = await tokenizeOutgoing(sub.goal, VAULT, backgroundNerTag(STATE.settings?.perceptionMode !== "eco"));
  } catch (e) {
    subLog(sub, `task tokenisation fell back to rules: ${e.message}`, "warn");
    sub.goalTokenized = await tokenizeOutgoing(sub.goal, VAULT);
  }
  let emptyStreak = 0;
  let lastActionSig = null;
  let repeatStreak = 0;
  // Tracks visits to exact URLs to detect tight navigation loops.
  const urlVisitCounts = {};
  const hostVisitCounts = {};
  const HOST_REVISIT_LIMIT = 25;
  // The actual "is this task going anywhere" signal: how many iterations has it
  // been since anything was actually produced (a note, a collected item, a saved
  // image)? A task can visit the same host or different hosts any number of times
  // and that's fine as long as it keeps producing output; if it stops producing
  // ANYTHING for a long stretch, it's stuck regardless of what it's clicking on.
  let noProgressStreak = 0;
  let lastProgressMark = sub.accumulatedData.length + sub.notes.length + sub.savedImages.length;
  const NO_PROGRESS_LIMIT = 20;

  while (sub.iteration < sub.maxIterations && !ctx.isCancelled()) {
    sub.cancelRequested = ctx.isCancelled();
    sub.iteration += 1;
    const iterT0 = performance.now();
    subLog(sub, `--- iteration ${sub.iteration}/${sub.maxIterations} ---`);

    // A pause (user-requested or auto-triggered) idles here rather than exiting the
    // loop; sub.status is restored below by the unconditional PERCEIVING assignment.
    await waitWhilePaused(sub, ctx);
    if (ctx.isCancelled()) break;

    // Stall check: did the PREVIOUS iteration actually produce anything (a note,
    // a collected item, a saved image)? If nothing has moved for a long stretch,
    // the task is stuck regardless of how much clicking/navigating/waiting it's
    // doing — stop instead of quietly burning the rest of a large iteration budget.
    const progressMark = sub.accumulatedData.length + sub.notes.length + sub.savedImages.length;
    noProgressStreak = progressMark > lastProgressMark ? 0 : noProgressStreak + 1;
    lastProgressMark = progressMark;
    if (noProgressStreak >= NO_PROGRESS_LIMIT) {
      sub.status = STATUS.DONE;
      sub.answer =
        `Stopped early: no new notes/items/images in the last ${NO_PROGRESS_LIMIT} iterations — ` +
        `stuck without making progress. ` +
        (sub.accumulatedData.length || sub.notes.length || sub.savedImages.length
          ? `Collected ${sub.accumulatedData.length} item(s), ${sub.notes.length} note(s), ${sub.savedImages.length} image(s) so far.`
          : `Nothing was collected — try a more specific task, or check the status log.`);
      subLog(sub, sub.answer, "warn");
      break;
    }

    // PERCEIVING + REDACTING (redaction runs inside the content script)
    sub.status = STATUS.PERCEIVING;
    await ctx.onUpdate();

    // Re-inject after navigations / SPA route changes.
    if (!(await ensureContentScript(sub.tabId))) {
      sub.status = STATUS.ERROR;
      sub.error = "content script unavailable on this page";
      subLog(sub, sub.error, "error");
      break;
    }

    const iterHost = hostFromUrl(await getCurrentUrl(sub.tabId));
    const sitePolicy = await getSitePolicy(iterHost);
    const iterSettings =
      sitePolicy === "never-screenshot" ? { ...STATE.settings, sendScreenshot: false } : STATE.settings;
    if (sitePolicy === "local-only" && !ctx.localOnly) {
      subLog(sub, `${iterHost}: local-only site policy — this step will not call the server`, "warn");
    }

    let snapshot;
    let visual;
    let ptimings;
    try {
      ({ snapshot, visual, timings: ptimings } = await perceiveStep({
        tabId: sub.tabId,
        windowId: sub.windowId,
        vault: VAULT,
        settings: iterSettings,
        targetCount: sub.targetCount,
      }));
    } catch (e) {
      sub.status = STATUS.ERROR;
      sub.error = `perception failed: ${e.message}`;
      subLog(sub, sub.error, "error");
      break;
    }
    if (!snapshot?.ok) {
      sub.status = STATUS.ERROR;
      sub.error = `perception failed: ${snapshot?.error ?? "unknown"}`;
      subLog(sub, sub.error, "error");
      break;
    }
    if (visual?.error) subLog(sub, `vision degraded: ${visual.error}`, "warn");
    sub.lastVisual = visual && { ...visual, redactedImage: undefined };
    sub.lastRedactedImage = visual?.redactedImage ?? null;
    STATE.privacy.boxesPainted += visual?.painted ?? 0;
    STATE.privacy.tokens = VAULT.size();
    STATE.vaultCatalog = VAULT.catalog();

    // Login wall / persistently empty page → stop with a useful message instead
    // of burning every iteration scrolling nothing.
    const nodeCount = snapshot.sanitizedDom?.length ?? 0;
    const host = hostFromUrl(await getCurrentUrl(sub.tabId)) || "the page";
    sub.lastThumbnail = null;
    // Clear any stale captcha message from a previous iteration now that we have a
    // fresh snapshot — otherwise it lingers in sub.error (and STATE.error) forever
    // after the captcha is solved, wrongly showing up as the reason for any LATER
    // pause (e.g. a plain user-requested take-over) even once wholly unrelated.
    sub.error = null;

    // CAPTCHA/bot-check wall: checked BEFORE loginWall/empty-page, since a captcha
    // page can also look "empty" to the DOM extractor. Unlike those, this doesn't
    // end the sub-agent — it auto-pauses (reusing the same STATE.pauseRequested
    // flag MSG.RESUME_TASK clears) so the user can solve it manually, then resume.
    if (snapshot.meta?.captchaWall) {
      sub.error =
        "This page shows a CAPTCHA/bot-check challenge — solve it manually in the browser, then click Resume.";
      subLog(sub, sub.error, "warn");
      STATE.pauseRequested = true;
      log("captcha wall detected — auto-pausing until user resumes", "warn");
      const outcome = await waitWhilePaused(sub, ctx, { timeoutMs: CAPTCHA_PAUSE_TIMEOUT_MS });
      if (ctx.isCancelled()) break;
      if (outcome === "timeout") {
        sub.status = STATUS.ERROR;
        sub.error =
          "This page kept showing a CAPTCHA/bot-check challenge and nobody resumed the task " +
          `within ${Math.round(CAPTCHA_PAUSE_TIMEOUT_MS / 60000)} minutes, so it was stopped. ` +
          "Solve the challenge and re-run the task if it wasn't a false positive.";
        subLog(sub, sub.error, "error");
        break;
      }
      continue; // re-perceive fresh once resumed, rather than using this stale snapshot
    }
    // A login/sign-in page is only a "wall" (nothing to do, stop) when the task
    // isn't asking to log in — e.g. "summarise my feed" on a logged-out site truly
    // has nothing to read. "Log in with username X and password Y" IS the task on
    // exactly the same kind of page, and should proceed to fill the form instead
    // of stopping the moment it sees the form it's meant to submit.
    if (snapshot.meta?.loginWall && !LOGIN_TASK_RE.test(sub.goal)) {
      sub.status = STATUS.DONE;
      sub.answer =
        `${host} is showing a sign-in wall, so there's no content to read. ` +
        `Log in to that site in this browser, then re-run the task.`;
      subLog(sub, sub.answer, "warn");
      break;
    }
    if (nodeCount === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        sub.status = STATUS.DONE;
        sub.answer =
          `${host} returned no readable content after ${emptyStreak} attempts — the site ` +
          `may require login, block automation, or still be loading. Stopping.`;
        subLog(sub, sub.answer, "warn");
        break;
      }
      subLog(sub, `empty snapshot (${emptyStreak}/3) — retrying`, "warn");
    } else {
      emptyStreak = 0;
    }

    sub.status = STATUS.REDACTING;
    sub.lastRedactionSummary = snapshot.redactionSummary;
    sub.lastRedactionLog = snapshot.redactionLog ?? [];
    sub.lastVisionMode = visual?.ep ?? "none";
    sub.lastScreenState = visual?.screen?.state ?? "unknown";
    subLog(
      sub,
      `redacted ${snapshot.redactionSummary?.total ?? 0} text span(s); ` +
        `painted ${visual?.painted ?? 0} box(es) [text ${visual?.boxCounts?.text ?? 0}, fields ${visual?.boxCounts?.fields ?? 0}, ` +
        `faces ${visual?.boxCounts?.faces ?? 0}, images ${visual?.boxCounts?.regions ?? 0}]; ` +
        `screen=${sub.lastScreenState} (${visual?.screen?.confidence ?? "-"}); ep=${sub.lastVisionMode}` +
        `${visual?.cacheHit ? " (frame cache hit)" : ""}; perception ${ptimings?.perceptionTotalMs ?? "?"}ms`,
    );
    await ctx.onUpdate();

    // REASONING
    sub.status = STATUS.REASONING;
    await ctx.onUpdate();
    if (sitePolicy === "ask-before-send" && !ctx.localOnly) {
      const allowed = await awaitConfirmation(sub, ctx, {
        actionType: "server_send",
        description: `${iterHost}: send this step's redacted context to the server? (per-site policy: ask before every send)`,
        kind: "site_policy",
      });
      if (ctx.isCancelled()) break;
      if (!allowed) {
        subLog(sub, `${iterHost}: send denied by user — skipping this step's reasoning`, "warn");
        continue;
      }
    }
    const reqBody = await buildRequest(sub, ctx, snapshot, visual);
    const serverT0 = performance.now();
    const resp = await callServer(sub, ctx, reqBody, snapshot, sitePolicy === "local-only");
    const serverMs = Math.round(performance.now() - serverT0);

    if (typeof resp.reasoning === "string" && resp.reasoning.trim()) {
      sub.narration.push({ t: Date.now(), text: resp.reasoning });
      if (sub.narration.length > 30) sub.narration.shift();
    }

    sub.metrics.iterations.push({
      iteration: sub.iteration,
      domMs: ptimings?.perceiveMs ?? null,
      textPiiMs: ptimings?.pixelMs ?? null,
      tokenizeMs: ptimings?.redactMs ?? null,
      visionMs: ptimings?.analyzeMs ?? null,
      facesMs: visual?.engineTimings?.facesMs ?? null,
      clipMs: visual?.engineTimings?.clipMs ?? null,
      paintMs: ptimings?.redactMs ?? null,
      perceptionMs: ptimings?.perceptionTotalMs ?? null,
      cacheHit: !!visual?.cacheHit,
      serverMs,
      totalMs: Math.round(performance.now() - iterT0),
      imageSent: !!sub.lastImageGate?.send,
      imageGateReason: sub.lastImageGate?.reason ?? null,
    });
    try {
      STATE.engineStats = await perception("stats");
    } catch {
      /* engine not up (local-only / restricted page) */
    }

    if (resp.status === "error") {
      sub.status = STATUS.ERROR;
      sub.error = `server: ${resp.code} — ${resp.message}`;
      subLog(sub, sub.error, "error");
      break;
    }

    if (resp.status === "done") {
      mergeAccumulated(sub, resp.extractedItems ?? []);
      // the server answered in tokens; real values are restored only for display
      sub.answerTokenized = resp.answer ?? "(no answer text)";
      sub.answer = VAULT.resolve(sub.answerTokenized);
      sub.status = STATUS.DONE;
      subLog(sub, `done: ${resp.reasoning ?? ""}`);
      break;
    }

    // status === "action"
    mergeAccumulated(sub, resp.extracted ?? []);
    const a = resp.action || {};

    // Memory writes are intercepted here — never dispatched to the content script.
    if (a.type === "remember") {
      try {
        await rememberFact(a.targetId, a.text, "agent");
        subLog(sub, `remembered "${a.targetId}" = "${String(a.text ?? "").slice(0, 80)}"`);
      } catch (e) {
        subLog(sub, `remember failed: ${e.message}`, "warn");
      }
      sub.status = STATUS.ACTING;
      await ctx.onUpdate();
      continue; // not a page action — keep looping without touching the tab
    }

    // Notes are intercepted the same way — never dispatched to the content script.
    // Also pushed onto sub.notes so the popup can show them immediately without a
    // storage round-trip.
    if (a.type === "note") {
      try {
        await addNote(ctx.taskId, a.text, "agent");
        sub.notes.push({ t: Date.now(), text: a.text, label: a.targetId ?? null });
        subLog(sub, `note added${a.targetId ? ` [${a.targetId}]` : ""}: "${String(a.text ?? "").slice(0, 80)}"`);
      } catch (e) {
        subLog(sub, `note failed: ${e.message}`, "warn");
      }
      sub.status = STATUS.ACTING;
      await ctx.onUpdate();
      continue; // not a page action — keep looping without touching the tab
    }

    // Report compilation is also client-side only — never touches the page.
    if (a.type === "compile_report") {
      try {
        const files = await compileReport(sub, ctx, a.text || "");
        sub.reportFiles.push(...files);
        subLog(sub, `compiled report: ${files.map((f) => f.filename).join(", ")}`);
      } catch (e) {
        subLog(sub, `compile_report failed: ${e.message}`, "warn");
      }
      sub.status = STATUS.ACTING;
      await ctx.onUpdate();
      continue; // not a page action — keep looping without touching the tab
    }

    // Loop guard: the same open_tab/navigate/click/back target twice in a row with
    // no new data means the agent is stuck (e.g. re-opening a page it already has
    // open) rather than making progress — stop instead of repeating it indefinitely.
    if (LOOP_GUARD_ACTIONS.has(a.type)) {
      const sig = `${a.type}:${normalizeUrl(a.url || "")}:${a.targetId || ""}`;
      repeatStreak = sig === lastActionSig ? repeatStreak + 1 : 0;
      lastActionSig = sig;
      if (repeatStreak >= 2) {
        sub.status = STATUS.DONE;
        sub.answer = sub.accumulatedData.length
          ? `Stopped early: repeated the same "${a.type}" action ${repeatStreak + 1}x without new progress. ` +
            `Collected ${sub.accumulatedData.length} item(s) so far.`
          : `Stopped early: repeated the same "${a.type}" action ${repeatStreak + 1}x without making progress.`;
        subLog(sub, sub.answer, "warn");
        break;
      }
    } else {
      lastActionSig = null;
      repeatStreak = 0;
    }

    // Slower thrash guard: the same host opened/navigated-to several times across
    // the whole run (not necessarily consecutively) without finishing means the
    // agent is bouncing between sites rather than converging — e.g. re-opening a
    // mail compose window over and over instead of continuing to fill it in.
    if ((a.type === "open_tab" || a.type === "navigate") && a.url) {
      const norm = normalizeUrl(a.url);
      urlVisitCounts[norm] = (urlVisitCounts[norm] || 0) + 1;
      if (urlVisitCounts[norm] > 4) {
        sub.status = STATUS.DONE;
        sub.answer = sub.accumulatedData.length || sub.notes.length
          ? `Stopped early: kept re-opening ${norm} (${urlVisitCounts[norm]}x) without finishing the task. ` +
            `Collected ${sub.accumulatedData.length} item(s), ${sub.notes.length} note(s) so far.`
          : `Stopped early: kept re-opening ${norm} (${urlVisitCounts[norm]}x) without finishing the task.`;
        subLog(sub, sub.answer, "warn");
        break;
      }

      let host = "";
      try {
        host = new URL(a.url).hostname;
      } catch (e) {
        /* leave host empty — can't track it */
      }
      const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
      if (host && !isLocal) {
        hostVisitCounts[host] = (hostVisitCounts[host] || 0) + 1;
        if (hostVisitCounts[host] > HOST_REVISIT_LIMIT) {
          sub.status = STATUS.DONE;
          sub.answer = sub.accumulatedData.length || sub.notes.length
            ? `Stopped early: kept re-opening ${host} (${hostVisitCounts[host]}x) without finishing the task. ` +
              `Collected ${sub.accumulatedData.length} item(s), ${sub.notes.length} note(s) so far.`
            : `Stopped early: kept re-opening ${host} (${hostVisitCounts[host]}x) without finishing the task.`;
          subLog(sub, sub.answer, "warn");
          break;
        }
      }
    }

    // A field-targeting action (type/select/check/press_key) that just failed on
    // THIS exact target will fail identically again — the failure is structural
    // (wrong element type, stale id), not transient — so don't spend the rest of
    // the iteration budget retrying it blind.
    if (
      RETRY_GUARDED_ACTIONS.has(a.type) &&
      sub.lastActionResult?.ok === false &&
      sub.lastActionResult.type === a.type &&
      sub.lastActionResult.targetId === a.targetId
    ) {
      sub.status = STATUS.DONE;
      sub.answer = sub.accumulatedData.length
        ? `Stopped early: retried "${a.type}" on ${a.targetId} right after it failed ` +
          `(${sub.lastActionResult.error}). Collected ${sub.accumulatedData.length} item(s) so far.`
        : `Stopped early: retried "${a.type}" on ${a.targetId} right after it failed (${sub.lastActionResult.error}).`;
      subLog(sub, sub.answer, "warn");
      break;
    }

    // Token release gate (B1): a server that only ever sees tokens can still try to
    // direct the client to type a real value somewhere it doesn't belong — a
    // malicious page's own content (or an injected instruction) asking the agent to
    // put a captured phone number into an unrelated comment box, or a value into a
    // navigate URL (classic exfiltration). Block and ask before releasing anything
    // that fails the policy; every decision is logged regardless of outcome.
    {
      let currentOrigin = null;
      try {
        currentOrigin = new URL(await getCurrentUrl(sub.tabId)).origin;
      } catch {}
      const release = checkTokenRelease(a, snapshot, VAULT, currentOrigin);
      if (!release.ok) {
        STATE.privacy.tokenReleaseBlocks = (STATE.privacy.tokenReleaseBlocks || 0) + release.blocked.length;
        for (const b of release.blocked) {
          STATE.tokenReleaseLog.push({ t: Date.now(), actionType: a.type, ...b });
          if (STATE.tokenReleaseLog.length > 100) STATE.tokenReleaseLog.shift();
        }
        const summary = release.blocked.map((b) => `${b.type} (${b.reason})`).join("; ");
        const allowed = await awaitConfirmation(sub, ctx, {
          actionType: a.type,
          targetId: a.targetId ?? null,
          description: `release ${summary} via ${a.type}`,
          kind: "token_release",
        });
        if (ctx.isCancelled()) break;
        if (!allowed) continue; // re-perceive/re-decide next turn rather than dispatching
      }
    }

    // Risky-action confirmation gate: pause and wait for an explicit user decision
    // before dispatching a click on something that looks irreversible/consequential.
    if (isRiskyAction(a, snapshot)) {
      const node = (snapshot.sanitizedDom || []).find((n) => n.id === a.targetId);
      const description = String(node?.text || `${a.type} on ${a.targetId ?? "element"}`).slice(0, 200);
      const allowed = await awaitConfirmation(sub, ctx, { actionType: a.type, targetId: a.targetId ?? null, description, kind: "risky_action" });
      if (ctx.isCancelled()) break;
      if (!allowed) continue; // re-perceive/re-decide next turn rather than dispatching
    }

    const detail = a.url || a.targetId || (a.amount != null ? `${a.amount}px` : "");
    subLog(sub, `server → ${a.type} ${detail} ${resp.reasoning ? "(" + resp.reasoning + ")" : ""}`);
    sub.status = STATUS.ACTING;
    await ctx.onUpdate();

    // A pause can take effect promptly here too — mid-iteration, not just at the
    // top of the loop — before we actually dispatch the action to the page.
    await waitWhilePaused(sub, ctx);
    if (ctx.isCancelled()) break;
    sub.status = STATUS.ACTING;
    await ctx.onUpdate();

    try {
      const actionRes = await dispatchAction(sub, a);
      sub.lastActionResult = { type: a.type, targetId: a.targetId ?? null, ok: !!actionRes?.ok, error: actionRes?.error ?? null };
      if (!actionRes?.ok) {
        subLog(sub, `action failed: ${actionRes?.error ?? "unknown"}`, "warn");
      } else if (a.type === "save_image" && actionRes.imageUrl) {
        // Content script only resolves the image URL — the actual download needs
        // chrome.downloads, only available here in the background context.
        try {
          await saveImageDownload(sub, ctx, actionRes, a.text || "");
        } catch (e) {
          subLog(sub, `save_image download failed: ${e.message}`, "warn");
        }
      }
    } catch (e) {
      sub.lastActionResult = { type: a.type, targetId: a.targetId ?? null, ok: false, error: e.message };
      subLog(sub, `action dispatch failed: ${e.message}`, "warn");
    }

    // No extra inter-step delay here: every action dispatched through content.js's
    // handleAction already goes through humanBehavior.js (humanClick/humanType/
    // humanScroll/...), which builds in realistic pointer/keystroke/scroll timing
    // and its own post-action settle pause. Stacking a flat 700-1500ms on top of
    // that on every single iteration only doubled real per-iteration latency
    // without adding any more realism, and worked directly against finishing
    // longer tasks within their iteration budget.
  }

  // Loop ended without an explicit done → best-effort fallback.
  if (sub.status !== STATUS.DONE && sub.status !== STATUS.ERROR) {
    sub.status = STATUS.DONE;
    if (ctx.isCancelled()) {
      sub.answer = "Cancelled by user.";
    } else if (sub.accumulatedData.length) {
      sub.answer =
        `Stopped after ${sub.maxIterations} iterations without a final answer. ` +
        `Collected ${sub.accumulatedData.length} item(s) so far` +
        (sub.targetCount ? ` (target ${sub.targetCount}).` : ".");
    } else {
      sub.answer =
        `Stopped after ${sub.maxIterations} iterations without reaching an answer. ` +
        `Try a more specific task, or check the status log.`;
    }
    subLog(sub, sub.answer, "warn");
  }
  await ctx.onUpdate();
  return sub;
}

// --- Planning (/agent/plan) ---

function singleAgentPlan(prompt) {
  return { subtasks: [{ id: "sub_1", goal: prompt, startUrl: null }], reasoning: "single-agent mode" };
}

async function fetchPlan(prompt, currentUrl) {
  try {
    const res = await withTimeout(
      fetch(DEFAULTS.planServerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: await tokenizeOutgoing(prompt, VAULT, backgroundNerTag(STATE.settings?.perceptionMode !== "eco")),
          currentUrl: sanitizeUrl(currentUrl, VAULT),
        }),
      }),
      DEFAULTS.iterationTimeoutMs,
      "plan-server",
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!Array.isArray(data?.subtasks) || data.subtasks.length === 0) {
      throw new Error("plan response missing subtasks");
    }
    return { subtasks: data.subtasks, reasoning: data.reasoning ?? "" };
  } catch (e) {
    log(`plan call failed (${e.message}); falling back to single-agent plan`, "warn");
    return null; // caller falls back to singleAgentPlan — planning must never abort the task
  }
}

// --- Synthesis (/agent/synthesize) ---

function localSynthesize(originalPrompt, subAgentResults) {
  return subAgentResults
    .map((r) => `## ${r.goal}\n${r.answer || "(failed: " + (r.error || "unknown error") + ")"}\n`)
    .join("\n");
}

async function synthesize(ctx, originalPrompt, subAgentResults) {
  if (ctx.localOnly) return localSynthesize(originalPrompt, subAgentResults);
  try {
    const res = await withTimeout(
      fetch(DEFAULTS.synthesizeServerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          egressGate(
            {
              originalPrompt: await tokenizeOutgoing(originalPrompt, VAULT),
              subAgentResults: subAgentResults.map((r) => ({ ...r, answer: r.answerTokenized ?? r.answer })),
            },
            VAULT,
          ).body,
        ),
      }),
      DEFAULTS.iterationTimeoutMs,
      "synthesize-server",
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (typeof data?.answer !== "string") throw new Error("synthesize response missing answer");
    return VAULT.resolve(data.answer);
  } catch (e) {
    log(`synthesize call failed (${e.message}); using local concatenation fallback`, "warn");
    return localSynthesize(originalPrompt, subAgentResults);
  }
}

// --- Orchestration: today's single-tab path, unchanged in spirit ---

async function runSingleAgent(tab) {
  const subtask = STATE.plan.subtasks[0];
  const sub = {
    id: subtask.id || "sub_1",
    goal: subtask.goal || STATE.prompt,
    startUrl: subtask.startUrl || null,
    tabId: STATE.tabId,
    windowId: tab.windowId,
    status: STATUS.PERCEIVING,
    iteration: 0,
    maxIterations: STATE.maxIterations,
    accumulatedData: [],
    answer: null,
    error: null,
    log: [],
    lastRedactionSummary: null,
    lastRedactionLog: [],
    lastVisionMode: null,
    lastScreenState: null,
    lastThumbnail: null,
    narration: [],
    notes: [],
    savedImages: [],
    reportFiles: [],
    metrics: { iterations: [] },
    cancelRequested: false,
    logPrefix: "",
  };
  STATE.subAgents = [sub];

  const ctx = {
    serverUrl: STATE.serverUrl,
    localOnly: STATE.localOnly,
    memoryFacts: STATE.memoryFacts,
    taskId: STATE.taskId,
    isCancelled: () => STATE.cancelRequested,
    isPaused: () => STATE.pauseRequested,
    onUpdate: async () => {
      mirrorSubToState(sub);
      await broadcast();
    },
  };

  if (sub.startUrl) {
    try {
      await navAction(sub, { type: "navigate", url: sub.startUrl });
    } catch (e) {
      subLog(sub, `startUrl navigation failed: ${e.message}`, "warn");
    }
  }

  await runSubLoop(sub, ctx);
  mirrorSubToState(sub);
  STATE.localOnly = ctx.localOnly;
}

// --- Orchestration: multi sub-agent path (Comet mode) ---

async function runMultiAgent(tab) {
  STATE.status = STATUS.DELEGATING;
  await broadcast();

  const subtasks = STATE.plan.subtasks;
  const originalUrl = tab.url;
  const subAgents = [];
  const openedWindowIds = [];

  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    const subId = st.id || `sub_${i + 1}`;
    const sub = {
      id: subId,
      goal: st.goal || STATE.prompt,
      startUrl: st.startUrl || null,
      tabId: null,
      windowId: null,
      status: STATUS.PERCEIVING,
      iteration: 0,
      maxIterations: STATE.maxIterations,
      accumulatedData: [],
      answer: null,
      error: null,
      log: [],
      lastRedactionSummary: null,
      lastRedactionLog: [],
      lastVisionMode: null,
      lastScreenState: null,
      lastThumbnail: null,
      narration: [],
      notes: [],
      savedImages: [],
      reportFiles: [],
      metrics: { iterations: [] },
      cancelRequested: false,
      logPrefix: `[${subId}] `,
      isPrimary: i === 0,
    };

    if (sub.isPrimary) {
      // First subtask reuses the original tab/window — no new window needed.
      sub.tabId = STATE.tabId;
      sub.windowId = tab.windowId;
    } else {
      // chrome.tabs.captureVisibleTab only captures a window's ACTIVE tab, so each
      // other sub-agent needs its own independent (unfocused) window.
      try {
        const win = await chrome.windows.create({ url: sub.startUrl || originalUrl, focused: false });
        sub.windowId = win.id;
        const tabsInWin = await chrome.tabs.query({ windowId: win.id });
        sub.tabId = tabsInWin[0]?.id ?? null;
        openedWindowIds.push(win.id);
        if (sub.tabId) await waitForTabLoad(sub.tabId);
      } catch (e) {
        sub.status = STATUS.ERROR;
        sub.error = `could not open window: ${e.message}`;
      }
    }
    subAgents.push(sub);
  }

  STATE.subAgents = subAgents;
  await broadcast();

  const ctx = {
    serverUrl: STATE.serverUrl,
    localOnly: STATE.localOnly,
    memoryFacts: STATE.memoryFacts,
    taskId: STATE.taskId,
    isCancelled: () => STATE.cancelRequested,
    isPaused: () => STATE.pauseRequested,
    onUpdate: async () => {
      await broadcast(); // STATE.subAgents holds these sub objects by reference
    },
  };

  // One sub-agent erroring must not stop the others — each is caught individually,
  // and Promise.allSettled never rejects regardless.
  await Promise.allSettled(
    subAgents.map(async (sub) => {
      if (sub.status === STATUS.ERROR) return; // window failed to open
      try {
        if (!sub.tabId) {
          sub.status = STATUS.ERROR;
          sub.error = "no tab available for sub-agent";
          return;
        }
        if (sub.isPrimary && sub.startUrl) {
          await navAction(sub, { type: "navigate", url: sub.startUrl });
        } else {
          await ensureContentScript(sub.tabId);
        }
        await runSubLoop(sub, ctx);
      } catch (e) {
        sub.status = STATUS.ERROR;
        sub.error = `sub-agent crashed: ${e.message}`;
        subLog(sub, sub.error, "error");
      }
    }),
  );

  STATE.localOnly = ctx.localOnly;
  STATE.accumulatedData = mergeAllSubData(subAgents);

  // Close every extra window we opened and restore focus to the original one,
  // regardless of whether we stopped normally, on error, or on cancellation.
  for (const winId of openedWindowIds) {
    try {
      await chrome.windows.remove(winId);
    } catch (e) {
      /* already closed by the user — fine */
    }
  }
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(STATE.tabId, { active: true });
  } catch (e) {
    /* original tab/window may have been closed — fine */
  }

  STATE.status = STATUS.SYNTHESIZING;
  await broadcast();

  const subAgentResults = subAgents.map((sub) => ({
    goal: sub.goal,
    answer: sub.answer,
    answerTokenized: sub.answerTokenized,
    extractedItems: sub.accumulatedData,
    error: sub.error,
  }));

  STATE.answer = await synthesize(ctx, STATE.prompt, subAgentResults);
  STATE.status = STATUS.DONE;
}

async function orchestrate(tab, multiAgent, startedAt) {
  RUNNING = true;
  startKeepAlive();
  STATE.status = STATUS.PLANNING;
  await broadcast();

  if (STATE.localOnly || !multiAgent) {
    STATE.plan = singleAgentPlan(STATE.prompt);
  } else {
    const currentUrl = await getCurrentUrl(STATE.tabId);
    STATE.plan = (await fetchPlan(STATE.prompt, currentUrl)) ?? singleAgentPlan(STATE.prompt);
  }
  if (!Array.isArray(STATE.plan.subtasks) || STATE.plan.subtasks.length === 0) {
    STATE.plan = singleAgentPlan(STATE.prompt);
  }
  STATE.plan.subtasks = STATE.plan.subtasks.slice(0, DEFAULTS.maxSubAgents);
  // Deterministic fallback: don't rely on the planner/LLM to have caught a named
  // well-known site — if it names one and didn't already set startUrl, resolve it now.
  for (const st of STATE.plan.subtasks) {
    if (!st.startUrl) {
      const guess = resolveKnownSiteUrl(st.goal);
      if (guess) st.startUrl = guess;
    }
  }
  log(`plan: ${STATE.plan.subtasks.length} subtask(s) — ${STATE.plan.reasoning || ""}`);
  await broadcast();

  if (STATE.plan.subtasks.length <= 1) {
    await runSingleAgent(tab);
  } else {
    await runMultiAgent(tab);
  }

  try {
    await addHistoryEntry({
      taskId: STATE.taskId,
      prompt: STATE.prompt,
      startedAt,
      finishedAt: Date.now(),
      status: STATE.status,
      answer: STATE.answer,
      itemCount: STATE.accumulatedData.length,
      host: hostFromUrl(tab.url),
      plan: STATE.plan,
      subAgents: STATE.subAgents,
    });
  } catch (e) {
    log(`history write failed: ${e.message}`, "warn");
  }

  RUNNING = false;
  stopKeepAlive();
  notifyTaskComplete(STATE.status, STATE.status === STATUS.ERROR ? STATE.error : STATE.answer);
  await broadcast();
}

async function startTask({ prompt, serverUrl, localOnly, multiAgentEnabled, maxIterations }) {
  if (RUNNING) {
    log("a task is already running; ignoring RUN_TASK", "warn");
    return;
  }
  const startedAt = Date.now();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    STATE = freshState();
    STATE.status = STATUS.ERROR;
    STATE.error = "no active tab";
    await broadcast();
    return;
  }

  STATE = freshState();
  VAULT = new Vault();
  STATE.settings = await loadSettings();
  STATE.taskId = crypto.randomUUID();
  STATE.prompt = prompt.trim();
  STATE.serverUrl = serverUrl || DEFAULTS.serverUrl;
  STATE.localOnly = !!localOnly;
  STATE.tabId = tab.id;
  STATE.targetCount = parseTargetCount(STATE.prompt);
  STATE.maxIterations = Math.max(
    1,
    Math.min(parseInt(maxIterations, 10) || DEFAULTS.maxIterations, DEFAULTS.maxIterationsCeiling),
  );
  const multiAgent = multiAgentEnabled === undefined ? DEFAULTS.multiAgentEnabled : !!multiAgentEnabled;

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

  if (!(await ensureContentScript(STATE.tabId))) {
    STATE.status = STATUS.ERROR;
    STATE.error = "could not inject the content script on this page";
    await broadcast();
    return;
  }

  try {
    STATE.memoryFacts = await getMemoryFacts();
  } catch (e) {
    STATE.memoryFacts = []; // memoryStore may not be ready / storage unavailable
  }

  // Brave exposes navigator.brave in every context (including extension service
  // workers) specifically so extensions can detect it — logged for diagnostics
  // only; every chrome.* API this extension uses is the same in Brave (Chromium
  // MV3), so nothing here branches on it. The one Brave-specific risk is its
  // Shields fingerprinting protection perturbing canvas readback, which would
  // only affect the (already-optional, mock-fallback) vision pipeline, not core
  // browsing/action functionality.
  let browserNote = "";
  try {
    if (await navigator.brave?.isBrave?.()) browserNote = ", browser=Brave";
  } catch (e) {
    /* not Brave, or API unavailable — fine either way */
  }

  // load models while the planner runs (first run pays model load once)
  perception("warmup", { keys: STATE.settings.perceptionMode === "eco" ? ["face"] : ["face", "clip", "ner"] })
    .then((stats) => (STATE.engineStats = stats))
    .catch((e) => log(`perception warmup failed: ${e.message}`, "warn"));

  log(
    `task "${STATE.prompt}" on ${tab.url} (target=${STATE.targetCount || "n/a"}, ` +
      `localOnly=${STATE.localOnly}, multiAgent=${multiAgent}${browserNote})`,
  );
  await broadcast();

  orchestrate(tab, multiAgent, startedAt).catch(async (e) => {
    STATE.status = STATUS.ERROR;
    STATE.error = `loop crashed: ${e.message}`;
    log(STATE.error, "error");
    RUNNING = false;
    stopKeepAlive();
    notifyTaskComplete(STATE.status, STATE.error);
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
  if (msg?.type === MSG.PAUSE_TASK) {
    STATE.pauseRequested = true;
    log("pause requested", "warn");
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.RESUME_TASK) {
    STATE.pauseRequested = false;
    log("resume requested", "warn");
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.CONFIRM_ACTION) {
    if (STATE.pendingConfirmation) {
      STATE.pendingConfirmation.resolution = msg?.payload?.allow ? "allow" : "deny";
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === MSG.GET_STATE) {
    sendResponse({ type: MSG.STATE_UPDATE, state: STATE });
    return false;
  }
  if (msg?.type === MSG.PRIVACY_PREVIEW) {
    privacyPreview(msg.payload ?? {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === MSG.WARMUP) {
    loadSettings()
      .then((st) => perception("warmup", { keys: st.perceptionMode === "eco" ? ["face"] : ["face", "clip", "ner"] }))
      .then((stats) => {
        STATE.engineStats = stats;
        sendResponse({ ok: true, stats });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === MSG.SAVE_SETTINGS) {
    // Merge, not replace — different popup controls (perception mode, custom
    // terms, per-site policy) each save independently; a full replace from one
    // would silently wipe out whatever another one had just stored.
    chrome.storage.local
      .get(SETTINGS_KEY)
      .then((r) => chrome.storage.local.set({ [SETTINGS_KEY]: { ...(r[SETTINGS_KEY] || {}), ...msg.payload } }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

// "Privacy X-ray": run one perception + redaction pass on the active tab (no server
// call) and return exactly what WOULD leave the device, plus geometry in CSS px for
// the eval harness. Uses a throwaway vault so it never disturbs a running task.
async function privacyPreview({ tabId, mode }) {
  let tab;
  if (tabId) tab = await chrome.tabs.get(tabId);
  else [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return { ok: false, error: "no active tab" };
  if (!(await ensureContentScript(tab.id))) return { ok: false, error: "cannot access this page" };
  const settings = { ...(await loadSettings()), ...(mode ? { perceptionMode: mode } : {}) };
  const vault = new Vault();
  const t0 = performance.now();
  const { snapshot, visual, timings } = await perceiveStep({ tabId: tab.id, windowId: tab.windowId, vault, settings, targetCount: 0 });
  if (!snapshot?.ok) return { ok: false, error: snapshot?.error ?? "perception failed" };
  const scale = snapshot.viewport.dpr || 1;
  const css = (b) => ({ x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale });
  const stats = await perception("stats").catch(() => null);
  return {
    ok: true,
    totalMs: Math.round(performance.now() - t0),
    timings,
    viewport: snapshot.viewport,
    redactedImage: visual?.redactedImage ?? null,
    redactedBytes: visual?.redactedBytes ?? 0,
    screen: visual?.screen ?? null,
    regions: visual?.regions ?? [],
    boxCounts: visual?.boxCounts ?? null,
    cacheHit: !!visual?.cacheHit,
    visionError: visual?.error ?? null,
    boxes: [
      ...snapshot.piiBoxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, type: b.type, label: b.label, source: b.source })),
      ...(visual?.faces ?? []).map((f) => ({ ...css(f), type: "FACE", source: f.via })),
      ...(visual?.ocrBoxes ?? []).map((b) => ({ ...css(b), type: b.type, label: b.label, source: "ocr" })),
    ],
    sensitiveRegions: (visual?.regions ?? []).filter((r) => r.sensitive).map((r) => r.id),
    rois: snapshot.rois,
    sanitizedDom: snapshot.sanitizedDom,
    redactionSummary: snapshot.redactionSummary,
    tokens: vault.catalog(),
    engine: stats,
    frameCount: snapshot.frameCount ?? 1,
    unreachableFrames: snapshot.unreachableFrames ?? [],
  };
}

const TERMINAL_STATUSES = new Set([STATUS.IDLE, STATUS.DONE, STATUS.ERROR]);

// Restore mirrored state on worker wake-up. `RUNNING` is always false here (it's a
// fresh module instance) even if the *previous* instance was killed mid-task by
// Chrome's MV3 service-worker idle timeout (a real risk on a task with several
// windows/iterations — e.g. after the browser is backgrounded/minimized for a
// while). A non-terminal restored status means exactly that happened: the loop
// that would have finished it is gone, so leaving it as-is would show a
// perpetually "running" UI with no loop behind it. Surface it as a clear, terminal
// error instead of silently stuck — the next Run starts a clean task.
chrome.storage.session.get(STATE_KEY).then((r) => {
  stopKeepAlive(); // drop any alarm left over from a run that got killed mid-task
  if (!r?.[STATE_KEY]) return;
  STATE = {
    ...freshState(),
    ...r[STATE_KEY],
    cancelRequested: false,
    pauseRequested: false,
    pendingConfirmation: null,
  };
  if (!TERMINAL_STATUSES.has(STATE.status)) {
    STATE.status = STATUS.ERROR;
    STATE.error =
      "The browser paused this extension mid-task (often triggered by switching windows/screens for a while) " +
      "and the run couldn't finish. Any tabs/windows it had already opened were left as-is — close them if " +
      "no longer needed, then click Run to retry.";
    log(STATE.error, "error");
    broadcast();
  }
});
