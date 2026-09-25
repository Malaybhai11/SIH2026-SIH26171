// Popup UI — a thin view over the background worker's state. All logic lives in
// background.js; the popup only sends RUN_TASK / CANCEL_TASK and renders STATE_UPDATE.

import { MSG, STATUS } from "./lib/messages.js";
import { renderMarkdownLite } from "./lib/markdownLite.js";
import { saveTemplate, getTemplates } from "./lib/memoryStore.js";

const $ = (id) => document.getElementById(id);
const els = {
  prompt: $("prompt"),
  serverUrl: $("serverUrl"),
  maxIterations: $("maxIterations"),
  localOnly: $("localOnly"),
  multiAgent: $("multiAgent"),
  run: $("run"),
  cancel: $("cancel"),
  takeOver: $("takeOver"),
  resumeTask: $("resumeTask"),
  status: $("status"),
  answer: $("answer"),
  copyAnswer: $("copyAnswer"),
  collected: $("collected"),
  chips: $("chips"),
  templateChips: $("templateChips"),
  templateChipsGroup: $("templateChipsGroup"),
  saveTemplateBtn: $("saveTemplateBtn"),
  templateLabel: $("templateLabel"),
  taskPanel: $("taskPanel"),
  planPanel: $("planPanel"),
  planCount: $("planCount"),
  planBody: $("planBody"),
  subAgentsPanel: $("subAgentsPanel"),
  subAgentsCount: $("subAgentsCount"),
  subAgentsBody: $("subAgentsBody"),
  notesPanel: $("notesPanel"),
  notesCount: $("notesCount"),
  notesBody: $("notesBody"),
  redactPanel: $("redactPanel"),
  redactCount: $("redactCount"),
  redactBody: $("redactBody"),
  metricsPanel: $("metricsPanel"),
  metricsBody: $("metricsBody"),
  logPanel: $("logPanel"),
  logCount: $("logCount"),
  log: $("log"),
  openDashboard: $("openDashboard"),
  confirmBanner: $("confirmBanner"),
  confirmText: $("confirmText"),
  confirmAllow: $("confirmAllow"),
  confirmDeny: $("confirmDeny"),
  pauseBanner: $("pauseBanner"),
  pauseText: $("pauseText"),
  // Tab bar — buttons keyed by the same names as the panels above, so
  // showTab()/updateTabAvailability() can index both by one name.
  tabTask: $("tabTask"),
  tabPlan: $("tabPlan"),
  tabSubAgents: $("tabSubAgents"),
  tabNotes: $("tabNotes"),
  tabRedact: $("tabRedact"),
  tabPrivacy: $("tabPrivacy"),
  privacyPanel: $("privacyPanel"),
  previewBtn: $("previewBtn"),
  previewInfo: $("previewInfo"),
  xray: $("xray"),
  perceptionMode: $("perceptionMode"),
  sendScreenshot: $("sendScreenshot"),
  humanize: $("humanize"),
  tabMetrics: $("tabMetrics"),
  tabLog: $("tabLog"),
};

const BADGE_CLASS = {
  [STATUS.IDLE]: "",
  [STATUS.PLANNING]: "run",
  [STATUS.PERCEIVING]: "run",
  [STATUS.REDACTING]: "run",
  [STATUS.REASONING]: "run",
  [STATUS.ACTING]: "run",
  [STATUS.DELEGATING]: "run",
  [STATUS.SYNTHESIZING]: "run",
  [STATUS.PAUSED]: "warn",
  [STATUS.AWAITING_CONFIRMATION]: "warn",
  [STATUS.DONE]: "done",
  [STATUS.ERROR]: "err",
};

// ---- Tabs ----
// Keyed by a short name; new tabs (from the integration pass) just need an
// entry here plus a `data-tab` button + panel with a matching id convention.
const TAB_PANELS = {
  task: els.taskPanel,
  plan: els.planPanel,
  subAgents: els.subAgentsPanel,
  notes: els.notesPanel,
  privacy: els.privacyPanel,
  redact: els.redactPanel,
  metrics: els.metricsPanel,
  log: els.logPanel,
};
const TAB_BUTTONS = {
  task: els.tabTask,
  plan: els.tabPlan,
  subAgents: els.tabSubAgents,
  notes: els.tabNotes,
  privacy: els.tabPrivacy,
  redact: els.tabRedact,
  metrics: els.tabMetrics,
  log: els.tabLog,
};

