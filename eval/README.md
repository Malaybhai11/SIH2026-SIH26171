# Evaluation

Every number comes from a script here running the **shipped** code (same modules the
extension bundles; models through `onnxruntime-node`, or the real extension in Chrome via
Puppeteer). Results land in `eval/results/`; `npm run eval:summary` writes
[`results/SUMMARY.md`](results/SUMMARY.md).

Prerequisites: `npm install && npm run fetch-models && npm run build`, and the server
running (`uvicorn server.app:app --port 8000`, with `AUDIT_LOG=1` for the task runs).
Chrome at `/usr/bin/google-chrome` (or `CHROME_PATH`).

| Script | Criterion | What it measures |
|---|---|---|
| `pii_eval.mjs` | 2 | Span recall/precision/F1, rules-only vs rules+NER, per type. Corpora: 500 rows of the public ai4privacy/pii-masking-200k (English); 360 Indian sentences from 36 templates with checksum-valid Aadhaar/GSTIN/PAN/cards and 12 hard-negative templates (order ids, PNRs, ISBNs, IFSC, prices…); and 340 Hindi/Devanagari sentences from 31 templates (B4 — Devanagari-numeral Aadhaar/phone/OTP/DOB/account, Hindi label words, honorific names, a Devanagari city gazetteer) with 7 Hindi hard-negative templates, scored rules-only since the shipped NER model is English-only. |
| `faces_eval.mjs` | 2 | YuNet precision/recall on 300 WIDER FACE val images (IoU ≥ 0.5, faces ≥ 24 px; smaller faces are ignore regions). Needs `WIDER_val.zip` + `wider_face_split.zip` from `CUHK-CSE/wider_face` unzipped in `eval/.cache/`. |
| `redaction_eval.mjs` | 2, 3 | Real extension on the 5 demo sites. Ground truth = `data-pii` / `data-face` / `data-sensitive-img` annotations (the extension never reads them). Pixel precision/recall (micro) and per-object coverage (≥ 90% painted). |
| `screens_capture.mjs` + `screens_train.mjs` | 1 | 217 labelled screenshots of 96 public sites + demo sites (labels checked against each capture: `screens_labels.json`). **Leave-domain-out** 5-fold: zero-shot CLIP vs CLIP+DOM fusion (shipped) vs trained linear heads. |
| `latency_eval.mjs` | 4, 5 | Per-step on-device latency (cold, warm, unchanged frame), stage breakdown, model MB, full engine memory via `performance.measureUserAgentSpecificMemory()` (includes WASM heaps), for eco and balanced modes. |
| `task_e2e.mjs --task …` | 5 + privacy | Runs a real task (register / inbox / kyc / social / checkout) through extension + server, checks the outcome in the page, and searches the server's received requests for every raw value of the user — any hit fails the run. |

## Findings worth knowing

* **Model precision was chosen by measurement.** YuNet INT8 is 2.6× slower than FP32 in
  WASM (QDQ overhead). MobileCLIP INT8 (dynamic) collapses zero-shot accuracy (a group
  photo scores "chart" with p≈0.85 while FP32/FP16 say "people"); FP16 matches FP32 exactly.
* **NER is where recall comes from:** ai4privacy recall 0.29 → 0.75 and Indian 0.61 →
  0.96 when BERT-small is added to the rules, at unchanged ~0.99 precision.
* **The DOM rescues screen understanding.** Zero-shot CLIP alone: 55.8% on unseen sites;
  fused with structural counts: 73.3%. Trained linear heads did *worse* (51–58%) under
  leave-domain-out — classes dominated by one site (GitHub, Wikipedia) never appear in
  training folds; more site diversity is future work.
* **Label hygiene:** 8 of the first 63 "login/signup" captures were actually bot-check walls
  served to the headless browser; labels follow what the screen shows.
* **Hindi (B4): structured PII generalizes across scripts, names don't — yet.** Once
  Devanagari digits are normalized index-preserving before the checksum rules run, every
  digit-based type (Aadhaar/phone/OTP/DOB/bank account/PIN) and every rule with a Hindi
  label word hits 1.00 recall/precision, same as the English rule. Person names only reach
  0.34 recall: the honorific-triggered rule (श्री/श्रीमती/…) catches names that follow a
  title, but a bare name has nothing to catch it, since the shipped NER model is
  English-only. Overall: R=0.77, P=1.00, 0 false alarms on 80 Hindi hard negatives
  (reference numbers, PNRs, dates, ISRO mission text). Closing the name gap needs a
  Devanagari-capable NER model — real work, not done here, and not silently claimed.
  Two corpus-generator bugs surfaced and were fixed in the process (not detector bugs):
  stripping "+91 " before Devanagari-digit conversion merged the "91" into the digit run
  and made it unmatchable, and reusing Devanagari names for email local-parts produced
  addresses no detector should match (real Indian email usernames are Latin-script even
  in Hindi text) — both are exactly the kind of synthetic-data bug a red-team pass (E2)
  is meant to catch even in eval code, not just product code.
* Numbers are from a 4-core i5-4310U laptop CPU with no GPU (WASM backend). On a machine
  with WebGPU the CLIP/NER stages get much faster; the WASM figures are the floor.
