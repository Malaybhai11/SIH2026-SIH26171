# API Contract — `POST /agent/step`

`contractVersion: 1`. Frozen for the MVP. Both the extension and the server validate
against this shape; `server/llm/action_schema.json` is the machine copy of the response
schema.

The server is **stateless per request** — all task state is passed in by the client every
turn.

---

## Request

```jsonc
{
  "contractVersion": 1,
  "taskId": "uuid",                 // stable for the whole task
  "prompt": "find top 10 elon musk posts and summarize them",
  "iteration": 2,                   // 1-based; client increments each loop
  "maxIterations": 6,
  "screenState": "feed",            // from vision Model B; one of: login|feed|checkout|form|content|unknown
  "screenStateConfidence": 0.91,    // 0..1
  "siteConfigId": "x.com",          // which selector pack the extractor used ("generic" if none)
  "sendScreenshot": false,          // client decides per §4.1 of the plan
  "redactedScreenshot": null,       // base64 PNG (no data: prefix) when sendScreenshot=true, else null
  "sanitizedDom": [ /* Node[] — see below, PII already replaced with typed tokens */ ],
  "accumulatedData": [ /* Item[] collected in previous iterations */ ]
}
```

### Node (element of `sanitizedDom`)

```jsonc
{
  "id": "n_0042",                   // synthetic; also written to the page as data-agent-id
  "role": "article",               // ARIA role or inferred from tag
  "text": "Just wrapped up static fire testing on...",  // <= 300 chars, PII-redacted
  "rect": { "x": 12, "y": 340, "w": 600, "h": 180 },
  "interactive": false,
  "author": "@someone",            // optional, site-config dependent
  "timestamp": "2026-09-07T10:15:00Z", // optional, ISO8601
  "href": "https://x.com/user/status/123" // optional
}
```

### Item (element of `accumulatedData` / `extractedItems`)

Free-form per task, but for the reference task:

```jsonc
{ "author": "@elonmusk", "text": "...", "timestamp": "...", "href": "...", "metrics": { "likes": 1234 } }
```

---

## Response

Exactly one of three `status` values.

### `action` — do something, then call again

```jsonc
{
  "status": "action",
  "action": {
    "type": "scroll",              // click | scroll | type | wait | extract
    "targetId": null,              // required for click/type; a Node.id
    "amount": 900,                 // px for scroll
    "text": null,                  // string for type
    "ms": null                     // for wait
  },
  "extracted": [ /* Item[] — items the server pulled from this snapshot, appended client-side to accumulatedData */ ],
  "reasoning": "Only 4 unique posts collected so far, need 10."
}
```

### `done` — task finished

```jsonc
{
  "status": "done",
  "answer": "Summary of the top 10 posts: ...",
  "extractedItems": [ /* Item[] — the final cleaned set */ ],
  "reasoning": "Collected 10 unique posts; summarising."
}
```

### `error` — server could not produce a step

```jsonc
{ "status": "error", "code": "llm_malformed", "message": "model output failed schema validation twice" }
```

Error `code` values: `llm_unavailable`, `llm_malformed`, `bad_request`, `internal`.

---

## Action vocabulary

| type | fields used | where | client behaviour |
|---|---|---|---|
| `click` | `targetId` | content | click the element (or its inner link/button) with that `data-agent-id` |
| `scroll` | `amount` | content | `window.scrollBy(0, amount)`, settle, re-extract with dedupe |
| `type` | `targetId`, `text` | content | focus element, set value, dispatch `input`/`change` |
| `wait` | `ms` | content | sleep, then re-extract |
| `extract` | — | content | re-run extraction on current viewport |
| `navigate` | `url` | background | `chrome.tabs.update` current tab to `url`, wait for load, re-inject |
| `open_tab` | `url` | background | `chrome.tabs.create` a new active tab; subsequent steps target it |
| `switch_tab` | `index` | background | activate the 0-based tab in the current window |
| `back` | — | background | `chrome.tabs.goBack`, wait for load |

`done` is not an action type — completion is signalled by `status: "done"`.