let activeTab = "task";

function showTab(name) {
  if (!TAB_PANELS[name]) return;
  activeTab = name;
  for (const key of Object.keys(TAB_PANELS)) {
    TAB_PANELS[key].hidden = key !== name;
    TAB_BUTTONS[key].classList.toggle("active", key === name);
  }
}

// Some tabs (Plan, Sub-agents) only make sense once there's actually
// multi-part data — mirrors the old hidden-<details> behavior. If the
// currently active tab gets hidden out from under the user, fall back to Task.
function setTabAvailable(name, available) {
  const btn = TAB_BUTTONS[name];
  if (!btn) return;
  btn.hidden = !available;
  if (!available && activeTab === name) showTab("task");
}

for (const [name, btn] of Object.entries(TAB_BUTTONS)) {
  btn.addEventListener("click", () => showTab(name));
}

// ---- Example prompt chips ----
// Shown only while the task is idle and the textarea is empty — not
// load-bearing, just the cleanest signal that "the user hasn't started yet".
els.chips.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    els.prompt.value = chip.textContent;
    els.prompt.focus();
    updateChipsVisibility();
  });
});

let lastStatus = STATUS.IDLE;
function updateChipsVisibility() {
  const idle = lastStatus === STATUS.IDLE || lastStatus === STATUS.DONE || lastStatus === STATUS.ERROR;
  els.chips.hidden = !idle || els.prompt.value.trim().length > 0;
}
els.prompt.addEventListener("input", updateChipsVisibility);

// ---- Saved templates ----
let cachedTemplates = [];

function renderTemplateChips() {
  const has = cachedTemplates.length > 0;
  els.templateChipsGroup.hidden = !has;
  els.templateChips.hidden = !has;
  if (!has) {
    els.templateChips.innerHTML = "";
    return;
  }
  els.templateChips.innerHTML = cachedTemplates
    .map((t, i) => `<button class="chip" type="button" data-idx="${i}">${escapeHtml(t.label || t.prompt.slice(0, 40))}</button>`)
    .join("");
  els.templateChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const t = cachedTemplates[Number(chip.dataset.idx)];
      if (!t) return;
      els.prompt.value = t.prompt;
      els.prompt.focus();
      updateChipsVisibility();
    });
  });
}

async function loadTemplates() {
  try {
    cachedTemplates = await getTemplates();
  } catch (e) {
    cachedTemplates = [];
  }
  renderTemplateChips();
}
loadTemplates();

els.saveTemplateBtn.addEventListener("click", () => {
  if (!els.templateLabel.hidden) {
    els.templateLabel.hidden = true;
    return;
  }
  els.templateLabel.hidden = false;
  els.templateLabel.value = "";
  els.templateLabel.focus();
});

async function commitTemplateSave() {
  const label = els.templateLabel.value.trim();
  const promptText = els.prompt.value;
  els.templateLabel.hidden = true;
  if (!label || !promptText.trim()) return; // no-op if prompt is empty
  try {
    await saveTemplate(label, promptText);
    await loadTemplates();
  } catch (e) {
    /* best-effort */
  }
}
els.templateLabel.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    commitTemplateSave();
  } else if (ev.key === "Escape") {
    els.templateLabel.hidden = true;
  }
});
els.templateLabel.addEventListener("blur", () => {
  if (!els.templateLabel.hidden) commitTemplateSave();
});

// ---- Take over / Resume / Confirmation ----
els.takeOver.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.PAUSE_TASK });
});
els.resumeTask.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.RESUME_TASK });
});
els.confirmAllow.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.CONFIRM_ACTION, payload: { allow: true } });
});
els.confirmDeny.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.CONFIRM_ACTION, payload: { allow: false } });
});

