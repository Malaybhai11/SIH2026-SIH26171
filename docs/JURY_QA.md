# Jury Q&A prep — Aavaran (SIH 2026, PS 26171)

Every number below is read straight from `eval/results/*.json` (the same files
`docs/deck/build_deck.py` pulls into the slide deck and `npm run eval:summary` writes
into `eval/results/SUMMARY.md`). Where something is a design decision rather than a
measured result, that is said explicitly. Where something is a real limitation, it is
stated as one — this doc does not round a weakness up.

---

### 1. Why on-device redaction instead of trusting a server-side redaction step?

Because "server-side redaction" still requires the raw screenshot and raw DOM to reach
the server *first*, so it has to be trusted with your Aadhaar, face and OTP before it
redacts anything — that trust boundary is exactly what an agent acting on sensitive
government/banking pages can't assume. Aavaran never serializes the raw frame: perception,
redaction and tokenisation all happen in the browser (`extension/lib/perception/*`,
`redact.js`) before the first `fetch`. What actually reaches the server is checked
independently, after the fact, by grepping the server's own request-audit log
(`server/audit/requests.jsonl`) for every raw value the user typed or that was on the
page — **0 leaks across the 5 end-to-end demo tasks** (`eval/results/summary.json`,
criterion 5; `eval/results/e2e_*.json`).

### 2. What's your actual measured PII detection accuracy, and where does it fail?

Two corpora, rules (checksum-validated regex) + on-device BERT-small NER combined
(`eval/results/pii.json`):

| Corpus | Recall | Precision | F1 |
|---|---|---|---|
| Indian synthetic (360 sentences, 36 templates, Aadhaar/PAN/GSTIN/UPI/OTP/etc.) | **0.956** | 0.985 | 0.97 |
| ai4privacy/pii-masking-200k, English, 500 rows | **0.751** | 0.991 | 0.854 |

Real failure modes, by type, from the same file:
- **Names catch nothing without NER.** Rules-only NAME recall is exactly 0 on both
  corpora — names are only found by the BERT-small model (0.91 Indian, 0.861 ai4privacy).
- **Date of birth is inconsistent.** Indian-template DOB (DD/MM/YYYY style) is 100%
  recall; free-text English DOB phrasing in ai4privacy is **0% recall** on both rules and
  NER. We do not claim general DOB extraction works.
- **Passwords are weak everywhere.** Recall 0.438 on both corpora — password fields
  depend on context markers ("password:", "pwd") that don't always appear near the value.
- Addresses and locations need NER too (rules-only recall 0–0.07; with NER, 0.62–0.95
  depending on corpus).

### 3. How do you handle a novel PII pattern your regex rules don't cover?

The NER layer is exactly the answer for *unstructured* novel patterns — that's why it
exists on top of checksum rules (Indian PII recall goes 0.606 → 0.956 when NER is added;
`eval/results/pii.json`, `eval/README.md` "Findings worth knowing"). For a genuinely new
*structured* identifier (a new government ID format the rules have never seen), the honest
answer is: neither the rules nor the NER model is guaranteed to catch it on the first
encounter. Two backstops exist beyond detection: sensitive `<input>` fields (password,
card, CVV, OTP, Aadhaar) are boxed by field type regardless of whether the value pattern
matches anything, and the client egress gate re-checks every outgoing string against the
Vault's own raw values before it leaves — so at minimum, anything the user typed into the
task prompt or the page cannot leave verbatim even if a rule misses it.

### 4. What happens if the model blocks a legitimate action, or misses something and a value leaks?

Over-redaction (blocking legitimate content) is checked with hard-negative sentences —
order IDs, PNRs, ISBNs, IFSC codes, prices that look like PII but aren't: **1 false alarm
out of 120 hard-negative sentences** (`eval/results/pii.json`,
`indian_synthetic.rulesPlusNer.hardNegatives`). Under-redaction (a real leak) is guarded
by four layers — checksum rules, NER, Vault-value matching, and whole-field boxing for
sensitive inputs — plus a fail-closed egress gate and a server-side second check. Measured
outcome: 0 leaks in 5 end-to-end tasks. The honest caveat: 5 tasks is a demonstration, not
a statistically meaningful leak-rate estimate — there is no large-scale or adversarial
leak-rate study behind that number.

