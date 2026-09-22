// Popup UI — a thin view over the background worker's state. All logic lives in
// background.js; the popup only sends RUN_TASK / CANCEL_TASK and renders STATE_UPDATE.

import { MSG, STATUS } from "./lib/messages.js";

const $ = (id) => document.getElementById(id);
const els = {
  prompt: $("prompt"),
  serverUrl: $("serverUrl"),
  localOnly: $("localOnly"),
  run: $("run"),
  cancel: $("cancel"),
  status: $("status"),
  answer: $("answer"),
  collected: $("collected"),
  redactCount: $("redactCount"),
  redactBody: $("redactBody"),
  metricsBody: $("metricsBody"),
  log: $("log"),
};

const BADGE_CLASS = {
  [STATUS.IDLE]: "",
  [STATUS.PERCEIVING]: "run",
  [STATUS.REDACTING]: "run",
  [STATUS.REASONING]: "run",
  [STATUS.ACTING]: "run",
  [STATUS.DONE]: "done",
  [STATUS.ERROR]: "err",
};

function render(state) {
  if (!state) return;
  const running = ![STATUS.IDLE, STATUS.DONE, STATUS.ERROR].includes(state.status);

  els.status.textContent = state.status + (state.iteration ? ` ${state.iteration}/${state.maxIterations}` : "");
  els.status.className = "badge " + (BADGE_CLASS[state.status] ?? "");
  els.run.disabled = running;
  els.cancel.disabled = !running;

  if (state.status === STATUS.ERROR) {
    els.answer.textContent = state.error || "error";
    els.answer.classList.remove("muted");
  } else if (state.answer) {
    els.answer.textContent = state.answer;
    els.answer.classList.remove("muted");
  } else {
    els.answer.textContent = "—";
    els.answer.classList.add("muted");
  }

  els.collected.textContent = state.accumulatedData?.length
    ? `${state.accumulatedData.length} item(s) collected` +
      (state.lastVisionMode ? ` · vision: ${state.lastVisionMode}` : "") +
      (state.lastScreenState ? ` · screen: ${state.lastScreenState}` : "") +
      (state.localOnly ? " · LOCAL-ONLY" : "")
    : state.lastVisionMode
      ? `vision: ${state.lastVisionMode}${state.localOnly ? " · LOCAL-ONLY" : ""}`
      : "";

  // Redaction panel
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

  // Metrics panel
  const iters = state.metrics?.iterations ?? [];
  if (iters.length) {
    const head = `<tr><th>#</th><th>perceive</th><th>redact</th><th>vision</th><th>server</th><th>total</th></tr>`;
    const body = iters
      .map(
        (m) =>
          `<tr><td>${m.iteration}</td><td>${m.perceiveMs ?? "-"}</td><td>${m.redactMs ?? "-"}</td><td>${m.visionTotalMs ?? "-"}</td><td>${m.serverMs ?? "-"}</td><td>${m.totalMs ?? "-"}</td></tr>`,
      )
      .join("");
    const avg = Math.round(iters.reduce((a, m) => a + (m.totalMs || 0), 0) / iters.length);
    els.metricsBody.innerHTML =
      `<table class="metrics">${head}${body}</table><p class="muted">avg loop: ${avg} ms (target &lt; 2500)</p>`;
  } else {
    els.metricsBody.innerHTML = `<p class="muted">No iterations yet.</p>`;
  }

  // Log
  els.log.innerHTML = (state.log || [])
    .slice(-80)
    .map((e) => `<li class="${e.level}">${new Date(e.t).toLocaleTimeString()}  ${escapeHtml(e.msg)}</li>`)
    .join("");
  els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
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
    },
  });
});

els.cancel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: MSG.CANCEL_TASK });
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
    els.localOnly.checked = !!res.state.localOnly;
  }
});
