// Dashboard logic — MUST live in its own file, not an inline <script> in
// dashboard.html: MV3 extension pages enforce a `script-src 'self'` CSP with no
// 'unsafe-inline' exception (unlike a regular web page, this can't be relaxed via
// a manifest CSP override), so an inline <script> block is silently blocked at
// runtime — Chrome just never runs it.

const STATE_KEY = "agentTaskState";
const HISTORY_KEY = "agentTaskHistory";
const MEMORY_KEY = "agentMemoryFacts";
const NOTES_KEY = "agentNotes";
const TEMPLATES_KEY = "agentTemplates";
const HISTORY_LIMIT = 200;
const MEMORY_LIMIT = 100;
const NOTES_LIMIT = 300;
const TEMPLATES_LIMIT = 50;

function card(k, v) {
  return `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function render(s) {
  if (!s) return;
  document.getElementById("ctx").textContent =
    `task: "${s.prompt || "—"}"  ·  status: ${s.status}  ·  vision: ${s.lastVisionMode || "—"}` +
    (s.localOnly ? "  ·  LOCAL-ONLY" : "");

  const iters = s.metrics?.iterations ?? [];
  const avg = iters.length
    ? Math.round(iters.reduce((a, m) => a + (m.totalMs || 0), 0) / iters.length)
    : "—";
  const redTotal = s.lastRedactionSummary?.total ?? 0;

  document.getElementById("cards").innerHTML = [
    card("Iterations", `${s.iteration || 0}/${s.maxIterations || 6}`),
    card("Avg loop (ms)", avg + (typeof avg === "number" && avg < 2500 ? " ✓" : "")),
    card("Items collected", s.accumulatedData?.length ?? 0),
    card("Redacted spans", redTotal),
    card("Vision mode", s.lastVisionMode || "—"),
    card("Screen state", s.lastScreenState || "—"),
  ].join("");

  document.querySelector("#itertable tbody").innerHTML = iters
    .map(
      (m) =>
        `<tr><td>${m.iteration}</td><td>${m.perceiveMs ?? "-"}</td><td>${m.redactMs ?? "-"}</td><td>${m.faceMs ?? "-"}</td><td>${m.screenMs ?? "-"}</td><td>${m.visionTotalMs ?? "-"}</td><td>${m.serverMs ?? "-"}</td><td>${m.totalMs ?? "-"}</td></tr>`,
    )
    .join("");
}

async function tick() {
  try {
    const r = await chrome.storage.session.get(STATE_KEY);
    render(r?.[STATE_KEY]);
  } catch (e) {
    /* ignore */
  }
}
chrome.storage.session.onChanged?.addListener(tick);
setInterval(tick, 1000);
tick();

// ---- Tabs ----

const panels = {
  live: document.getElementById("panelLive"),
  history: document.getElementById("panelHistory"),
  memory: document.getElementById("panelMemory"),
  notes: document.getElementById("panelNotes"),
  templates: document.getElementById("panelTemplates"),
};
const tabButtons = {
  live: document.getElementById("tabLive"),
  history: document.getElementById("tabHistory"),
  memory: document.getElementById("tabMemory"),
  notes: document.getElementById("tabNotes"),
  templates: document.getElementById("tabTemplates"),
};

function showTab(name) {
  for (const k of Object.keys(panels)) {
    panels[k].hidden = k !== name;
    tabButtons[k].classList.toggle("active", k === name);
  }
}
tabButtons.live.addEventListener("click", () => showTab("live"));
tabButtons.history.addEventListener("click", () => showTab("history"));
tabButtons.memory.addEventListener("click", () => showTab("memory"));
tabButtons.notes.addEventListener("click", () => showTab("notes"));
tabButtons.templates.addEventListener("click", () => showTab("templates"));

// ---- History ----

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function renderHistory(list) {
  const el = document.getElementById("historyList");
  if (!list.length) {
    el.innerHTML = `<p class="muted">No tasks run yet.</p>`;
    return;
  }
  el.innerHTML = list
    .map((e) => {
      const subs = Array.isArray(e.subAgents) && e.subAgents.length
        ? `<ul class="subagents">${e.subAgents
            .map((sa) => `<li><strong>${escapeHtml(sa.goal)}:</strong> ${escapeHtml(truncate(sa.answer, 160))}</li>`)
            .join("")}</ul>`
        : "";
      const when = e.finishedAt || e.startedAt ? new Date(e.finishedAt || e.startedAt).toLocaleString() : "—";
      return `<div class="entry">
        <div class="row">
          <span class="prompt">${escapeHtml(truncate(e.prompt, 140))}</span>
          <span class="status-pill ${escapeHtml(e.status)}">${escapeHtml(e.status)}</span>
        </div>
        <div class="meta">${when} · ${e.itemCount ?? 0} item(s) · ${escapeHtml(e.host || "")}</div>
        <div class="answer">${escapeHtml(truncate(e.answer, 300)) || '<span class="muted">no answer</span>'}</div>
        ${subs}
      </div>`;
    })
    .join("");
}

let cachedHistory = [];
function applyHistorySearch() {
  const q = document.getElementById("historySearch").value.trim().toLowerCase();
  const filtered = q ? cachedHistory.filter((e) => (e.prompt || "").toLowerCase().includes(q)) : cachedHistory;
  renderHistory(filtered);
}
document.getElementById("historySearch").addEventListener("input", applyHistorySearch);

async function tickHistory() {
  try {
    const r = await chrome.storage.local.get(HISTORY_KEY);
    cachedHistory = r?.[HISTORY_KEY] ?? [];
    applyHistorySearch();
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("clearHistory").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  } catch (e) {
    /* ignore */
  }
  tickHistory();
});

// ---- Memory ----

function renderMemory(list) {
  const el = document.getElementById("memoryList");
  if (!list.length) {
    el.innerHTML = `<p class="muted">No memory facts stored.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (f) => `<div class="fact-row" data-key="${escapeHtml(f.key)}">
        <span class="fk">${escapeHtml(f.key)}</span>
        <span class="fv">${escapeHtml(f.value)}</span>
        <span class="fsrc">${escapeHtml(f.source)} · ${f.createdAt ? new Date(f.createdAt).toLocaleDateString() : "—"}</span>
        <button class="forget">Forget</button>
      </div>`,
    )
    .join("");
  el.querySelectorAll(".forget").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const key = ev.target.closest(".fact-row").dataset.key;
      await forgetFact(key);
      tickMemory();
    });
  });
}

