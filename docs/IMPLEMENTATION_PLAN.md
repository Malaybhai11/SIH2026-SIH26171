# Implementation Plan — On-Device Visual Perception for Lightweight Browser Agents

**Source:** `docs/PRD.md` (SIH PS 26171) · **Status:** Draft v1 · **Horizon:** 14 days

This turns the PRD's phased outline (§8) into an ordered engineering backlog: what to build,
in what order, what "done" means for each step, and which decisions must be locked first.

---

## 1. Guiding principles

1. **Demo value before completeness.** The agent loop (DOM + LLM) is the spine and the
   lowest-risk part — get the Elon Musk task working end-to-end with zero redaction/vision
   first, then layer privacy on top. A broken loop with perfect redaction scores nothing.
2. **Measurement is a feature.** 3 of 5 scoring criteria (60%: PII recall/precision,
   redaction precision, resource use) are *numbers you must produce*. The eval harness and
   metrics instrumentation are built early and kept green, not bolted on in Phase 5.
3. **Contracts before parallel work.** Lock the three interfaces (§4) on day 1 so the
   client, server, and ML-export tracks can move independently against stubs.
4. **Every model has a fake.** `visionPipeline`, `nerRedactor`, and the server LLM each get
   a deterministic mock behind the same interface, so integration never blocks on a model
   being ready and CI stays fast.