// ---- Copy answer ----
let lastState = null;
els.copyAnswer.addEventListener("click", async () => {
  const text = lastState?.answer || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const original = els.copyAnswer.textContent;
    els.copyAnswer.textContent = "Copied!";
    setTimeout(() => {
      els.copyAnswer.textContent = original;
    }, 1500);
  } catch (e) {
    /* clipboard permission denied or unavailable — ignore */
  }
});

function render(state) {
  if (!state) return;
  lastState = state;
  lastStatus = state.status;
  const running = ![STATUS.IDLE, STATUS.DONE, STATUS.ERROR].includes(state.status);

  els.status.textContent = state.status + (state.iteration ? ` ${state.iteration}/${state.maxIterations}` : "");
  els.status.className = "badge " + (BADGE_CLASS[state.status] ?? "");
  els.run.disabled = running;
  els.cancel.disabled = !running;

  // Take-over / pause banner — mutually exclusive: the Take-over button offers to
  // pause a live run; once paused, it's replaced by the pause banner + Resume.
  const paused = state.status === STATUS.PAUSED;
  els.takeOver.hidden = !running || paused;
  els.pauseBanner.hidden = !paused;
  if (paused) {
    els.pauseText.textContent = state.error || "Paused — click Resume to continue.";
  }

  // Confirmation banner — needs attention regardless of the active tab.
  const awaitingConfirm = state.status === STATUS.AWAITING_CONFIRMATION && !!state.pendingConfirmation;
  els.confirmBanner.hidden = !awaitingConfirm;
  if (awaitingConfirm) {
    const isTokenRelease = state.pendingConfirmation.kind === "token_release";
    els.confirmBanner.classList.toggle("token-release", isTokenRelease);
    els.confirmText.textContent = isTokenRelease
      ? `Privacy guard — ${state.pendingConfirmation.description || "blocked a value release"}`
      : state.pendingConfirmation.description || "Confirm this action?";
  }

  if (state.status === STATUS.ERROR) {
    els.answer.textContent = state.error || "error";
    els.answer.classList.remove("muted");
  } else if (state.answer) {
    els.answer.innerHTML = renderMarkdownLite(state.answer);
    els.answer.classList.remove("muted");
  } else {
    els.answer.textContent = "—";
    els.answer.classList.add("muted");
  }

  updateChipsVisibility();

  els.collected.textContent = state.accumulatedData?.length
    ? `${state.accumulatedData.length} item(s) collected` +
      (state.lastVisionMode ? ` · vision: ${state.lastVisionMode}` : "") +
      (state.lastScreenState ? ` · screen: ${state.lastScreenState}` : "") +
      (state.localOnly ? " · LOCAL-ONLY" : "")
    : state.lastVisionMode
      ? `vision: ${state.lastVisionMode}${state.localOnly ? " · LOCAL-ONLY" : ""}`
      : "";

  // Plan tab — only shown for genuinely multi-part tasks (>1 subtask); simple
  // tasks look identical to before this feature existed.
  const subtasks = state.plan?.subtasks ?? [];
  if (subtasks.length > 1) {
    setTabAvailable("plan", true);
    els.planCount.textContent = subtasks.length;
    const items = subtasks.map((s, i) => `<li>${escapeHtml(s.goal)}</li>`).join("");
    els.planBody.innerHTML =
      `<ol style="margin:4px 0 6px 18px;padding:0">${items}</ol>` +
      (state.plan?.reasoning ? `<p class="muted">${escapeHtml(state.plan.reasoning)}</p>` : "");
  } else {
    setTabAvailable("plan", false);
  }

  // Sub-agents tab — only shown once there's more than one sub-agent running.
  const subAgents = state.subAgents ?? [];
  if (subAgents.length > 1) {
    setTabAvailable("subAgents", true);
    els.subAgentsCount.textContent = subAgents.length;
    els.subAgentsBody.innerHTML = subAgents
      .map((sa) => {
        const badgeClass = BADGE_CLASS[sa.status] ?? "";
        const iter = sa.iteration ? ` ${sa.iteration}/${sa.maxIterations}` : "";
        const result = sa.status === STATUS.DONE || sa.status === STATUS.ERROR
          ? `<div class="muted">${escapeHtml(truncate(sa.error || sa.answer || "", 200))}</div>`
          : "";
        const thumb = sa.lastThumbnail
          ? `<img class="subagent-thumb" src="${sa.lastThumbnail}" alt="" />`
          : "";
        const lastNarration = sa.narration?.length ? sa.narration[sa.narration.length - 1] : null;
        const thinking = lastNarration
          ? `<div class="subagent-thinking">${escapeHtml(truncate(lastNarration.text, 160))}</div>`
          : "";
        return `<div class="subagent-row">
          <div class="subagent-main">
            ${thumb}
            <div class="subagent-info">
              <div class="subagent-head">
                <code>${escapeHtml(sa.id)}</code>
                <span class="badge ${badgeClass}">${escapeHtml(sa.status)}${iter}</span>
              </div>
              <div>${escapeHtml(truncate(sa.goal, 140))}</div>
              ${thinking}
              ${result}
            </div>
          </div>
        </div>`;
      })
      .join("");
  } else {
    setTabAvailable("subAgents", false);
  }

  // Notes tab — every sub-agent's notes combined, newest first, plus any images
  // the agent downloaded (save_image) and reports it compiled (compile_report) —
  // both are real files on disk (via chrome.downloads), so surfacing the exact
  // filenames here is what tells the user where to actually find them.
  const allNotes = subAgents
    .flatMap((sa) => (sa.notes || []).map((n) => ({ ...n, subId: sa.id })))
    .sort((a, b) => b.t - a.t);
  const allImages = subAgents.flatMap((sa) => sa.savedImages || []);
  const allReports = subAgents.flatMap((sa) => sa.reportFiles || []);
  if (allNotes.length || allImages.length || allReports.length) {
    setTabAvailable("notes", true);
    els.notesCount.textContent = allNotes.length;
    const notesHtml = allNotes
      .map(
        (n) => `<div class="note-row">
          <div class="note-head">
            ${n.label ? `<span class="pill">${escapeHtml(n.label)}</span>` : ""}
            <span class="muted">${new Date(n.t).toLocaleTimeString()}</span>
          </div>
          <div>${escapeHtml(n.text)}</div>
        </div>`,
      )
      .join("");
    const imagesHtml = allImages.length
      ? `<div class="chip-group-label small muted">Saved images (Downloads/)</div>` +
        allImages
          .map(
            (img) => `<div class="note-row">
              <div class="note-head"><code>${escapeHtml(img.filename)}</code></div>
              ${img.caption ? `<div>${escapeHtml(img.caption)}</div>` : ""}
            </div>`,
          )
          .join("")
      : "";
    const reportsHtml = allReports.length
      ? `<div class="chip-group-label small muted">Report files (Downloads/)</div>` +
        allReports.map((r) => `<div class="note-row"><code>${escapeHtml(r.filename)}</code></div>`).join("")
      : "";
    els.notesBody.innerHTML = notesHtml + imagesHtml + reportsHtml;
  } else {
    setTabAvailable("notes", false);
  }

  // Redaction tab
  const sum = state.lastRedactionSummary;
  els.redactCount.textContent = sum?.total ?? 0;
  if (sum && sum.total > 0) {
    const byType = Object.entries(sum.byType)
      .map(([t, c]) => `<span class="rtype">${t}: ${c}</span>`)
      .join("");
    const perEl = (state.lastRedactionLog || [])
      .reduce((acc, e) => {
        (acc[e.elementId] ||= []).push(e.type);
        return acc;
      }, {});
    const rows = Object.entries(perEl)
      .map(([id, types]) => `<div><code>${id}</code>: ${types.join(", ")}</div>`)
      .join("");
    els.redactBody.innerHTML =
      `<p>${sum.total} span(s) across ${sum.elements} element(s). Values never leave the device.</p>` +
      byType +
      `<div style="margin-top:6px">${rows}</div>`;
  } else {
    els.redactBody.innerHTML = `<p class="muted">No PII detected in the extracted context.</p>`;
  }

  // Metrics tab — per-step latency breakdown + client resource use
  const iters = state.metrics?.iterations ?? [];
  const eng = state.engineStats;
  const engHtml = eng
    ? `<div class="kv2">
        <span>backend</span><b>${escapeHtml(eng.ep || "-")}${eng.threads ? ` · ${eng.threads} thr` : ""}</b>
        <span>models loaded</span><b>${eng.modelMB ?? 0} MB (${Object.keys(eng.models || {}).join(", ") || "none"})</b>
        <span>JS heap (engine)</span><b>${eng.memory ? `${eng.memory.jsHeapUsedMB} MB` : "n/a"}</b>
        <span>cache hits</span><b>frame ${eng.cache?.frame ?? 0} · regions ${eng.cache?.region ?? 0} · NER ${eng.cache?.ner ?? 0}</b>
        <span>privacy</span><b>${state.privacy?.boxesPainted ?? 0} boxes painted · ${state.privacy?.tokens ?? 0} tokens · gate fixes ${state.privacy?.gateFixes ?? 0} · ${Math.round((state.privacy?.bytesSent ?? 0) / 1024)} KB sent</b>
        <span>token release blocks</span><b>${state.privacy?.tokenReleaseBlocks ?? 0}</b>
      </div>`
    : "";
  if (iters.length) {
    const head = `<tr><th>#</th><th>DOM</th><th>text PII</th><th>vision</th><th>paint</th><th>server</th><th>total</th></tr>`;
    const body = iters
      .map(
        (m) =>
          `<tr><td>${m.iteration}</td><td>${m.domMs ?? "-"}</td><td>${m.textPiiMs ?? "-"}</td><td>${m.visionMs ?? "-"}${m.cacheHit ? "*" : ""}</td><td>${m.paintMs ?? "-"}</td><td>${m.serverMs ?? "-"}</td><td>${m.totalMs ?? "-"}</td></tr>`,
      )
      .join("");
    const avg = (k) => Math.round(iters.reduce((a, m) => a + (m[k] || 0), 0) / iters.length);
    els.metricsBody.innerHTML =
      engHtml +
      `<table class="metrics">${head}${body}</table><p class="muted">avg on-device perception ${avg("perceptionMs")} ms · avg step ${avg("totalMs")} ms · * = frame cache hit</p>`;
  } else {
    els.metricsBody.innerHTML = engHtml + `<p class="muted">No iterations yet.</p>`;
  }

  // Privacy X-ray — during a task, show the last frame the server received
  if (state.lastRedactedImage && !previewShown) renderXray({ redactedImage: state.lastRedactedImage, ...state.lastVisual, tokens: state.vaultCatalog, live: true });

  // Log tab
  const logEntries = state.log || [];
  els.logCount.textContent = logEntries.length;
  els.log.innerHTML = logEntries
    .slice(-80)
    .map((e) => `<li class="${e.level}">${new Date(e.t).toLocaleTimeString()}  ${escapeHtml(e.msg)}</li>`)
    .join("");
  els.log.scrollTop = els.log.scrollHeight;
}

