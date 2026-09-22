# Comet mode

"Comet mode" is the name for a set of additions layered on top of the original
single-tab agent: a planner that can fan a task out into parallel sub-agents, each
running in its own browser window; a richer action vocabulary for the browsing loop
itself; and cross-session memory/history so the agent can recall facts and past runs.
None of it changes how simple tasks behave — that's the core design constraint, see
[Design reasoning](#design-reasoning) below.

## 1. The planner (`/agent/plan`)

Before any page is perceived, the background worker calls `POST /agent/plan` (unless
`localOnly` or multi-agent mode is off, in which case it skips straight to a
single-subtask plan). The planner is a **stateless, single LLM call** that sees only the
raw task prompt and the current tab's URL — never a DOM snapshot — and decides:

- Should this run as **one** browsing session, or be split into **2-5 independent
  sub-goals** that can run in parallel?
- For each sub-goal: a complete, standalone `goal` string (something you could hand
  directly to `/agent/step` with no other context) and an optional `startUrl`.

The default and overwhelming majority outcome is **1 subtask** — the original prompt,
verbatim. Splitting only happens when the task genuinely names multiple independent
things to look at ("compare X's pricing and Y's pricing", "research A, B and C").

Key files:

- `server/llm/plan_prompt.py` — system prompt + user message builder.
- `server/llm/plan_schema.json` — response schema (`{subtasks[], reasoning}`).
- `server/llm/client.py` — `decide_plan()` / `mock_plan()`, mirroring the step-decider's
  provider dispatch (`inception` / `anthropic` / `mock`).
- `server/routes/agent_plan.py` — the route. Never hard-fails: an LLM error or malformed
  output degrades to the same single-subtask shape `mock_plan` would produce.
- `extension/background.js` — `fetchPlan()` calls the route; `singleAgentPlan()` is the
  local fallback; `orchestrate()` decides `runSingleAgent` vs `runMultiAgent` based on
  `STATE.plan.subtasks.length`.

## 2. Multi-window sub-agent fan-out

When the plan has more than one subtask, `runMultiAgent()` in `background.js` takes
over:

1. **STATUS becomes `DELEGATING`.** One `sub` object is created per subtask (mirroring
   the shape of the original single-agent's state: `id`, `goal`, `startUrl`, `tabId`,
   `windowId`, `status`, `iteration`, `accumulatedData`, `answer`, `error`, `log`, etc).
2. The **first** subtask reuses the tab/window the user was already on — no extra window
   needed. Every other subtask gets its own **unfocused `chrome.windows.create`** window,
   because `chrome.tabs.captureVisibleTab` can only capture a window's *active* tab, so
   running several loops that each want screenshots requires separate windows, not just
   separate tabs.
3. All sub-agents' loops (`runSubLoop(sub, ctx)`) run **concurrently** via
   `Promise.allSettled` — a `ctx` object closes over the shared `serverUrl`/`localOnly`/
   `memoryFacts` and provides `isCancelled()` / `onUpdate()` hooks. One sub-agent erroring
   never stops the others.
4. Once every sub-agent settles, the extra windows are closed and focus is restored to
   the original tab, regardless of whether the run finished, errored, or was cancelled.
5. **STATUS becomes `SYNTHESIZING`.** Each sub-agent's `{goal, answer, extractedItems,
   error}` is sent to `synthesize()`, which POSTs to `POST /agent/synthesize` and falls
   back to a local `## {goal}\n{answer}` concatenation (`localSynthesize`) if the server
   call fails or `localOnly` is set. The result becomes `STATE.answer`.
6. **STATUS becomes `DONE`**, and the whole run (prompt, plan, per-sub-agent results,
   final answer) is written to history via `addHistoryEntry`.

`runSubLoop(sub, ctx)` is the same PERCEIVE → REDACT → REASON → ACT loop the original
single-tab agent always ran — it's just been parameterized over a `sub` object instead
of the module-level `STATE`, so single-agent and multi-agent runs share one
implementation. `mirrorSubToState(sub)` copies a sub-agent's live fields onto the
top-level `STATE` in the single-subtask path, so the popup's existing rendering code
(reads `STATE.iteration`/`accumulatedData`/`answer`/etc directly) needed zero changes for
that path.

### `/agent/synthesize`

Mirrors `/agent/plan`'s structure exactly:

- `server/llm/synthesize_prompt.py` / `synthesize_schema.json` — prompt + schema
  (`{answer}`).
- `server/llm/client.py` — `decide_synthesize()` / `mock_synthesize()`. The mock's
  `## {goal}\n{answer}` concatenation matches the extension's own `localSynthesize`
  fallback, so mock mode behaves the same whichever side produces it.
- `server/routes/agent_synthesize.py` — never hard-fails; degrades to the concatenation
  shape on any LLM error.

### The "Multi-agent mode" toggle

The popup's **Multi-agent mode** checkbox (default checked, matching
`DEFAULTS.multiAgentEnabled = true` in `extension/lib/messages.js`) is sent as
`multiAgentEnabled` in the `RUN_TASK` payload. Unchecking it forces `singleAgentPlan()`
regardless of what the planner would have decided — useful for demoing the original
single-tab behavior, or when parallel windows aren't wanted (e.g. a demo machine with
limited screen space).

## 3. Memory & history

