# PRD — On-Device Visual Perception for Lightweight Browser Agents

**SIH Problem Statement ID:** 26171 · ISRO / Department of Space
**Doc owner:** [team name]
**Status:** Draft v1
**Target platform:** Chrome (Manifest V3), Firefox as stretch goal via WebExtension polyfill

---

## 1. Overview

We are building a browser agent that:

1. Runs **locally in a Chrome extension** — no side panel, standard popup + injected content scripts.
2. Uses a **local vision pipeline** (lightweight ViT / CNN detectors via ONNX Runtime Web + WebGPU) to read screen state and detect sensitive regions (faces, password fields, PII text blocks).
3. Extracts a **structured DOM snapshot** in parallel — this is the primary reasoning substrate sent to the server, since it is faster and more precise than pixel-level understanding for text-heavy tasks.
4. **Redacts** all sensitive content locally — visually (blur/black-box on screenshots) and textually (DOM tag masking) — before anything leaves the device.
5. Sends only the sanitized context to a **server-side LLM/VLM**, which returns either a final answer or a structured browser action (click / scroll / type).
6. Executes returned actions locally and loops until task completion.

Worked example used throughout this doc: *"Go to x.com and find the top 10 Elon Musk posts and summarize them."*

---

## 2. Goals / Non-Goals

**Goals**
- Working end-to-end prototype: prompt in → agent perceives, redacts, reasons, acts → answer out.
- Local vision model genuinely running client-side (WebGPU/WASM), not a placeholder.
- Demonstrable, measurable redaction (precision/recall reportable on a small labeled test set).
- Latency budget that feels usable in a live demo (target: <2.5s per agent loop iteration).
- Directly satisfies all 5 SIH evaluation criteria (see §11).

**Non-Goals (for MVP)**
- Full cross-site generalization / production robustness.
- Full offline server (cloud LLM is acceptable per PS rules during SIH).
- Complex multi-tab orchestration.
- Firefox parity in MVP (design for it, ship Chrome first).

---

## 3. High-Level Architecture

```mermaid
flowchart TD
    subgraph Browser["Chrome Extension (client)"]
        POP[Popup UI\n(prompt input, status, answer)]
        BG[Background Service Worker\n(orchestrator)]
        CS[Content Script\n(injected per tab)]
        DOME[DOM Extractor]
        VIS[Vision Pipeline\nONNX Runtime Web + WebGPU]
        RED[Redaction Engine\n(text + visual)]
    end

    subgraph Server["Server (Node/FastAPI)"]
        API[/agent/step endpoint/]
        ORC[Task Orchestrator]
        LLM[LLM / VLM\n(cloud or local open-weight)]
    end

    POP -->|task prompt| BG
    BG -->|request snapshot| CS
    CS --> DOME
    CS -->|screenshot| VIS
    VIS -->|bounding boxes: faces, PII regions| RED
    DOME -->|raw DOM tree| RED
    RED -->|sanitized DOM + redacted screenshot| BG
    BG -->|POST sanitized context + task| API
    API --> ORC --> LLM
    LLM -->|action JSON or final answer| ORC --> API
    API -->|response| BG
    BG -->|execute action| CS
    BG -->|display answer| POP
```

---

## 4. Client-Side Components

### 4.1 Extension Shell (Manifest V3)

**manifest.json — key fields**

```json
{
  "manifest_version": 3,
  "name": "Privacy-Preserving Browser Agent",
  "version": "0.1.0",
  "permissions": ["activeTab", "scripting", "storage", "tabs"],
  "host_permissions": ["https://x.com/*", "https://twitter.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [
    {
      "matches": ["https://x.com/*", "https://twitter.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    { "resources": ["models/*.onnx", "models/*.wasm"], "matches": ["<all_urls>"] }
  ]
}
```

Notes:
- `host_permissions` scoped to demo sites for MVP; broaden for generalization later.
- ONNX model files ship inside the extension bundle (or lazy-fetched from a CDN with SRI hash pinning) so inference never depends on a live network call for the model itself — only the sanitized payload goes to the server.
- Popup is a standard `popup.html` (not side panel per current requirement) — 420×600px, holds: prompt textbox, "Run" button, live status log, final answer pane, and a collapsible "What was redacted" debug panel (important for judge demos).