async function forgetFact(key) {
  try {
    const r = await chrome.storage.local.get(MEMORY_KEY);
    const list = Array.isArray(r?.[MEMORY_KEY]) ? r[MEMORY_KEY] : [];
    const norm = key.toLowerCase();
    await chrome.storage.local.set({
      [MEMORY_KEY]: list.filter((f) => f.key.toLowerCase() !== norm),
    });
  } catch (e) {
    /* ignore */
  }
}

async function tickMemory() {
  try {
    const r = await chrome.storage.local.get(MEMORY_KEY);
    renderMemory(r?.[MEMORY_KEY] ?? []);
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("clearMemory").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ [MEMORY_KEY]: [] });
  } catch (e) {
    /* ignore */
  }
  tickMemory();
});

// Upserts by key, case-insensitive — same semantics as forgetFact's key match.
async function addFact(key, value, source = "user") {
  key = String(key || "").trim();
  if (!key) return;
  try {
    const r = await chrome.storage.local.get(MEMORY_KEY);
    const facts = Array.isArray(r?.[MEMORY_KEY]) ? r[MEMORY_KEY] : [];
    const norm = key.toLowerCase();
    const existing = facts.find((f) => f.key.toLowerCase() === norm);
    const now = Date.now();
    if (existing) {
      existing.value = value;
      existing.source = source;
      existing.createdAt = now;
    } else {
      facts.push({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        key,
        value,
        source,
        createdAt: now,
      });
      if (facts.length > MEMORY_LIMIT) facts.splice(0, facts.length - MEMORY_LIMIT);
    }
    await chrome.storage.local.set({ [MEMORY_KEY]: facts });
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("addFact").addEventListener("click", async () => {
  const keyEl = document.getElementById("newFactKey");
  const valEl = document.getElementById("newFactValue");
  if (!keyEl.value.trim()) return;
  await addFact(keyEl.value, valEl.value, "user");
  keyEl.value = "";
  valEl.value = "";
  tickMemory();
});

chrome.storage.local.onChanged?.addListener((changes) => {
  if (changes[HISTORY_KEY]) tickHistory();
  if (changes[MEMORY_KEY]) tickMemory();
  if (changes[NOTES_KEY]) tickNotes();
  if (changes[TEMPLATES_KEY]) tickTemplates();
});
setInterval(() => {
  tickHistory();
  tickMemory();
  tickNotes();
  tickTemplates();
}, 2000);
tickHistory();
tickMemory();
tickNotes();
tickTemplates();

// ---- Notes ----

function renderNotes(list) {
  const el = document.getElementById("notesList");
  if (!list.length) {
    el.innerHTML = `<p class="muted">No notes yet.</p>`;
    return;
  }
  el.innerHTML = list
    .slice(0, NOTES_LIMIT)
    .map(
      (n) => `<div class="note-row">
        <div class="nhead">
          <span>${n.author ? escapeHtml(n.author) : ""}</span>
          <span>${n.createdAt ? new Date(n.createdAt).toLocaleString() : "—"}</span>
        </div>
        <div>${escapeHtml(n.text)}</div>
      </div>`,
    )
    .join("");
}

async function tickNotes() {
  try {
    const r = await chrome.storage.local.get(NOTES_KEY);
    renderNotes(r?.[NOTES_KEY] ?? []); // already newest-first, per addNote's unshift convention
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("clearNotesBtn").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ [NOTES_KEY]: [] });
  } catch (e) {
    /* ignore */
  }
  tickNotes();
});

