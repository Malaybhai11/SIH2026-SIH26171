# Aavaran — evaluation scorecard

Generated 2026-09-25 from `eval/results/*.json`. Machine: Intel(R) Core(TM) i5-4310U CPU @ 2.00GHz x4, no GPU (WASM backend).

| SIH criterion | Metric | Result |
|---|---|---|
| 1. Visual context accuracy (25%) | Screen category, **unseen websites** (leave-domain-out 5-fold CV, 217 screens from 96 sites, 10 categories) | **73.3%** (pixels-only zero-shot: 55.8%) |
| 2. PII detection (20%) | Indian PII set — recall / precision / F1 | **0.956 / 0.985 / 0.97** |
| | ai4privacy (public, English) — recall / precision / F1 | 0.751 / 0.991 / 0.854 |
| | Hindi/Devanagari set, rules only (no Hindi NER) — recall / precision / F1 | 0.766 / 1 / 0.867 |
| | Faces, WIDER FACE val (≥24 px) — precision / recall | 0.783 / 0.732 |
| 3. Redaction precision (20%) | Pixel precision / pixel recall / sensitive objects covered | **0.913 / 0.997 / 46/46** |
| 4. Client resources (20%) | Engine memory (WASM+weights), eco / balanced | 36.6 MB / 173.3 MB |
| | Perception per step, median (p90), eco / balanced | 333 (439) ms / 377 (1459) ms |
| | Unchanged frame (dHash cache) | 148 ms |
| 5. End-to-end latency (15%) | Demo tasks (wall clock, all passed, 0 leaks) | checkout 7.4 s · inbox 5.8 s · kyc 21.8 s · register 17.2 s · social 6.1 s |

Privacy check on every task run: the server's own audit log is searched for each of the user's raw values — **0 leaks** across 5 tasks.
