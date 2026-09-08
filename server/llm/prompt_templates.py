"""Prompt construction for the agent step. The sanitized DOM is passed as compact
JSON, not prose — the model reasons over structure. Redaction tokens are explained
so the model never tries to "fill them in"."""

import json

SYSTEM = """\
You are the reasoning core of a privacy-preserving browser agent. Each turn you receive:
  - the user's task,
  - a SANITIZED snapshot of the page (a compact accessibility tree, JSON),
  - a coarse screen-state label from an on-device vision model,
  - data already accumulated in previous turns.

All personally identifiable information has been removed ON THE USER'S DEVICE before it
reached you and replaced with typed placeholder tokens:
  [REDACTED_EMAIL] [REDACTED_PHONE] [REDACTED_CC] [REDACTED_SSN] [REDACTED_ID]
  [REDACTED_ADDRESS] [REDACTED_NAME] [REDACTED_LOCATION]
Treat these as opaque. NEVER guess, reconstruct, or ask for the underlying values. You can
still reason about structure ("this row has a name and an email").

Your job: decide the SINGLE next step.
  - status "action" with an action to progress the task (click / scroll / type / wait / extract).
      * "click"/"type" need "targetId" = a node id from the snapshot.
      * "scroll" needs "amount" in pixels (positive = down). Use ~900 for feeds.
      * Put any items you can already extract from THIS snapshot into "extracted"
        (they are merged into accumulated data, de-duplicated by href/text).
  - status "done" when the task is complete: put the final natural-language "answer"
    and the cleaned final list in "extractedItems".

Prefer finishing over looping. If the snapshot shows the target quantity is already
collected (accumulated + this snapshot), return "done". Keep "reasoning" to one sentence.
Unused fields must still be present: use null for scalars and [] for arrays.
"""


def build_user_message(req: dict) -> str:
    target = _target_count(req.get("prompt", ""))
    payload = {
        "task": req.get("prompt"),
        "iteration": req.get("iteration"),
        "maxIterations": req.get("maxIterations"),
        "targetCount": target,
        "screenState": req.get("screenState"),
        "screenStateConfidence": req.get("screenStateConfidence"),
        "site": req.get("siteConfigId"),
        "accumulatedCount": len(req.get("accumulatedData") or []),
        "accumulatedData": req.get("accumulatedData") or [],
        "snapshot": req.get("sanitizedDom") or [],
    }
    return (
        "Decide the next step. Respond ONLY with the structured object.\n\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def _target_count(prompt: str) -> int:
    import re

    m = re.search(r"\btop\s+(\d{1,3})\b", prompt, re.I) or re.search(
        r"\b(\d{1,3})\s+(?:posts|items|results|articles|tweets)\b", prompt, re.I
    )
    return min(int(m.group(1)), 50) if m else 10