- `extension/lib/memoryStore.js` wraps `chrome.storage.local` for two things that outlive
  a single task, unlike everything else in `STATE` (which lives in
  `chrome.storage.session` and resets every task):
  - **History** (`HISTORY_KEY`, capped at `HISTORY_LIMIT`): one entry per finished task —
    prompt, timing, status, answer, item count, host, the full plan, and every
    sub-agent's result. Written once, at the end of `orchestrate()`.
  - **Memory facts** (`MEMORY_KEY`, capped at `MEMORY_LIMIT`): durable `{key, value,
    source, createdAt}` facts the agent can recall across tasks. Read into
    `STATE.memoryFacts` at the start of every task and passed to the server on every
    `/agent/step` call as an extra `memoryFacts` field (additive — harmless if a prompt
    template doesn't read it yet).
- The `remember` action (see below) is how facts get written; `dashboard.html`'s Memory
  tab is how they get reviewed/forgotten.
- `extension/dashboard.html` gained **History** and **Memory** tabs alongside the
  existing Live metrics tab, each polling `chrome.storage.local` directly (no messaging
  needed, since the popup doesn't need to be open). The popup's new **History & Memory**
  button opens it in a new tab.

## 4. Expanded action vocabulary

`server/llm/action_schema.json` / `client.py` / `prompt_templates.py` and
`extension/content.js` gained six action types beyond the original `click / scroll /
type / wait / extract` set:

| type | fields | what it does |
|---|---|---|
| `select` | `targetId`, `value` | pick an `<option>` by value in a `<select>` |
| `check` | `targetId`, `checked` | set a checkbox/radio's checked state |
| `hover` | `targetId` | dispatch pointer/mouse-enter events (reveal hover menus) |
| `press_key` | `targetId?`, `key` | dispatch a keyboard event (Enter, Escape, arrows, …) |
| `fill_form` | `fields: [{targetId, value}]` | fill several fields in one action, human-like per-field |
| `remember` | `targetId` (key), `text` (value) | **not a page action** — intercepted in `runSubLoop` before dispatch and written straight to `memoryStore`, so it never touches the tab |

`click`/`type` (and now `select`/`check`/`hover`) in `content.js` use small randomized
delays and pointer-event sequences ("human-like") rather than firing a single synthetic
event, which is friendlier to sites that gate on realistic interaction sequences.

## Design reasoning

**Simple tasks are completely unaffected.** A single-question or single-site task still
gets exactly 1 subtask from the planner (or skips planning locally), so `orchestrate()`
takes the `runSingleAgent` branch: one tab, one `runSubLoop`, `STATUS` never enters
`DELEGATING`/`SYNTHESIZING`, no extra windows, and the popup's plan/sub-agents panels
stay hidden (they only render once `subtasks.length > 1` / `subAgents.length > 1`). The
only genuinely new cost for a simple task is one extra network round-trip (`/agent/plan`)
before the loop starts, with a local fallback if it fails.

**Only genuinely multi-part tasks fan out**, because:

1. Parallel browser windows are a real resource cost (memory, CPU, screen real estate,
   and — since each needs its own window to be capturable — user-visible window churn).
   Paying that cost for tasks that don't need it would make the common case worse for no
   benefit.
2. The planner is deliberately biased toward 1 subtask (the system prompt says so
   explicitly) rather than trying to be clever about decomposing single-site,
   multi-step tasks — a task with several *sequential* steps on one site is not the same
   as a task with several *independent* things to look at, and splitting the former would
   just fragment one coherent browsing session into uncoordinated pieces.
3. Every new piece (planning, synthesis, memory) degrades gracefully to something that
   already worked before this feature existed — `singleAgentPlan()`, `localSynthesize()`,
   an empty `memoryFacts` array — so a server outage, a `localOnly` run, or an LLM that
   returns garbage never breaks the task, only makes it behave like the pre-Comet-mode
   agent.

## Image capture + report compilation

Two more actions round out "research and report on this" tasks (e.g. "look at each of my
last 10 LinkedIn posts and note why some went viral, save the standout images, and give me
a report"):

- **`save_image`** — `{targetId, text?}`. The content script resolves the image element's
  real URL (handling `currentSrc`, common lazy-load attributes, and relative→absolute
  resolution) and returns it; `background.js` then calls `chrome.downloads.download()` —
  only the background/extension context has that API, which is why this is a two-step
  hop (content script perceives, background downloads) rather than a single content-script
  action like `click`/`type`. Files land under `Downloads/browser-agent-reports/<task>/images/`.
- **`compile_report`** — `{text}` (a title/closing summary). Purely client-side, like
  `remember`/`note`: bundles the sub-agent's `accumulatedData` into a CSV (Excel-openable)
  and its `notes` + saved-image captions into a Markdown report, downloads both to
  `Downloads/browser-agent-reports/<task>/`. Never round-trips through the server — the
  report is built entirely from data the extension already has locally.

Both are surfaced live in the popup's **Notes** tab (filenames + captions), and the system
prompt tells the model to work through a list of similar items one at a time — open, read,
`note` the finding, `save_image` anything worth keeping, back, next — rather than trying to
do a whole batch task in one leap, calling `compile_report` only once there's real
substance to bundle.

## Brave (and other Chromium browsers)

This is a standard Manifest V3 extension using only `chrome.*` APIs that Brave implements
identically (tabs, scripting, storage, alarms, notifications, downloads, windows) — loading
it unpacked via `brave://extensions` (Developer mode → Load unpacked → `dist/`) works the
same as Chrome. `background.js` logs a `browser=Brave` note (via `navigator.brave.isBrave()`,
an API Brave exposes specifically for this) purely for diagnostics; nothing branches on it.

The one known point of friction: Brave's Shields fingerprinting protection can perturb
canvas readback (`toDataURL`/`getImageData`) on some sites to defeat fingerprinting. That
could affect the *vision pipeline* and popup thumbnail generation, both of which already
have a safe fallback (`visionPipeline.js` falls back to a deterministic mock mode; a failed
thumbnail just renders as `null` and the popup skips it) — core browsing, redaction, and
the new save/report actions don't depend on canvas at all, so they're unaffected either way.