5. **Fallback paths are P0, not P2.** WASM vision fallback and offline/mocked server
   response are required for demo day (judges' machines vary) — schedule them in the same
   phase as the feature, not in hardening.

---

## 2. Critical path (what gates the demo)

```
repo + contracts ─► agent loop (DOM+LLM) ─► redaction (text) + eval harness ─► vision + visual redaction ─► metrics dashboard ─► scripted demo
                                        └► (parallel) ONNX model export ──────────┘
```

Anything not on this line (Firefox, second demo site, persistent history, VLM screenshot
path) is explicitly deferrable and lives in §9.

---

## 3. Team split (adjust to actual headcount)

| Track | Owns | Can start day 1 against |
|---|---|---|
| **A — Extension** | manifest, popup, background state machine, content script, DOM extractor, redaction wiring, vision integration | message + API contracts, mock server, mock models |
| **B — Server** | FastAPI/Express, `/agent/step`, orchestrator, LLM prompt + tool-schema, server-side leak check | API contract, canned sanitized payloads |
| **C — ML / Eval** | ONNX export + quantization (BlazeFace, TinyViT, DistilBERT-NER), calibration sets, labeled test sets, `eval/metrics.py`, resource profiling | model I/O contract, PRD §4.4 specs |

Solo/pair team: do the phases strictly in order; keep track C's model-export work as
background tasks between phases.

---

## 4. Decisions & contracts to lock on Day 1

### 4.1 Open questions from PRD §13 — proposed resolutions

| Question | Decision for MVP | Rationale |
|---|---|---|
| Send redacted screenshot always, or only on ambiguity? | **Default OFF.** Send only when Model B screen-state confidence < threshold (e.g. 0.6) or screen-state ∈ {unknown, checkout, login}. Flag is per-request boolean from client. | Minimizes bandwidth (<200KB target), attack surface, and server cost. Keeps VLM path optional. |
| Firefox parity? | **Best-effort, Phase 4 stretch only.** Write DOM/redaction/vision logic browser-agnostic; isolate `chrome.*` calls behind a thin `browserApi` shim. Do not spend demo-prep time here. | Chrome MV3 first per PRD non-goals; shim keeps the door open cheaply. |
| Persistent task history across popup close? | **Per-session only** (`chrome.storage.session`). Background service worker holds the loop; popup is a thin view that re-renders from session state on open. | Sufficient for demo; avoids `chrome.storage.local` migration/PII-retention questions. |

### 4.2 Message contract (popup ↔ background ↔ content script)

Define in `extension/lib/messages.js` as typed constants + JSDoc. Minimum set:

- `POPUP→BG`: `RUN_TASK {prompt}`, `CANCEL_TASK`, `GET_STATE`
- `BG→POPUP`: `STATE_UPDATE {status, iteration, log[], answer?, redactionSummary?}`
- `BG→CS`: `EXTRACT_SNAPSHOT {siteConfigId}`, `EXECUTE_ACTION {action}`, `COLLECT_WITH_SCROLL {targetCount}`
- `CS→BG`: `SNAPSHOT {sanitizedDom[], screenState, redactedScreenshot?, redactionLog[]}`, `ACTION_RESULT {ok, error?}`

Rule: **redaction happens in the content script before the snapshot message is posted.**
The background worker and popup never see raw PII. `redactionLog` carries counts/types/elementIds
only (no values) and is never forwarded to the server.

### 4.3 API contract (`POST /agent/step`)

Freeze the request/response JSON from PRD §5.1 verbatim into
`server/llm/action_schema.json` + a shared `docs/api-contract.md`. Add:

- Request: `sendScreenshot: boolean` (client's decision per 4.1), `siteConfigId: string`.
- Response `status ∈ {action, done, error}`; `action.type ∈ {click, scroll, type, wait, extract, done}`.
- Error envelope: `{status:"error", code, message}` so the client state machine has a defined path.
- Version field `contractVersion: 1`.

### 4.4 Model I/O contract (`docs/model-contract.md`)

For each of the three models, pin: file name, input tensor name/shape/dtype/normalization,
output tensor name/shape, and the label map. Client integrates against these with a mock
`InferenceSession` until real `.onnx` files land.

- **BlazeFace**: in `input:1×3×128×128` f32 `[-1,1]`; out boxes `N×4` + scores `N`. Label: face.
- **TinyViT screen**: in `input:1×3×224×224` f32 ImageNet-norm; out logits `1×6`.
  Labels: `[sensitive-form-field, password-input, payment-info, body-text, image-content, navigation]`.
  Plus derived screen-state label ∈ `{login, feed, checkout, form, content, unknown}`.
- **DistilBERT-NER**: in `input_ids`+`attention_mask` `1×256` i64; out `1×256×9` (BIO tags).
  Labels: `O, B-PER, I-PER, B-LOC, I-LOC, B-ORG, I-ORG, B-MISC, I-MISC`.

---

## 5. Phase-by-phase backlog

Effort tags: **S** ≤half day, **M** ~1 day, **L** ~2 days.

### Phase 0 — Skeleton & contracts (Days 1–2)

**Deliverable:** prompt typed in popup → background → mock server → answer string back in popup,
with all three contracts (§4) written down.

| # | Task | Track | Effort |
|---|---|---|---|
| 0.1 | Repo bootstrap: `/extension`, `/server`, `/eval`, `/docs` per PRD §11; `package.json` (esbuild bundling for extension), `pyproject.toml`/`requirements.txt` for server + eval; `.gitignore`; `README` with run steps. | A/B | S |
| 0.2 | Write `docs/api-contract.md`, `docs/model-contract.md`, `extension/lib/messages.js`. | all | S |
| 0.3 | `manifest.json` per PRD §4.1; `popup.html/js/css` (prompt box, Run/Cancel, status log `<ul>`, answer pane, empty "What was redacted" `<details>`). 420×600. | A | M |
| 0.4 | `background.js`: state machine `IDLE→PERCEIVING→REDACTING→REASONING→ACTING→DONE/ERROR`; loop cap (6) + per-iter timeout (8s); state in `chrome.storage.session`; message routing. Drive it with a **hardcoded** content-script response + hardcoded server response. | A | M |
| 0.5 | `content.js`: register message listener; `extractSnapshot()` returns 2–3 fake nodes; `executeAction()` logs. | A | S |
| 0.6 | Server skeleton (pick **FastAPI** — matches ML track's Python, easier LLM libs): `POST /agent/step` returns canned `{status:"action",action:{type:"scroll",amount:900}}` for iter<3 then `{status:"done",answer:"stub"}`. CORS for extension origin. | B | M |
| 0.7 | `browserApi` shim wrapping `chrome.runtime/storage/scripting/tabs` (Firefox seam). | A | S |
| 0.8 | ML track (parallel, no dependency): stand up export env; export + quantize **BlazeFace** first (smallest, highest-certainty win); verify it loads in a Node `onnxruntime-web` smoke test. | C | M |

**Exit criteria:** load unpacked extension in Chrome; click Run; watch status log step
through iterations against the mock server; answer pane shows "stub". `npm run build` +
server `uvicorn` documented in README.

---

### Phase 1 — Real agent loop: DOM + LLM (Days 2–5)

**Deliverable:** *"Go to x.com and find the top 10 Elon Musk posts and summarize them"* works
end-to-end. No redaction, no vision yet.

| # | Task | Track | Effort |
|---|---|---|---|
| 1.1 | `lib/domExtractor.js`: viewport-intersecting walk; per-node `{id, role, text≤300, rect, interactive, author?, timestamp?}`; write synthetic `data-agent-id` back to DOM. Generic fallback selector `button,a,input,[role]`. | A | L |
| 1.2 | `lib/siteConfigs.js`: x.com hints (`article[data-testid=tweet]`, `div[data-testid=tweetText]`, `a[href*="/status/"]`, author, time). Pluggable by `siteConfigId`. | A | M |
| 1.3 | `collectWithScroll(targetCount)`: fixed-increment scroll, re-extract, dedupe by post URL / `data-agent-id`, stop at `targetCount` or `maxScrollAttempts` (e.g. 12). Wait heuristic: `document_idle` + short settle timer + mutation-quiet check. | A | L |
| 1.4 | `executeAction()` real impl for `click / scroll / type / wait / extract`. Target elements by `data-agent-id`. | A | M |
| 1.5 | Background: replace mock with real `fetch` to `/agent/step`; pass task memory (`prompt`, `iteration`, `accumulatedData`) each turn; append server's `extractedItems`/nodes to `accumulatedData`. | A | M |
| 1.6 | Server orchestrator: build LLM prompt (system = task framing + action-schema rules; user = task + compact-JSON sanitized DOM + `screenState`). | B | M |
| 1.7 | LLM integration with **tool-use / function-calling** for the action schema (Claude or GPT-4-class). One tool `emit_step` with the §4.3 response shape. Temperature low. | B | M |
| 1.8 | Server-side schema validation of LLM output + one retry-with-correction on malformed JSON. | B | S |
| 1.9 | "Enough data" logic: server decides `done` when `len(unique posts) ≥ requested N` or client reports scroll dead-end; produce summary answer + cleaned `extractedItems`. | B | M |
| 1.10 | ML track (parallel): export + **static**-quantize TinyViT screen classifier; assemble the ~200-image calibration set (login/feed/form/checkout screenshots). Export DistilBERT-NER INT8. | C | L |

**Milestone demo (PRD §8 Phase 1):** record a clean screen capture of the Elon Musk task
completing. This is the fallback demo video's backbone.

**Exit criteria:** ≥8/10 runs collect 10 unique posts and return a coherent summary within
6 iterations; each iteration logged with `performance.now()` deltas.

---

### Phase 2 — Textual redaction + eval harness (Days 5–8)

**Deliverable:** all PII in the DOM snapshot is replaced with typed tokens before leaving the
content script; precision/recall measurable on a labeled set; debug panel shows what was hit.

| # | Task | Track | Effort |
|---|---|---|---|
| 2.1 | `lib/redact.js` regex layer: email, phone (multi-region), credit card (Luhn-checked), SSN/national-ID, address heuristic. Typed replacement: `[REDACTED_EMAIL|PHONE|CC|SSN|ADDRESS]`. Operates on each node's `text` + known value-bearing attrs. | A | M |
| 2.2 | NER layer: lazy-load DistilBERT-NER ONNX (INT8) only when snapshot contains free-text nodes; map `B/I-PER,LOC` → `[REDACTED_NAME|LOCATION]`. Behind a mock for CI. | A | L |
| 2.3 | `redactionLog` `{type,count,elementId}[]` — local only. Wire "What was redacted" `<details>` panel in popup (counts by type + toggle to highlight boxes on page). | A | M |
| 2.4 | Visual-redaction stub: offscreen `<canvas>` copy of screenshot + a `drawRedactions(boxes)` that paints opaque black rects. No vision input yet — feed it hand-set boxes to prove the path. | A | M |
| 2.5 | Server-side leak check: same regex layer in `server/redaction_qa/`; if `sanitizedDom` still matches a PII pattern → re-redact + increment `leakCatchRate` metric; never reject the request in demo mode. | B | M |
| 2.6 | System-prompt note so the LLM treats `[REDACTED_*]` as opaque and never tries to fill them in. | B | S |
| 2.7 | **`eval/` harness** — the scoring backbone: <br>• `eval/pii_test_set/` — 30–50 synthetic pages (HTML snapshots) with a sidecar `labels.json` marking every PII span + type. Cover: profile pages, checkout forms, login, data tables, chat logs, plus **negatives** (task-relevant text that must NOT be redacted — e.g. tweet bodies, product names). <br>• `eval/metrics.py` — runs `redact.js` logic (via node) over the set, computes PII **recall** (spans caught / labeled), **precision** (correct / all redactions), and **redaction precision** (non-PII wrongly masked). Emits `eval/report.json`. | C | L |
| 2.8 | `screen_state_test_set/` — 60–100 labeled screenshots for TinyViT accuracy (criterion 1, 25%). | C | M |
| 2.9 | First measured numbers checked into `eval/report.json`; iterate regex/NER thresholds to hit PRD §7 targets (recall ≥90%, precision ≥85%). | A/C | M |

**Exit criteria:** `python eval/metrics.py` prints recall/precision/redaction-precision +
leak-catch rate; recall ≥90% and precision ≥85% on the synthetic set; debug panel populated
in a live run.

---

### Phase 3 — Vision pipeline + visual redaction (Days 8–11)

**Deliverable:** BlazeFace + TinyViT running client-side (WebGPU with **working** WASM
fallback), visual redaction driven by real detections, resource budget profiled.

| # | Task | Track | Effort |
|---|---|---|---|
| 3.1 | `lib/visionPipeline.js`: `ort.InferenceSession` per PRD §4.4 config; EP list `[webgpu, wasm]`; `web_accessible_resources` for `models/*.onnx|*.wasm`; models bundled in extension. | A | M |
| 3.2 | Screenshot capture: `chrome.tabs.captureVisibleTab` in background → transfer bitmap to content script (or capture via `OffscreenCanvas`); downscale to model input sizes. | A | M |
| 3.3 | Face pass (Model A): run on every snapshot; boxes → `drawRedactions`. Target <40ms/720p on iGPU. | A | M |
| 3.4 | Screen pass (Model B): 224×224; output → (a) region labels driving extra redaction (`password-input`, `payment-info` → black-box even with no visible text), (b) `screenState` label + confidence attached to request; low confidence sets `sendScreenshot:true`. | A | M |
| 3.5 | **WASM fallback path — P0.** Force-disable WebGPU (`chrome://flags` off / test machine) and verify full loop still runs; set `ort.env.wasm.numThreads`, `simd`. Measure CPU (<60% one core sustained) and latency. | A/C | M |
| 3.6 | Wire vision boxes + Model-B region labels into `redact.js` so visual + textual tracks both complete before the snapshot message posts (hard barrier). | A | S |
| 3.7 | Resource profiling harness: peak memory (`performance.memory` / `chrome.system.memory` where available), model bundle sizes, per-model + combined inference latency. Output to the same metrics report. Targets: <350MB peak, <150ms combined, bundle ≈7–10MB. | C | M |
| 3.8 | Screen-state accuracy run on `screen_state_test_set/` → into `eval/report.json` (criterion 1). | C | S |

**Exit criteria:** cold-load both models, run the Elon task with vision active on WebGPU
*and* on WASM-only; redacted screenshot (when sent) shows black boxes over faces/embedded
PII; all §7 resource/latency numbers recorded, passing or with a documented gap.

---

### Phase 4 — Hardening & generalization (Days 11–13)

**Deliverable:** second site proves generality; every known failure mode has a defined path;
metrics visible live.

| # | Task | Track | Effort |
|---|---|---|---|
| 4.1 | Second demo site + `siteConfig` (candidate: a Hacker News / Reddit / Wikipedia task — text-heavy, stable DOM, clear "top N" analogue). Prove the generic fallback extractor also produces a usable snapshot with no site config. | A/B | L |
| 4.2 | Error handling matrix: WebGPU unavailable (→ WASM), server timeout (→ retry once, then partial answer), server unreachable (→ **local-only mode** with cached/mocked step response — still demo DOM+redaction+vision standalone), infinite-scroll dead-end (→ "found 6 of 10 requested"), LLM malformed after retry (→ error state + surfaced message), login wall detected (screen-state `login` → stop with explanation). | A/B | L |
| 4.3 | **Metrics dashboard** in popup (or a separate `dashboard.html`): live per-iteration latency, last eval `report.json` numbers (recall/precision/redaction-precision/screen-state accuracy), peak memory, EP in use (WebGPU/WASM), leak-catch count. This is the judge-facing scorecard for criteria 4 & 5. | A | M |
| 4.4 | Firefox polyfill pass (**stretch**): `webextension-polyfill`, verify `browserApi` shim, note ORT WebGPU gaps. Time-box to half a day; drop if behind. | A | M |
| 4.5 | Prompt-injection / robustness sanity: page text can't steer the agent (system prompt hardening); oversized DOM truncation keeps payload <200KB. | B | S |
| 4.6 | Tune calibration / NER to close any Phase 2–3 metric gaps. | C | M |

**Exit criteria:** both sites complete their tasks; kill the server mid-run and the demo
degrades gracefully; dashboard shows real numbers.

---

### Phase 5 — Demo polish (Days 13–14)

**Deliverable:** a scripted, rehearsed judge demo + recorded fallback + one-page metrics sheet.

| # | Task | Effort |
|---|---|---|
| 5.1 | Script 2–3 tasks: (a) Elon top-10 on x.com, (b) second-site "top N", (c) a page with visible PII (synthetic profile/checkout) to show redaction live in the debug panel + redacted screenshot. | M |
| 5.2 | Record full-run fallback video of each (covers server/network failure on demo day). | S |
| 5.3 | Metrics one-pager mapping numbers → PRD §9 criteria table; pull values from `eval/report.json` + dashboard. | S |
| 5.4 | Seed data: pinned test accounts / cached pages so demo doesn't depend on x.com rate limits or login walls. Consider a local HTML fixture mirror of the target pages. | M |
| 5.5 | Rehearse twice end-to-end on the actual demo machine; verify WASM path works there. | S |
| 5.6 | README + architecture.mmd final; short "how it works" slide. | S |

---

## 6. Eval & metrics — consolidated

| Criterion (PRD §9) | Weight | Artifact that produces the number | Built in |
|---|---|---|---|
| Visual context accuracy | 25% | `screen_state_test_set/` + `metrics.py` → screen-state classification accuracy; DOM/vision cross-check rate | P2.8 / P3.8 |
| PII recall & precision | 20% | `pii_test_set/` + `metrics.py` → recall, precision | P2.7 |
| Redaction precision | 20% | same harness → non-PII wrongly masked; server leak-catch rate | P2.5 / P2.7 |
| Client resource use | 20% | profiling harness → peak MB, CPU %, bundle size, INT8 confirmation | P3.7 |
| End-to-end latency | 15% | `performance.now()` per-iteration timers → dashboard, logged every run | P1 onward |

Keep `eval/report.json` under version control and regenerate it at the end of each phase so
regressions are visible.

---

## 7. Repo bootstrap (Phase 0.1 concretely)

```
sih171/
├── extension/
│   ├── manifest.json
│   ├── popup.{html,js,css}
│   ├── background.js
│   ├── content.js
│   ├── dashboard.html            # Phase 4
│   ├── lib/{messages,browserApi,domExtractor,siteConfigs,redact,visionPipeline}.js
│   └── models/{blazeface_int8,tinyvit_screen_int8,distilbert_ner_int8}.onnx
├── server/
│   ├── app.py                    # FastAPI
│   ├── routes/agent_step.py
│   ├── llm/{prompt_templates.py,action_schema.json}
│   └── redaction_qa/server_side_regex_check.py
├── eval/
│   ├── pii_test_set/             # *.html + labels.json
│   ├── screen_state_test_set/    # *.png + labels.json
│   ├── metrics.py
│   └── report.json
├── docs/
│   ├── PRD.md
│   ├── IMPLEMENTATION_PLAN.md    # this file
│   ├── api-contract.md
│   ├── model-contract.md
│   └── architecture.mmd
├── build.mjs                     # esbuild: bundle extension/lib + copy static + models
├── package.json
└── requirements.txt
```

Build tooling: **esbuild** for the extension (fast, no framework needed; add Preact only if
the popup grows). **FastAPI + uvicorn** for the server. **onnxruntime + onnxruntime-tools**
(Python) for export/quantization; **onnxruntime-web** in the extension.

---

## 8. Risk register (delta from PRD §10)

| Risk | Plan response |
|---|---|
| ORT-Web WebGPU kernel gaps for MobileViT/TinyViT ops | Validate the *exact* exported graph runs on `webgpu` EP during P1.10 (before integration). If ops missing → fall back to a plain MobileNetV3-small classifier for screen-state; the "ViT" requirement is still met by keeping TinyViT on the WASM path and documenting the tradeoff. |
| DistilBERT-NER at ~65MB blows the resource budget | Lazy-load (already planned); also prepare a distilled 6-layer or `bert-tiny`-NER alternative; report memory both with and without NER loaded. |
| Synthetic PII test set not representative → inflated scores | Include real-world-shaped negatives (tweet text, product listings, code snippets) and hold out 20% for a final unseen run reported separately. |
| x.com login wall / rate limit on demo day | Local HTML fixture mirror of target pages (P5.4) + recorded video (P5.2) + local-only mode (P4.2). |
| Two-model vision latency exceeds 150ms combined on WASM | Run Model B every 2nd iteration or only on screen-state change; Model A (face) stays every frame. Document the cadence. |
| Time overrun eats Phases 4–5 | Firefox (4.4), second site config polish, and VLM screenshot path are the pre-agreed cut lines. |

---

## 9. Explicitly deferred (not in the 14-day MVP)

- Firefox parity beyond the `browserApi` shim + a time-boxed polyfill attempt.
- VLM (Qwen2-VL / LLaVA) screenshot reasoning path — architecture leaves the hook
  (`sendScreenshot` + server branch) but MVP uses text-only open/cloud model.
- Multi-tab orchestration.
- Persistent cross-session task history.
- Cross-site generalization beyond the two demo sites.
- Blur-based (reversible) redaction — hard black-box only.

---

## 10. First actions (do these now)

1. `git init` + Phase 0.1 repo scaffold.
2. Write `docs/api-contract.md`, `docs/model-contract.md`, `extension/lib/messages.js` (§4).
3. Track C: start BlazeFace export in parallel (0.8).
4. Stand up the mock-server round trip (0.4 + 0.6) — the first visible milestone.