### 4.2 Background Service Worker (`background.js`)

Responsibilities:
- Owns the agent loop state machine: `IDLE → PERCEIVING → REDACTING → REASONING → ACTING → DONE/ERROR`.
- Relays messages between popup ↔ content script ↔ server via `chrome.runtime.sendMessage` / `fetch`.
- Enforces loop cap (default: 6 iterations) and per-iteration timeout (default: 8s) to prevent runaway loops in a demo.
- Maintains a short conversation/task memory object (task prompt, iteration count, accumulated extracted data) — passed to server each turn since the server itself is stateless per request.

State object (kept in `chrome.storage.session`):

```json
{
  "taskId": "uuid",
  "prompt": "find top 10 elon musk posts and summarize",
  "iteration": 2,
  "maxIterations": 6,
  "accumulatedData": [ /* array of extracted post objects so far */ ],
  "status": "REASONING"
}
```

### 4.3 Content Script (`content.js`) — DOM Extractor

Core function: `extractSnapshot()` walks the visible DOM and returns a compact accessibility-like tree, not raw HTML (raw HTML is too noisy/large and leaks more surface area for PII).

Extraction rules:
- Only elements intersecting the viewport (`getBoundingClientRect` + `IntersectionObserver` cache) are included, to keep payload small and relevant.
- Each node gets: `id` (synthetic, written back into the DOM as `data-agent-id` for later action targeting), `role` (ARIA role or inferred from tag), `text` (truncated to ~300 chars), `rect` (x/y/w/h), `interactive` (boolean: is it clickable/typeable).
- Site-specific selector hints are allowed as a pluggable config (e.g. for x.com: `article[data-testid="tweet"]`, `div[data-testid="tweetText"]`, `a[href*="/status/"]`) — this keeps the extractor fast and precise on known sites while a generic fallback (`querySelectorAll('button, a, input, [role]')`) handles unknown sites.
- Infinite-scroll handling: a `collectWithScroll(targetCount)` helper scrolls in fixed increments, re-runs extraction, deduplicates by `data-agent-id`/post URL, and stops once `targetCount` unique items are collected or a max-scroll-attempts limit is hit.

Example extracted node:

```json
{
  "id": "n_0042",
  "role": "article",
  "text": "Just wrapped up static fire testing on...",
  "author": "@elonmusk",
  "timestamp": "2026-09-07T10:15:00Z",
  "rect": { "x": 12, "y": 340, "w": 600, "h": 180 },
  "interactive": false
}
```

### 4.4 Vision Pipeline (client-side, ONNX Runtime Web)

This is the component that most directly satisfies the PS requirement of a "local Vision Transformer (ViT) or equivalent CV model." Two-model pipeline, chosen for a realistic latency/accuracy tradeoff on consumer laptops without a discrete GPU:

**Model A — Face Detector (fast, always-on redaction pass)**
- Architecture: BlazeFace (SSD-based, ~150K params) or YuNet — sub-ViT complexity by design, because full-frame face detection must run every frame/screenshot cheaply.
- Input: 128×128 RGB, normalized [-1,1].
- Export: ONNX opset 17, static shapes for WebGPU kernel caching.
- Quantization: dynamic INT8 (weights only) via `onnxruntime.quantization.quantize_dynamic`.
- Backend: `webgpu` primary, `wasm` (SIMD + multithread) fallback via `ort.env.wasm.numThreads`.
- Target latency: <40ms per 720p screenshot on integrated GPU.