// ---- Templates ----

function renderTemplates(list) {
  const el = document.getElementById("templatesList");
  if (!list.length) {
    el.innerHTML = `<p class="muted">No saved templates.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (t) => `<div class="template-row" data-id="${escapeHtml(t.id)}">
        <span class="tlabel">${escapeHtml(t.label || "(untitled)")}</span>
        <span class="tprompt">${escapeHtml(truncate(t.prompt, 160))}</span>
        <button class="deleteTemplate">Delete</button>
      </div>`,
    )
    .join("");
  el.querySelectorAll(".deleteTemplate").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const id = ev.target.closest(".template-row").dataset.id;
      try {
        const r = await chrome.storage.local.get(TEMPLATES_KEY);
        const list = Array.isArray(r?.[TEMPLATES_KEY]) ? r[TEMPLATES_KEY] : [];
        await chrome.storage.local.set({ [TEMPLATES_KEY]: list.filter((t) => t.id !== id) });
      } catch (e) {
        /* ignore */
      }
      tickTemplates();
    });
  });
}

async function tickTemplates() {
  try {
    const r = await chrome.storage.local.get(TEMPLATES_KEY);
    renderTemplates(r?.[TEMPLATES_KEY] ?? []);
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("addTemplate").addEventListener("click", async () => {
  const labelEl = document.getElementById("newTemplateLabel");
  const promptEl = document.getElementById("newTemplatePrompt");
  const label = labelEl.value.trim();
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  try {
    const r = await chrome.storage.local.get(TEMPLATES_KEY);
    const list = Array.isArray(r?.[TEMPLATES_KEY]) ? r[TEMPLATES_KEY] : [];
    const idx = list.findIndex((t) => t.prompt === prompt);
    const now = Date.now();
    let entry;
    if (idx !== -1) {
      entry = { ...list[idx], label, createdAt: now };
      list.splice(idx, 1);
    } else {
      entry = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, label, prompt, createdAt: now };
    }
    list.unshift(entry);
    if (list.length > TEMPLATES_LIMIT) list.length = TEMPLATES_LIMIT;
    await chrome.storage.local.set({ [TEMPLATES_KEY]: list });
  } catch (e) {
    /* ignore */
  }
  labelEl.value = "";
  promptEl.value = "";
  tickTemplates();
});

// ---- Export / Import ----
// Mirrors memoryStore.js's exportAll()/importAll() shapes exactly, but reads/writes
// storage directly (matching this file's existing inline style) rather than
// importing the module.

function mergeByKey(existing, incoming, limitCount, keyFn) {
  const seen = new Set(existing.map(keyFn));
  let added = 0;
  for (const item of incoming) {
    if (!item || typeof item !== "object") continue;
    const k = keyFn(item);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    existing.push(item);
    added++;
  }
  if (limitCount && existing.length > limitCount) existing.length = limitCount;
  return added;
}

document.getElementById("exportAll").addEventListener("click", async () => {
  try {
    const r = await chrome.storage.local.get([HISTORY_KEY, MEMORY_KEY, NOTES_KEY, TEMPLATES_KEY]);
    const bundle = {
      history: r?.[HISTORY_KEY] ?? [],
      memoryFacts: r?.[MEMORY_KEY] ?? [],
      notes: r?.[NOTES_KEY] ?? [],
      templates: r?.[TEMPLATES_KEY] ?? [],
      exportedAt: Date.now(),
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "browser-agent-backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    /* ignore */
  }
});

document.getElementById("importAllBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = ""; // allow re-selecting the same file next time
  if (!file) return;
  const summaryEl = document.getElementById("importSummary");
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    const summary = { historyAdded: 0, notesAdded: 0, templatesAdded: 0, factsUpserted: 0 };

    if (Array.isArray(bundle.history)) {
      const r = await chrome.storage.local.get(HISTORY_KEY);
      const list = Array.isArray(r?.[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
      summary.historyAdded = mergeByKey(list, bundle.history, HISTORY_LIMIT, (e) => e?.id ?? JSON.stringify(e));
      await chrome.storage.local.set({ [HISTORY_KEY]: list });
    }
    if (Array.isArray(bundle.notes)) {
      const r = await chrome.storage.local.get(NOTES_KEY);
      const list = Array.isArray(r?.[NOTES_KEY]) ? r[NOTES_KEY] : [];
      summary.notesAdded = mergeByKey(list, bundle.notes, NOTES_LIMIT, (n) => n?.id ?? JSON.stringify(n));
      await chrome.storage.local.set({ [NOTES_KEY]: list });
    }
    if (Array.isArray(bundle.templates)) {
      const r = await chrome.storage.local.get(TEMPLATES_KEY);
      const list = Array.isArray(r?.[TEMPLATES_KEY]) ? r[TEMPLATES_KEY] : [];
      summary.templatesAdded = mergeByKey(list, bundle.templates, TEMPLATES_LIMIT, (t) => t?.id ?? t?.prompt);
      await chrome.storage.local.set({ [TEMPLATES_KEY]: list });
    }
    if (Array.isArray(bundle.memoryFacts)) {
      for (const f of bundle.memoryFacts) {
        if (!f || typeof f !== "object" || !f.key) continue;
        await addFact(f.key, f.value, f.source ?? "import");
        summary.factsUpserted++;
      }
    }

    summaryEl.textContent =
      `Imported: ${summary.historyAdded} history, ${summary.notesAdded} notes, ` +
      `${summary.templatesAdded} templates, ${summary.factsUpserted} facts.`;
    tickHistory();
    tickMemory();
    tickNotes();
    tickTemplates();
  } catch (e) {
    summaryEl.textContent = `Import failed: ${e.message}`;
  }
});
