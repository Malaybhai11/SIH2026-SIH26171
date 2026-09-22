#!/usr/bin/env python3
"""Compute the SIH scoring numbers from the labeled test sets.

    python3 eval/metrics.py            # runs everything, writes eval/report.json

Criteria covered here:
  - PII detection recall & precision           (criterion 2, 20%)
  - Redaction precision / over-redaction rate  (criterion 3, 20%)
  - Screen-state classification accuracy       (criterion 1, 25%) — stubbed until Model B
  - Latency                                    (criterion 5) — measured live in the extension

Recall / precision are span-level. A predicted span matches a labeled span when the
elementId matches and the predicted redaction VALUE overlaps the labeled value
(case-insensitive substring either way) — this tolerates boundary differences
(e.g. "+91 98765 43210" vs "98765 43210").
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PII_DIR = ROOT / "pii_test_set"
SCREEN_DIR = ROOT / "screen_state_test_set"
REPORT = ROOT / "report.json"

# Regex layer alone cannot catch these without the NER model; excluded from the
# "regex-layer recall" headline and reported separately so the number is honest.
NER_ONLY_TYPES = {"NAME", "LOCATION"}


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _overlap(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    return bool(na) and bool(nb) and (na in nb or nb in na)


def run_redaction_eval() -> dict:
    proc = subprocess.run(
        ["node", str(ROOT / "run_redact.mjs"), str(PII_DIR)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"run_redact.mjs failed:\n{proc.stderr}")
    predictions = {p["id"]: p for p in json.loads(proc.stdout)}

    tp = fp = fn = 0
    ner_only_fn = 0
    over_redactions = 0
    negatives_total = 0
    per_fixture = []

    for fx_path in sorted(PII_DIR.glob("*.json")):
        fx = json.loads(fx_path.read_text())
        pred = predictions.get(fx["id"], {"predicted": [], "redactedNodes": []})
        pred_spans = list(pred["predicted"])
        labels = fx["labels"]["pii"]
        negatives = fx["labels"].get("negatives", [])

        matched_pred = set()
        f_tp = f_fn = 0
        for lab in labels:
            hit = None
            for i, ps in enumerate(pred_spans):
                if i in matched_pred:
                    continue
                if (
                    ps["elementId"] == lab["elementId"]
                    and ps["type"] == lab["type"]
                    and _overlap(ps["value"], lab["value"])
                ):
                    hit = i
                    break
            if hit is not None:
                matched_pred.add(hit)
                tp += 1
                f_tp += 1
            else:
                if lab["type"] in NER_ONLY_TYPES:
                    ner_only_fn += 1
                else:
                    fn += 1
                    f_fn += 1

        f_fp = 0
        for i, ps in enumerate(pred_spans):
            if i not in matched_pred:
                fp += 1
                f_fp += 1

        # Over-redaction: a negative (task-relevant) string that got masked.
        redacted_text = {n["id"]: (n.get("text") or "") for n in pred["redactedNodes"]}
        for neg in negatives:
            negatives_total += 1
            txt = redacted_text.get(neg["elementId"], "")
            if neg["value"] not in txt:
                over_redactions += 1

        per_fixture.append(
            {
                "id": fx["id"],
                "tp": f_tp,
                "fp": f_fp,
                "fn": f_fn,
                "labels": len(labels),
            }
        )

    recall = tp / (tp + fn) if (tp + fn) else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    over_rate = over_redactions / negatives_total if negatives_total else 0.0

    return {
        "span_counts": {"tp": tp, "fp": fp, "fn": fn, "ner_only_fn": ner_only_fn},
        "pii_recall_regex_layer": round(recall, 4),
        "pii_precision_regex_layer": round(precision, 4),
        "redaction_precision": round(1 - over_rate, 4),
        "over_redaction_rate": round(over_rate, 4),
        "over_redactions": over_redactions,
        "negatives_total": negatives_total,
        "targets": {"recall": 0.90, "precision": 0.85},
        "note": (
            "NAME/LOCATION labels need the DistilBERT-NER model (not present); "
            f"{ner_only_fn} such span(s) excluded from the regex-layer recall headline."
        ),
        "per_fixture": per_fixture,
    }


def run_screen_state_eval() -> dict:
    labels_file = SCREEN_DIR / "labels.json"
    if not labels_file.exists():
        return {"status": "no test set", "accuracy": None}
    labels = json.loads(labels_file.read_text())
    images = list(SCREEN_DIR.glob("*.png")) + list(SCREEN_DIR.glob("*.jpg"))
    return {
        "status": "pending Model B (TinyViT)",
        "labeled_examples": len(labels),
        "images_present": len(images),
        "accuracy": None,
        "note": "Wire visionPipeline.classifyScreen over these images once the ONNX model exists.",
    }


def main() -> None:
    report = {
        "redaction": run_redaction_eval(),
        "screen_state": run_screen_state_eval(),
        "latency": {
            "status": "measured live in the extension",
            "source": "popup Metrics panel / dashboard.html",
            "target_per_loop_ms": 2500,
        },
    }
    REPORT.write_text(json.dumps(report, indent=2))

    r = report["redaction"]
    print(f"PII recall (regex layer):    {r['pii_recall_regex_layer']:.1%}  (target ≥ 90%)")
    print(f"PII precision (regex layer):  {r['pii_precision_regex_layer']:.1%}  (target ≥ 85%)")
    print(f"Redaction precision:          {r['redaction_precision']:.1%}  "
          f"({r['over_redactions']}/{r['negatives_total']} task-relevant strings wrongly masked)")
    print(f"NER-only spans deferred:      {r['span_counts']['ner_only_fn']}")
    print(f"\nfull report → {REPORT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