**Model B — Screen/Region Understanding (the actual ViT)**
- Architecture: MobileViT-XXS or TinyViT-5M — chosen over full ViT-B/16 specifically because ViT-B is too heavy for real-time in-browser inference (params, FLOPs, and WebGPU kernel maturity all favor mobile-oriented hybrid CNN-ViT architectures for this use case).
- Purpose: classify screen regions into semantic categories (`sensitive-form-field`, `password-input`, `payment-info`, `body-text`, `image-content`, `navigation`) to guide the redaction engine on *what* to redact beyond faces, and to give a coarse "screen state" signal (e.g. "login page," "feed page," "checkout page") that can be attached to the request as metadata — cheap extra context for the server LLM without sending pixels.
- Input resolution: 224×224 (standard ViT patch config, patch size 16 → 196 tokens).
- Quantization: static INT8 with calibration set of ~200 representative screenshots (login pages, feeds, forms, checkout flows) — static quantization preferred here over dynamic because activations benefit more from calibration at this resolution.
- Export path: PyTorch → ONNX (opset 17) → `onnxruntime.quantization.quantize_static`.
- Backend: `webgpu`; must implement a `wasm` fallback path since WebGPU support is inconsistent across users' machines (Chrome flags, GPU drivers) — **this fallback is not optional for the demo**, judges may run on machines without stable WebGPU.

**Runtime configuration (both models)**

```js
import * as ort from 'onnxruntime-web/webgpu';

ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
ort.env.wasm.simd = true;

const session = await ort.InferenceSession.create('/models/tinyvit_screen.onnx', {
  executionProviders: [
    { name: 'webgpu', preferredLayout: 'NHWC' },
    'wasm' // fallback
  ],
  graphOptimizationLevel: 'all'
});
```

**Resource budget (client-side vision, target ceiling for scoring criterion "client-side resource utilization" — 20%)**
- Peak memory: <350MB for both models loaded + inference buffers.
- CPU (WASM fallback path): <60% of one core sustained during a single inference call.
- Model bundle size: Face detector ~1.5MB (INT8), TinyViT ~5-8MB (INT8) — both shippable inside the extension package.

### 4.5 Redaction Engine (`redact.js`)

Two parallel redaction tracks, both must complete before any payload is sent:

**Visual redaction**
- Takes Model A/B bounding boxes → draws opaque black rectangles (not blur — blur is reversible with deconvolution in some cases; hard redaction is the safer default) directly on an offscreen `<canvas>` copy of the screenshot before it ever touches `fetch`.
- Password/payment fields detected by Model B get the same black-box treatment even without visible text (defense in depth in case OCR-like leakage is possible from styling).