Navigation actions are executed by the background worker (they need `chrome.tabs`);
the rest are dispatched to the content script. After every navigation the background
worker re-injects the content script and re-perceives.

### Request additions (v1, additive)

- `currentUrl`: string — the active tab's URL this turn.
- `openTabs`: `[{ index, active, title, url }]` — tabs in the current window.

---

## Server-side guarantees

1. Re-runs the regex PII layer over `sanitizedDom`. Any leak is re-redacted before the
   payload reaches the LLM and counted in the `leakCatch` QA metric. The request is **not**
   rejected (demo resilience).
2. Validates its own LLM output against `action_schema.json`; one retry-with-correction on
   failure, then `status:"error", code:"llm_malformed"`.
3. Never persists `sanitizedDom`, `redactedScreenshot`, or `accumulatedData`.

---

# API Contract — `POST /agent/plan`

Runs ONCE per task, before any page is perceived, to decide whether the task should run
as a single browsing session or be split into up to 5 independent sub-goals that run in
parallel browser windows (each later driven turn-by-turn via `/agent/step`, one instance
per subtask). Stateless, like `/agent/step`; `server/llm/plan_schema.json` is the machine
copy of the response schema.

## Request

```jsonc
{
  "prompt": "compare stripe's pricing page and paddle's pricing page",
  "currentUrl": "https://example.com/"   // the active tab's URL when the task started; null if unknown
}
```

## Response

```jsonc
{
  "subtasks": [
    { "id": "sub_1", "goal": "Summarize Stripe's pricing page.", "startUrl": "https://stripe.com/pricing" },
    { "id": "sub_2", "goal": "Summarize Paddle's pricing page.", "startUrl": "https://paddle.com/pricing" }
  ],
  "reasoning": "Two independent pricing pages to compare, so split into 2 parallel subtasks.",
  "_debug": { "engine": "mock", "serverMs": 1 }
}
```

- `subtasks`: 1-5 entries. The overwhelming majority of tasks come back as exactly 1
  subtask whose `goal` is the original `prompt` verbatim — only genuinely parallelizable
  multi-part tasks (e.g. "compare X and Y", "research A, B and C") get split. Each `goal`
  is a complete, standalone instruction suitable to hand directly to `/agent/step` as its
  `prompt`.
- `startUrl`: a specific URL if the task/subtask named one; otherwise `null`, meaning the
  browsing agent should start from `currentUrl`.
- Never hard-fails: if the LLM planner errors or returns something unusable, the server
  degrades to the same single-subtask shape a mock planner would produce rather than
  failing the whole task.

---

# API Contract — `POST /agent/synthesize`

Runs ONCE per task, after every sub-agent from `/agent/plan`'s split has finished (or the
extension's own `localSynthesize` fallback is used instead). Combines each sub-agent's
result into one coherent final answer to the user's original prompt. Stateless, like
`/agent/step` and `/agent/plan`; `server/llm/synthesize_schema.json` is the machine copy of
the response schema.

## Request

```jsonc
{
  "originalPrompt": "compare the weather in Paris and Tokyo",
  "subAgentResults": [
    { "goal": "weather in Paris", "answer": "Sunny, 20C", "extractedItems": [], "error": null },
    { "goal": "weather in Tokyo", "answer": "Rainy, 15C", "extractedItems": [], "error": null }
  ]
}
```

- `subAgentResults[].answer`: the sub-agent's final answer, or `null`/omitted if it failed.
- `subAgentResults[].error`: the failure reason if the sub-agent ended in `ERROR`, else `null`.
- `subAgentResults[].extractedItems`: the sub-agent's accumulated items (context only — the
  synthesizer isn't required to echo them back).

## Response

```jsonc
{
  "answer": "Paris is sunny at 20C while Tokyo is rainy at 15C, so ...",
  "_debug": { "engine": "mock", "serverMs": 1 }
}
```

- Never hard-fails: if the LLM synthesizer errors or returns something unusable, the server
  degrades to the same `## {goal}\n{answer}` concatenation the extension's own
  `localSynthesize` fallback produces (see `extension/background.js`), so the caller always
  gets a usable `answer` string.