// ---- Privacy X-ray ----
let previewShown = false;
function renderXray(r) {
  const counts = r.boxCounts
    ? `<div class="chips-row">
        <span class="rtype">text ${r.boxCounts.text}</span><span class="rtype">fields ${r.boxCounts.fields}</span>
        <span class="rtype">faces ${r.boxCounts.faces}</span><span class="rtype">images ${r.boxCounts.regions}</span></div>`
    : "";
  const screen = r.screen ? `<div>screen: <b>${escapeHtml(r.screen.state)}</b> (${r.screen.confidence})</div>` : "";
  const regions = (r.regions || []).length
    ? `<div class="muted">images: ${r.regions.map((x) => `${escapeHtml(x.label)}${x.sensitive ? " ⬛" : ""}`).join(", ")}</div>`
    : "";
  const tokens = (r.tokens || []).length
    ? `<div class="muted">tokens sent instead of values: ${r.tokens.map((t) => `<code>${escapeHtml(t.token)}</code>`).join(" ")}</div>`
    : "";
  const t = r.timings ? `<div class="muted">on-device: ${r.timings.perceptionTotalMs ?? r.totalMs} ms (DOM+text ${r.timings.domAndTextMs} · vision ${r.timings.analyzeMs ?? "-"} · paint ${r.timings.redactMs ?? "-"})${r.cacheHit ? " · cached" : ""}</div>` : "";
  els.xray.innerHTML =
    (r.redactedImage ? `<img class="xray-img" src="${r.redactedImage}" alt="redacted frame" title="Exactly the image a vision model would receive" />` : "") +
    `${r.live ? '<div class="muted">last frame sent to the server</div>' : ""}${counts}${screen}${regions}${tokens}${t}`;
}
els.previewBtn.addEventListener("click", async () => {
  els.previewBtn.disabled = true;
  els.previewInfo.textContent = "Running on-device perception…";
  try {
    // ?tab=<id> lets tests/screenshots target a specific tab; normally the active one
    const tabId = Number(new URLSearchParams(location.search).get("tab")) || undefined;
    const r = await chrome.runtime.sendMessage({ type: MSG.PRIVACY_PREVIEW, payload: { tabId } });
    if (!r?.ok) throw new Error(r?.error || "preview failed");
    previewShown = true;
    renderXray(r);
    els.previewInfo.textContent = `${r.boxes.length} region(s) blacked out · ${(r.redactedBytes / 1024).toFixed(0)} KB image · engine ${r.engine?.ep ?? "?"}`;
  } catch (e) {
    els.previewInfo.textContent = String(e.message || e);
  } finally {
    els.previewBtn.disabled = false;
  }
});