**Textual / DOM redaction**
- Regex layer (fast, deterministic) for: emails, phone numbers (multi-region patterns), credit card numbers (Luhn-validated), SSNs/national IDs, physical addresses (heuristic).
- NER layer (semantic, for names/locations regex can't catch): a distilled BERT-NER (e.g. `distilbert-base-NER`, ONNX INT8 quantized, ~65MB — larger than the vision models, load lazily only if the page contains free-text fields, e.g. skip on pure media pages).
- Every match is replaced with a typed placeholder token: `[REDACTED_EMAIL]`, `[REDACTED_NAME]`, `[REDACTED_PHONE]`, `[REDACTED_ADDRESS]`. Typed tokens (vs a single generic `[REDACTED]`) let the server LLM still reason about *structure* ("this row has a name and an email") without ever seeing values.
- A redaction log `{count, type, elementId}[]` is kept locally for the debug panel and for computing precision/recall against your labeled test set — **never sent to the server**.

---

## 5. Server-Side Components

### 5.1 API Contract

`POST /agent/step`

Request:

```json
{
  "taskId": "uuid",
  "prompt": "find top 10 elon musk posts and summarize",
  "iteration": 2,
  "screenState": "feed-page",
  "sanitizedDom": [ /* array of extracted+redacted nodes, see §4.3 */ ],
  "redactedScreenshot": "base64-png-optional",
  "accumulatedData": [ /* from previous iterations, so server can decide "enough posts collected" */ ]
}
```

Response:

```json
{
  "status": "action" ,
  "action": { "type": "scroll", "amount": 800 },
  "reasoning": "Only 4 unique posts collected so far, need 10."
}
```

or, when done:

```json
{
  "status": "done",
  "answer": "Summary of top 10 posts: ...",
  "extractedItems": [ /* the 10 posts, cleaned */ ]
}
```

Action vocabulary (kept intentionally small for MVP): `click`, `scroll`, `type`, `wait`, `extract`, `done`.

### 5.2 Orchestrator

- Stateless per request (all state passed in from client) — simplifies horizontal scaling and matches "no persistent sensitive data on server" posture.
- Validates that `sanitizedDom` contains no un-redacted PII patterns as a **server-side second check** (defense in depth — server should never trust the client's redaction blindly; run the same regex layer server-side and reject/re-redact if it finds a leak). Log leak-catch rate as a QA metric during development.
- Builds the LLM prompt: system prompt explains the redaction scheme (so the model doesn't get confused by `[REDACTED_NAME]` tokens or try to "fill them in"), user prompt contains task + sanitized DOM (as compact JSON, not prose) + screen state label.
- Enforces the strict JSON action schema on LLM output (function-calling / tool-use mode if using Claude or GPT; JSON-mode/grammar-constrained decoding if using a local open-weight model).

### 5.3 Model choice

- **During SIH (cloud allowed):** Claude or GPT-4-class model via API, using tool-use/function-calling for the action schema — fastest to get reliable structured output.
- **Offline-deployable option (per PS requirement "any offline deployable open-source model"):** Qwen2-VL-7B-Instruct or LLaVA-NeXT for the rare cases you actually want to pass the redacted screenshot too; for pure-DOM reasoning (most tasks), a smaller text-only open model (Qwen2.5-7B-Instruct, Llama-3.1-8B-Instruct) run via vLLM/Ollama is sufficient and much cheaper — reserve the VLM only for tasks where DOM structure alone is ambiguous.

---

## 6. Sequence Walkthrough — "Top 10 Elon Musk posts"

1. User types prompt in popup → `background.js` creates `taskId`, sets state `PERCEIVING`, messages content script.
2. Content script: `extractSnapshot()` grabs currently visible tweets; vision pipeline runs on a screenshot in parallel (mostly to catch any embedded images with faces/PII in visible tweets); redaction engine masks any PII in tweet text (unlikely on this page, but always run).
3. Sanitized payload → `POST /agent/step`, iteration 1. Server sees 4 unique posts collected, prompt says "top 10" → returns `{status: action, action: {type: scroll, amount: 900}}`.
4. Background tells content script to scroll, waits for `document_idle`/network-idle heuristic, re-extracts (`collectWithScroll` dedupes against previous set).
5. Loop repeats until 10 unique posts collected or `maxIterations` hit.
6. Final iteration: server returns `{status: done, answer: "...", extractedItems: [...]}`.
7. Background writes answer to popup, ends loop, persists redaction log for debug panel.

---

## 7. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Per-iteration end-to-end latency | < 2.5s (local vision + DOM extraction + redaction + server round trip) |
| Local vision inference (both models combined) | < 150ms per screenshot |
| Client memory ceiling | < 350MB peak during inference |
| Client CPU (WASM fallback) | < 60% of one core sustained |
| Redaction recall on PII test set | ≥ 90% |
| Redaction precision (avoid over-redacting task-relevant text) | ≥ 85% |
| Max agent loop iterations | 6 (configurable) |
| Server payload size per request | < 200KB (DOM json), screenshot optional and only sent when Model B flags ambiguous screen state |

---

## 8. Phased Delivery Plan

**Phase 0 — Skeleton (days 1-2)**
- Extension scaffold, popup UI, background/content script messaging wired with dummy data.
- Server skeleton with hardcoded response, confirm round trip works.

**Phase 1 — DOM pipeline (days 2-4)**
- Real `extractSnapshot()` for x.com, `collectWithScroll`, dedup logic.
- Server calls real LLM with function-calling, returns real actions/answers.
- **Milestone demo:** the Elon Musk task works end-to-end without any redaction/vision yet.

**Phase 2 — Redaction (days 4-6)**
- Regex PII layer + typed token replacement.
- NER model integrated (lazy-loaded).
- Debug panel in popup showing redaction log.
- Build the labeled PII test set (~30-50 synthetic pages) for precision/recall measurement.

**Phase 3 — Vision pipeline (days 6-9)**
- BlazeFace + TinyViT ONNX models exported, quantized, integrated with WebGPU/WASM fallback.
- Visual redaction (black-box) wired to vision outputs.
- Latency/resource profiling against §7 targets.

**Phase 4 — Hardening + generalization (days 9-12)**
- Second demo site to prove generality beyond x.com.
- Error handling: WebGPU unavailable, server timeout, infinite-scroll dead-end.
- Firefox polyfill pass (stretch).

**Phase 5 — Demo polish (days 12-14)**
- Scripted judge demo (2-3 tasks), fallback recorded video, metrics dashboard (latency/resource numbers pulled live from `performance.now()` + `chrome.system.memory` where available).

---

## 9. Evaluation Criteria Mapping

| SIH Criterion | Weight | Where it's satisfied in this design |
|---|---|---|
| Accuracy of visual context from screen | 25% | TinyViT screen-state classification + DOM extraction cross-checked; report accuracy on labeled screen-state test set |
| Recall/precision of PII detection | 20% | Regex + NER dual layer; measured on synthetic labeled PII test set (§Phase 2) |
| Precision of redaction | 20% | Typed-token replacement + hard visual black-box; server-side leak-catch as second QA layer |
| Client-side resource utilization | 20% | Quantized INT8 models, WebGPU-first with WASM fallback, memory/CPU budgets in §7, profiled and reported |
| End-to-end latency | 15% | Per-iteration budget <2.5s, measured and logged live during demo |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WebGPU unsupported/unstable on judge's machine | Mandatory WASM fallback path, tested explicitly before demo day |
| x.com DOM structure changes (frequent on this site) | Site-specific selectors isolated in a config file, generic fallback extractor as backup |
| LLM returns malformed action JSON | Function-calling/tool-use mode + server-side schema validation + retry-with-correction prompt |
| Infinite scroll never surfaces 10 unique posts (rate limits, login walls) | `maxIterations` cap + graceful partial-answer fallback ("found 6 of 10 requested") |
| NER model false negatives on PII | Regex layer as first line of defense catches high-confidence structured PII regardless of NER performance |
| Demo network failure (server unreachable) | Local-only fallback mode: DOM extraction + redaction still demoable standalone, with a cached/mocked server response for judges |

---

## 11. Repository Structure

```
/extension
  manifest.json
  popup.html / popup.js / popup.css
  background.js
  content.js
  /lib
    domExtractor.js
    redact.js
    visionPipeline.js
  /models
    blazeface_int8.onnx
    tinyvit_screen_int8.onnx
    distilbert_ner_int8.onnx
/server
  app.py (or index.js)
  /routes
    agent_step.py
  /llm
    prompt_templates.py
    action_schema.json
  /redaction_qa
    server_side_regex_check.py
/eval
  pii_test_set/            # labeled synthetic pages
  screen_state_test_set/   # labeled screenshots
  metrics.py                # computes precision/recall/latency reports
/docs
  PRD.md (this file)
  architecture.mmd
```

---

## 12. Tech Stack Summary

| Layer | Choice |
|---|---|
| Extension | Manifest V3, vanilla JS (or lightweight preact for popup UI) |
| Local inference | ONNX Runtime Web (`onnxruntime-web/webgpu`), WASM fallback |
| Vision models | BlazeFace (face detect), MobileViT-XXS/TinyViT-5M (screen understanding) |
| PII NER | Distilled BERT-NER, ONNX INT8 |
| Server | FastAPI (Python) or Express (Node) |
| Cloud LLM (SIH demo) | Claude or GPT-4-class w/ tool-use |
| Offline LLM option | Qwen2.5-7B-Instruct (text) / Qwen2-VL-7B (vision-language) via vLLM/Ollama |
| Eval/metrics | Python scripts over labeled test sets, `performance.now()` client-side timers |

---

## 13. Open Questions (to resolve before Phase 2)

- Do we hard-cap the redacted screenshot from ever leaving the client, or only send it when Model B flags genuine ambiguity? (Recommendation: default off, opt-in per task type — minimizes bandwidth and attack surface.)
- Firefox support: full parity or "best effort" for SIH submission given time constraints?
- Do we need persistent task history across popup close/reopen, or is per-session (`chrome.storage.session`) sufficient for the demo?
