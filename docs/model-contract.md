# Model I/O Contract

Pins the tensor shapes and label maps so the client can integrate against a mock
`InferenceSession` before the real `.onnx` files exist. The client vision/NER code MUST NOT
assume anything beyond what is written here.

All three models ship in `extension/models/` (git-ignored; drop real files in to enable).
Without them, the pipeline runs in **mock mode** — deterministic outputs derived from a hash
of the input, so the full agent loop is demoable offline.

---

## Model A — Face detector (`blazeface_int8.onnx`)

| | |
|---|---|
| Purpose | Always-on face detection for visual redaction |
| Input | `input` : `float32[1,3,128,128]`, RGB, normalized to `[-1, 1]` (`(px/127.5) - 1`) |
| Output | `boxes` : `float32[N,4]` as `[x1,y1,x2,y2]` in input-pixel space; `scores` : `float32[N]` |
| Post-proc | keep `score >= 0.5`; NMS IoU 0.3; scale boxes back to screenshot resolution |
| Target | < 40 ms per 720p screenshot on integrated GPU |

## Model B — Screen/region classifier (`tinyvit_screen_int8.onnx`)

| | |
|---|---|
| Purpose | (a) region labels to guide redaction, (b) coarse screen-state for request metadata |
| Input | `input` : `float32[1,3,224,224]`, RGB, ImageNet norm (mean `[0.485,0.456,0.406]`, std `[0.229,0.224,0.225]`) |
| Output | `logits` : `float32[1,6]` |
| Region labels (index → name) | `0 sensitive-form-field`, `1 password-input`, `2 payment-info`, `3 body-text`, `4 image-content`, `5 navigation` |
| Derived screen-state | argmax over a tiled/averaged pass → mapped: {password-input,sensitive-form-field}→`login`; payment-info→`checkout`; body-text→`content` or `feed` (feed if many `article` roles in DOM); image-content→`content`; navigation→`unknown`. Confidence = softmax max. |

The client attaches `screenState` + `screenStateConfidence` to every `/agent/step` request.
When confidence `< 0.6` or screenState ∈ {`login`,`checkout`,`unknown`}, the client sets
`sendScreenshot: true`.

## Model C — PII NER (`distilbert_ner_int8.onnx`)

| | |
|---|---|
| Purpose | Catch names/locations that the regex layer cannot |
| Tokenizer | WordPiece, `bert-base-cased` vocab, max seq 256, `[CLS]`/`[SEP]`, lowercase=false |
| Input | `input_ids` : `int64[1,256]`, `attention_mask` : `int64[1,256]` |
| Output | `logits` : `float32[1,256,9]` |
| Tag map (BIO) | `0 O`, `1 B-PER`, `2 I-PER`, `3 B-ORG`, `4 I-ORG`, `5 B-LOC`, `6 I-LOC`, `7 B-MISC`, `8 I-MISC` |
| Mapping to tokens | `PER` span → `[REDACTED_NAME]`, `LOC` span → `[REDACTED_LOCATION]`. `ORG`/`MISC` are **not** redacted (task-relevant, e.g. company names). |
| Loading | lazy — only when a snapshot contains free-text nodes; skip on pure-media pages |

The client bundles a small JSON vocab at `extension/models/bert_vocab.json` for tokenization.
In mock mode, the NER layer is a no-op (regex still runs).

---

## Mock-mode behaviour (no `.onnx` files present)

| Model | Mock output |
|---|---|
| A (face) | 0 boxes normally; if the screenshot mean-luma of any 64px tile crosses a fixed threshold, emit 1 synthetic box for that tile (lets the visual-redaction path be demoed) |
| B (screen) | screenState derived purely from DOM heuristics (role counts, presence of `input[type=password]`), confidence fixed at 0.55 so `sendScreenshot` stays off unless DOM says login/checkout |
| C (NER) | no-op |

`visionPipeline.getMode()` returns `"webgpu" | "wasm" | "mock"` and is surfaced in the popup
debug panel and metrics dashboard.
