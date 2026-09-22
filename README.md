# Privacy-Preserving Browser Agent — SIH PS 26171

On-device visual perception + local redaction for a lightweight browser agent.

- **Client** (Chrome MV3 extension): extracts a compact DOM snapshot, runs a local
  vision pipeline (ONNX Runtime Web, WebGPU → WASM → mock), redacts all PII locally
  (typed tokens in text, hard black-box on the screenshot), then sends only the
  sanitized context to the server.
- **Server** (FastAPI): stateless `/agent/step`. Re-checks redaction (defense in depth),
  asks an LLM (Inception Mercury 2 by default, Claude optional) for the next browser
  action or a final answer via a strict JSON schema. Falls back to a deterministic mock
  stepper with no API key.
- **Eval**: `eval/metrics.py` produces the PII recall/precision + redaction-precision
  numbers for scoring; latency is measured live in the popup.

See `docs/PRD.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/api-contract.md`,
`docs/model-contract.md`.

## Quick start

### 1. Server

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # then put your INCEPTION_API_KEY in .env
uvicorn server.app:app --reload --port 8000
```

Provider is set in `.env` via `LLM_PROVIDER`:

| value | needs | notes |
|---|---|---|
| `inception` (default) | `INCEPTION_API_KEY` | Mercury 2 — diffusion LLM, OpenAI-compatible, ~5–10× faster |
| `anthropic` | `ANTHROPIC_API_KEY` + `pip install anthropic` | Claude, `AGENT_MODEL` overridable |
| `mock` | nothing | deterministic offline stepper (also `MOCK_LLM=1`) |

`GET /health` → `{"ok": true, "provider": "inception", "engine": "mercury-2"}`.
`.env` is gitignored; commit only `.env.example`.

### 2. Extension

```bash
npm install
npm run build          # -> dist/   (npm run watch for rebuilds)
```

`chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
Open any normal web page (not a `chrome://` page), click the toolbar icon, type a
task, **Run**. Tick **Local-only** to demo perception + redaction with no server.

The agent runs on the active tab and can **navigate, open/switch tabs, click, type,
scroll, and go back** — so tasks like *"go to news.ycombinator.com and explain the
Google Jail story"* or *"find the top 10 Elon Musk posts and summarize them"* work
from any starting page. It stops at `maxIterations` (8) or when the LLM returns a
final answer. Question tasks need a real provider (`inception`/`anthropic`); the mock
stepper only does collection tasks.

### 3. Eval

```bash
npm run test:redact    # redaction unit tests
npm run eval           # -> eval/report.json
```

## Vision pipeline modes

`visionPipeline.getMode()` → `webgpu` | `wasm` | `mock`. Without ONNX files in
`extension/models/` it runs in **mock mode**: deterministic outputs derived from the
screenshot + DOM hints, so the full agent loop works offline. Drop real models in per
`extension/models/README.md` to go live.

## Status vs. plan

Implemented: Phase 0 (skeleton + contracts), Phase 1 (DOM + agent loop, mock + real
LLM), Phase 2 (regex redaction layer + typed tokens + server-side leak check + eval
harness + debug panel), Phase 3 scaffold (vision pipeline with WebGPU/WASM/mock, visual
black-box redaction, metrics dashboard).

Not yet: real ONNX model export (track C), DistilBERT-NER wiring, screen-state accuracy
run, Firefox polyfill, second-site hardening pass. See `docs/IMPLEMENTATION_PLAN.md`.

## Layout

```
extension/   MV3 extension source (bundled to dist/ by build.mjs)
  lib/       messages, browserApi, domExtractor, siteConfigs, redact, visionPipeline, visualRedact
server/      FastAPI app, /agent/step route, llm/ (prompt + schema + client), redaction_qa/
eval/        metrics.py, run_redact.mjs, pii_test_set/, screen_state_test_set/
docs/        PRD, implementation plan, api-contract, model-contract, architecture.mmd
```
