// Cross-session storage for task history and long-term memory facts.
// Wraps chrome.storage.local; every call is defensive because storage can be
// briefly unavailable (extension reload, quota errors, etc).

import {
  HISTORY_KEY,
  MEMORY_KEY,
  NOTES_KEY,
  TEMPLATES_KEY,
  HISTORY_LIMIT,
  MEMORY_LIMIT,
  NOTES_LIMIT,
  TEMPLATES_LIMIT,
} from "./messages.js";

const storage = globalThis.chrome?.storage?.local ?? globalThis.browser?.storage?.local;

async function readList(key) {
  try {
    const r = await storage.get(key);
    const v = r?.[key];
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

async function writeList(key, list) {
  try {
    await storage.set({ [key]: list });
  } catch (e) {
    /* ignore — best-effort persistence */
  }
}

export async function addHistoryEntry(entry) {
  const list = await readList(HISTORY_KEY);
  list.unshift(entry);
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  await writeList(HISTORY_KEY, list);
}

export async function getHistory(limit = 50) {
  const list = await readList(HISTORY_KEY);
  return list.slice(0, limit);
}

export async function clearHistory() {
  await writeList(HISTORY_KEY, []);
}

export async function getMemoryFacts() {
  return readList(MEMORY_KEY);
}

export async function rememberFact(key, value, source = "agent") {
  const facts = await readList(MEMORY_KEY);
  const norm = String(key).toLowerCase();
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
  await writeList(MEMORY_KEY, facts);
}

export async function forgetFact(key) {
  const facts = await readList(MEMORY_KEY);
  const norm = String(key).toLowerCase();
  await writeList(MEMORY_KEY, facts.filter((f) => f.key.toLowerCase() !== norm));
}

export async function clearMemory() {
  await writeList(MEMORY_KEY, []);
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Notes: an ephemeral, per-task scratchpad (not cross-task memory). Stored newest-first,
// same convention as history.
export async function addNote(taskId, text, author = "agent") {
  const list = await readList(NOTES_KEY);
  list.unshift({ id: newId(), taskId, text, author, createdAt: Date.now() });
  if (list.length > NOTES_LIMIT) list.length = NOTES_LIMIT;
  await writeList(NOTES_KEY, list);
}

export async function getNotes(taskId) {
  const list = await readList(NOTES_KEY);
  return list.filter((n) => n.taskId === taskId).reverse(); // oldest first, for reading a task's journal in order
}

export async function getAllNotes(limit = 100) {
  const list = await readList(NOTES_KEY);
  return list.slice(0, limit); // already newest-first
}

export async function deleteNote(id) {
  const list = await readList(NOTES_KEY);
  await writeList(NOTES_KEY, list.filter((n) => n.id !== id));
}

export async function clearNotes() {
  await writeList(NOTES_KEY, []);
}

// Templates: saved reusable prompts. Stored newest-first.
export async function saveTemplate(label, prompt) {
  const list = await readList(TEMPLATES_KEY);
  const idx = list.findIndex((t) => t.prompt === prompt);
  const now = Date.now();
  let entry;
  if (idx !== -1) {
    // Exact-prompt upsert: keep the existing id, refresh label/createdAt, bump to front.
    entry = { ...list[idx], label, createdAt: now };
    list.splice(idx, 1);
  } else {
    entry = { id: newId(), label, prompt, createdAt: now };
  }
  list.unshift(entry);
  if (list.length > TEMPLATES_LIMIT) list.length = TEMPLATES_LIMIT;
  await writeList(TEMPLATES_KEY, list);
}

export async function getTemplates() {
  return readList(TEMPLATES_KEY);
}

export async function deleteTemplate(id) {
  const list = await readList(TEMPLATES_KEY);
  await writeList(TEMPLATES_KEY, list.filter((t) => t.id !== id));
}

// Merges `incoming` items into `existing` (mutated in place), skipping anything whose
// key() already appears in `existing`, then truncates to `limitCount` keeping the front
// (newest) of the array — matches the unshift/newest-first convention used everywhere else.
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

// Export/import — one JSON bundle covering history, memory, notes and templates, for
// backup/portability. Import uses merge semantics (never overwrites existing data).
export async function exportAll() {
  const [history, memoryFacts, notes, templates] = await Promise.all([
    getHistory(HISTORY_LIMIT),
    getMemoryFacts(),
    getAllNotes(NOTES_LIMIT),
    getTemplates(),
  ]);
  return { history, memoryFacts, notes, templates, exportedAt: Date.now() };
}

export async function importAll(bundle) {
  const summary = { historyAdded: 0, notesAdded: 0, templatesAdded: 0, factsUpserted: 0 };
  if (!bundle || typeof bundle !== "object") return summary;

  try {
    if (Array.isArray(bundle.history)) {
      const list = await readList(HISTORY_KEY);
      summary.historyAdded = mergeByKey(list, bundle.history, HISTORY_LIMIT, (e) => e?.id ?? JSON.stringify(e));
      await writeList(HISTORY_KEY, list);
    }
  } catch (e) {
    /* skip malformed history */
  }

  try {
    if (Array.isArray(bundle.notes)) {
      const list = await readList(NOTES_KEY);
      summary.notesAdded = mergeByKey(list, bundle.notes, NOTES_LIMIT, (n) => n?.id ?? JSON.stringify(n));
      await writeList(NOTES_KEY, list);
    }
  } catch (e) {
    /* skip malformed notes */
  }

  try {
    if (Array.isArray(bundle.templates)) {
      const list = await readList(TEMPLATES_KEY);
      summary.templatesAdded = mergeByKey(list, bundle.templates, TEMPLATES_LIMIT, (t) => t?.id ?? t?.prompt);
      await writeList(TEMPLATES_KEY, list);
    }
  } catch (e) {
    /* skip malformed templates */
  }

  try {
    if (Array.isArray(bundle.memoryFacts)) {
      for (const f of bundle.memoryFacts) {
        if (!f || typeof f !== "object" || !f.key) continue;
        await rememberFact(f.key, f.value, f.source ?? "import"); // reuse the existing upsert-by-key logic
        summary.factsUpserted++;
      }
    }
  } catch (e) {
    /* skip malformed memoryFacts */
  }

  return summary;
}
