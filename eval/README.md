# Eval harness

Produces the measured numbers behind 3 of the 5 SIH scoring criteria.

```
npm run eval          # == python3 eval/metrics.py  -> writes eval/report.json
```

## What it measures

| Output | Criterion | How |
|---|---|---|
| `pii_recall_regex_layer` | PII recall (20%) | labeled spans caught / labeled spans, **excluding** NAME/LOCATION which need the NER model |
| `pii_precision_regex_layer` | PII precision (20%) | correct redactions / all redactions |
| `redaction_precision` | Redaction precision (20%) | `1 − (task-relevant strings wrongly masked / total negatives)` |
| `screen_state.accuracy` | Visual context accuracy (25%) | **stub** — wire `visionPipeline.classifyScreen` over `screen_state_test_set/*.png` once Model B exists |
| latency | End-to-end latency (15%) | measured live in the extension (popup Metrics panel / `dashboard.html`), not here |

## `pii_test_set/`

One JSON fixture per page. Shape:

```jsonc
{
  "id": "01_profile_page",
  "nodes": [ { "id": "p1", "role": "...", "text": "...", "author": "..." } ],
  "labels": {
    "pii":       [ { "elementId": "p2", "type": "EMAIL", "value": "a@b.com" } ],
    "negatives": [ { "elementId": "p6", "value": "task-relevant string that must survive" } ]
  }
}
```

`type` ∈ `EMAIL PHONE CC SSN ID ADDRESS NAME LOCATION`. Matching is span-level:
elementId + type must be equal and the values must overlap (substring either way, so
`+91 98765 43210` matches `98765 43210`).

Current set is 5 fixtures (starter). **Target: 30–50** across profile pages, checkout
forms, login, data tables, chat logs, and media-only pages — with a held-out 20% for a
final unseen run reported separately.

### Known hard cases (documented on purpose)

- `05_news_article` lists `S. Somanath` / `Sriharikota` as **negatives**: public
  figures / place names in a news context are task-relevant, not PII. Once NER is wired
  it will flag these, so the redaction engine needs a context gate (e.g. don't redact
  PER/LOC inside `role=article`/`heading` on `content`/`feed` screens). This fixture is
  the regression guard for that gate.

## `screen_state_test_set/`

`labels.json` maps `filename -> state` (`login|feed|checkout|form|content|unknown`).
Drop the matching screenshots in. Doubles as the TinyViT static-quantization
calibration set.

## Running just the redaction pass

```
node eval/run_redact.mjs eval/pii_test_set   # prints raw predictions as JSON
```