### 5. How does this compare to just prompting a bigger model to "not repeat PII"?

A system prompt can't stop data from crossing the network boundary in the first place —
the raw pixels/DOM would still be sent to get a response, and the provider can still log,
cache or fine-tune on that payload regardless of what the prompt asks the model to output.
Aavaran's redaction is a deterministic geometric operation (DOM `Range.getClientRects()` →
pixel boxes) checked against ground truth, not a model behaving well: pixel precision
0.913, pixel recall 0.997, 46/46 sensitive objects covered
(`eval/results/redaction.json`). The reasoning model on the server never has to be asked
to behave — it structurally never receives the raw values in the first place.

### 6. What's your latency and resource cost on a real low-end device?

Measured on a 2014-era 4-core Intel i5-4310U laptop CPU with **no GPU** (WASM backend,
deliberately not a high-end judge laptop) — `eval/results/latency.json`:

| Mode | Engine memory | Warm step (median / p90) | Cold start | Unchanged frame |
|---|---|---|---|---|
| eco | 36.6 MB | 333 ms / 439 ms | 2.3 s | 142 ms |
| balanced | 173.3 MB | 377 ms / **1459 ms** | 8.2 s | 148 ms |

The honest number to flag is balanced mode's p90: 1.46 s, well above its own median,
because MobileCLIP + NER cold-cache misses are expensive on WASM. We have not tested on
an actual budget Android tablet/phone — only laptop-class CPU, and extensions don't even
run on mobile Chrome (see Q7).

### 7. Why Chrome MV3 specifically? What about mobile browsers?

MV3's offscreen-document API is what lets one perception engine (WebGPU/WASM, all three
models loaded once) serve every tab without a service worker tearing it down —
`docs/ARCHITECTURE.md`. The same codebase ships a Firefox build too (background page
hosts the engine instead of an offscreen document; `npm run build:firefox` →
`dist-firefox/`), so it isn't Chrome-only. Mobile is genuinely out of scope: Chrome for
Android does not support MV3 extensions and Firefox for Android's extension support is
limited, so nothing here runs on a phone browser today.

### 8. How would this integrate with a real DigiLocker/IRCTC-class government service in production?

It hasn't been tried against a real government portal — everything measured here runs
against five synthetic demo sites we built (`server/demo/`: bank KYC, webmail, social
feed, checkout, an ISRO outreach registration form) with AI-generated faces and a
SPECIMEN-marked ID card. Production integration on a real portal would need: DOM/field
detection rules validated against that portal's actual markup (ours are tuned to the demo
sites), CAPTCHA and bot-wall handling (`eval/results/screens.json` shows real confusion
between `auth`/`login` pages and `error_captcha` in the wild — see Q10), a formal
security/privacy review given DPDP Act obligations, and almost certainly the portal
operator's own authorization to run an automated agent against it at all.

### 9. What's out of scope — what do you NOT claim this system does yet?

Stated plainly:
- Mobile browsers (Q7).
- A tested integration with any real government or banking site (Q8) — only synthetic demo clones.
- OCR of PII printed *inside* an image (e.g. reading the Aadhaar number off a photographed
  card) — the vision model classifies the whole image as `id_card`/`signature`/etc. and
  boxes it as one object; it does not extract text from pixels.
- Reliable DOB extraction from free-text English phrasing (0% recall, Q2).
- A statistically powered leak-rate study or adversarial/red-team test suite — the 0-leak
  result is over 5 tasks, not hundreds, and there is no dedicated prompt-injection eval in
  `eval/results/` (see Q16).
- Comet mode (multi-tab parallel sub-agents, `docs/COMET_MODE.md`) is implemented but off
  by default and has no entry in `eval/results/` — it was not part of the measured
  pipeline this scorecard covers.