// ---- Settings (persisted by the background) ----
async function loadSettingsUi() {
  const s = (await chrome.storage.local.get("agentSettings")).agentSettings || {};
  if (s.perceptionMode) els.perceptionMode.value = s.perceptionMode;
  if (s.sendScreenshot !== undefined) els.sendScreenshot.checked = !!s.sendScreenshot;
  if (s.humanize !== undefined) els.humanize.checked = !!s.humanize;
}
function saveSettingsUi() {
  chrome.runtime.sendMessage({
    type: MSG.SAVE_SETTINGS,
    payload: { perceptionMode: els.perceptionMode.value, sendScreenshot: els.sendScreenshot.checked, humanize: els.humanize.checked },
  });
}
for (const el of [els.perceptionMode, els.sendScreenshot, els.humanize]) el.addEventListener("change", saveSettingsUi);
loadSettingsUi();
// load the models while the user types (hides first-step model load latency)
chrome.runtime.sendMessage({ type: MSG.WARMUP }).catch(() => {});

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

els.run.addEventListener("click", () => {
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    els.prompt.focus();
    return;
  }
  chrome.runtime.sendMessage({
    type: MSG.RUN_TASK,
    payload: {
      prompt,
      serverUrl: els.serverUrl.value.trim(),
      localOnly: els.localOnly.checked,
      multiAgentEnabled: els.multiAgent.checked,
      maxIterations: parseInt(els.maxIterations.value, 10) || undefined,
    },
  });
});

els.cancel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.CANCEL_TASK });
});

els.openDashboard.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.STATE_UPDATE) render(msg.state);
});

// Initial sync.
chrome.runtime.sendMessage({ type: MSG.GET_STATE }).then((res) => {
  if (res?.state) {
    render(res.state);
    if (res.state.prompt) els.prompt.value = res.state.prompt;
    if (res.state.serverUrl) els.serverUrl.value = res.state.serverUrl;
    if (res.state.maxIterations) els.maxIterations.value = res.state.maxIterations;
    els.localOnly.checked = !!res.state.localOnly;
    // STATE doesn't persist a multiAgentEnabled field today — default to checked
    // unless a matching field happens to exist, so this stays a no-op until it does.
    els.multiAgent.checked = !!res.state.multiAgentEnabled;
    updateChipsVisibility();
  }
});