- Formal DPDP Act certification — the design is *aligned with* data-minimization and
  purpose-limitation principles; that is not the same as a legal compliance sign-off.

### 10. 54.0% screen classification — is that good enough to trust in a live demo?

That's the shipped model (CLIP fused with DOM structure), measured with **leave-domain-out
5-fold cross-validation** over 235 screens from 115 real sites, 10 categories
(`eval/results/screens.json`) — meaning no site in a validation fold was seen in training,
which is the honest way to test "unseen websites." This number is down from an earlier
73.3% measured on a smaller, less diverse 217-screen/96-site set; adding a broader real-site
pool (including India's e-governance/banking sites for A2) didn't just add hard new
examples — it changed the leave-domain-out fold split for the *whole* dataset, and the
fold-independent zero-shot CLIP baseline dropped too (0.558 → 0.391), so this is a real
generalization gap the smaller set was hiding, not a fold-shuffle artifact or a labeling
mistake (verified by hand-checking every new capture against `eval/screens_labels.json`
before retraining). Per-class accuracy is uneven and `media` (video/map screens) is now the
weakest category — confused with `error` on 12 of 20 examples — alongside `code` (0.28) and
`reading` (0.38). The reason this doesn't threaten the demo's privacy claims: screen
category is a soft context signal fused into what the server sees as metadata — the actual
redaction decision (which *is* safety-critical) runs independently off DOM rects and
checksum rules, not off the screen-category label. A wrong "form" vs "auth" guess, or even a
wrong `media` vs `error` guess, does not cause a PII leak. This gap is exactly why A2 is
tracked as ongoing work rather than closed.

### 11. What does "0 leaks in 5 tasks" actually verify, and how rigorous is the check?

`AUDIT_LOG=1` makes the server write every request it receives to
`server/audit/requests.jsonl`. After each task, `eval/task_e2e.mjs` reads that log and
substring-searches it for every one of the user's raw values from the demo page's own
ground-truth labels (name, phone, email, Aadhaar, etc.) — any hit fails the run. It is a
check against what the server's process actually received on disk, not a client
self-report. The limitation: it's a substring search over 5 specific synthetic
pages/prompts, not a fuzzed or adversarial corpus, and it wouldn't catch a leak encoded
indirectly (e.g. spelled out character-by-character, or laundered through the model's own
returned text) — that class of leak is not tested.

### 12. Redaction pixel precision is 0.913, not 1.0 — what's in that gap?

Per-page breakdown in `eval/results/redaction.json`: precision ranges 0.848 (inbox) to
0.954 (KYC), while pixel *recall* is 0.994–1.0 everywhere and object recall is 46/46
(every ground-truth sensitive object got at least one covering box). The gap is
over-redaction, not under-redaction — painted boxes run slightly larger than the tightest
possible bounding box around the PII text (padding from `Range.getClientRects()` on
wrapped/multi-line spans), which is the safer failure direction for a privacy tool.

### 13. Face detection precision/recall (0.783/0.732 on WIDER) — good enough?

YuNet 2023mar, FP32, evaluated on 300 WIDER FACE validation images, faces ≥24px, IoU≥0.5:
1280 true positives, 354 false positives, 468 false negatives
(`eval/results/faces.json`). The real failure mode is size: recall on 24–48px faces
(1050 of the 1748 ground-truth faces — the majority) is only **65.2%**; it climbs to
81.1% at 48–96px and 92.1% at 96px+. Small/thumbnail avatar-sized faces are where this
model is weakest on its own; the engine partially compensates in production by packing
image regions into a 640px mosaic that upscales small avatars before detection
(`docs/model-contract.md`), but that specific mosaic benefit isn't broken out as a
separate number in this eval.

### 14. Why three separate small models instead of one bigger on-device multimodal model?

Each does one job and its precision was chosen by direct measurement, not habit
(`docs/model-contract.md`, `eval/README.md`): YuNet ships FP32 because INT8 (QDQ) measured
2.6× *slower* on the WASM CPU backend; MobileCLIP ships FP16 because dynamic INT8 measured
as collapsing zero-shot accuracy (a group photo scored "chart" at p≈0.85); BERT-small
ships INT8 because FP16 doesn't run on the WASM execution provider at all. Combined they're
51.9 MB (balanced mode, `eval/results/latency.json`) — smaller than most on-device
multimodal models capable of face + screen-understanding + PII-NER, and each is swappable
independently.

### 15. Did the measured server latency numbers actually use the open-weights VLM you're pitching?

Honestly, no — and this is worth being upfront about. `server/llm/client.py` supports two
relevant providers: `"vlm"` (any OpenAI-compatible open-weights VLM — Qwen2.5-VL,
Llama-4-Scout, Gemma-3 via vLLM/Ollama — which receives the redacted Set-of-Marks
screenshot as an image) and `"inception"` (Inception Labs Mercury 2, a fast **text-only**
model that never receives the image). The `avgServerMs` figures in
`eval/results/latency.json` and `eval/results/e2e_*.json` were captured using the
`inception` provider, chosen for fast iterative development. The VLM code path is
implemented and used for the Privacy X-ray screenshot pipeline, but its own latency and
answer quality on the redacted image haven't been separately benchmarked and reported
here. The architecture claim (any OpenAI-compatible open-weights endpoint) is true; the
specific measured server-latency numbers in the scorecard are from the text-only path.

### 16. What about prompt injection, or a malicious page trying to make the agent exfiltrate data?

Not measured. There is no adversarial-page or prompt-injection eval in `eval/results/` —
this was not part of the work done this session. What exists structurally: the server's
response is constrained to a JSON action schema (`server/llm/action_schema.json`), not
free text, so a compromised model can't simply emit an arbitrary side channel through the
action format; the egress gate re-checks every outgoing string against the Vault and rules
regardless of what triggered it; and the audit log gives after-the-fact visibility. None
of that has been tested against an actual adversarial page. State this as a design
property, not a measured one.

### 17. Can you claim DPDP Act 2023 compliance?

No — the design is aligned with DPDP's data-minimization and purpose-limitation
principles (raw PII never leaves the device by construction, an audit trail exists for
accountability), but "aligned with" is a design-intent claim, not a legal compliance
certification. No formal legal or compliance review has been conducted.

### 18. How do we know the deck's numbers aren't just typed in for the pitch?

`docs/deck/build_deck.py` loads `eval/results/pii.json`, `faces.json`, `redaction.json`,
`screens.json` and `latency.json` directly (`R = lambda f: json.loads(...)`) and every
number on the deck's metrics slide is an f-string over those parsed values — nothing is
hand-typed. Re-running `python3 docs/deck/build_deck.py` after re-running
`npm run eval:*` regenerates the deck from whatever the scripts measured that time; there
is no manual step where a number gets typed into the script or the template. The only
placeholders left as literal text are `TEAM_ID` / `TEAM_NAME` at the top of the script,
which are administrative, not measured claims.

### 19. Is Comet mode (multi-tab / parallel sub-agents) part of what's being demoed?

No. It's implemented (`docs/COMET_MODE.md`) and off by default because it multiplies
client-side compute, and it has zero entries in `eval/results/` — none of the five SIH
criteria numbers in this scorecard were measured with Comet mode active. If asked about
it, the honest framing is "an additional capability layered on the single-tab agent,
unevaluated," not part of the measured pipeline.

---

**Source of every number above:** `eval/results/pii.json`, `faces.json`,
`redaction.json`, `screens.json`, `latency.json`, `e2e_checkout.json`, `e2e_inbox.json`,
`e2e_kyc.json`, `e2e_register.json`, `e2e_social.json`, and the rollups in `summary.json`
/ `SUMMARY.md`. Reproduce any of them with `npm run eval:pii`, `eval:faces`,
`eval:redaction`, `eval:screens`, `eval:latency`, `eval:e2e`, then `eval:summary`
(`eval/README.md`).
