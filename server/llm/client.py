"""LLM step decider.

Real path: Claude with structured output constrained to action_schema.json.
Fallback: a deterministic mock stepper (no key / no SDK / MOCK_LLM=1) so the whole
pipeline is demoable offline.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .prompt_templates import SYSTEM, build_user_message, _target_count

_SCHEMA = json.loads((Path(__file__).parent / "action_schema.json").read_text())
_MODEL = os.environ.get("AGENT_MODEL", "claude-opus-5")
_FORCE_MOCK = os.environ.get("MOCK_LLM", "").lower() in {"1", "true", "yes"}

# Fields the schema demands on every action object.
_ACTION_KEYS = ("type", "targetId", "amount", "text", "ms")


def _normalize_action(a: dict | None) -> dict | None:
    if not a:
        return None
    return {k: a.get(k) for k in _ACTION_KEYS}


def _blank_item(d: dict) -> dict:
    return {k: d.get(k) for k in ("author", "text", "timestamp", "href")}


# --------------------------------------------------------------------------- mock
def mock_step(req: dict) -> dict:
    prompt = req.get("prompt", "")
    target = _target_count(prompt)
    snapshot = req.get("sanitizedDom") or []
    acc = req.get("accumulatedData") or []

    fresh = [
        _blank_item(n)
        for n in snapshot
        if n.get("role") == "article" or (n.get("href") and n.get("text"))
    ]

    seen = {(i.get("href") or i.get("text")) for i in acc}
    unique_new = [i for i in fresh if (i.get("href") or i.get("text")) not in seen]
    projected = len(acc) + len(unique_new)

    if projected >= target or req.get("iteration", 1) >= req.get("maxIterations", 6):
        items = (acc + unique_new)[:target]
        lines = [
            f"{i+1}. {(it.get('author') or '?')}: {(it.get('text') or '').strip()[:180]}"
            for i, it in enumerate(items)
        ]
        return {
            "status": "done",
            "action": None,
            "extracted": [],
            "answer": f"[MOCK_LLM] {len(items)} item(s) for \"{prompt}\":\n" + "\n".join(lines),
            "extractedItems": items,
            "reasoning": "mock: target reached or iteration cap",
        }

    return {
        "status": "action",
        "action": {"type": "scroll", "targetId": None, "amount": 900, "text": None, "ms": None},
        "extracted": unique_new,
        "answer": None,
        "extractedItems": [],
        "reasoning": f"mock: {projected}/{target} collected, scrolling",
    }


# --------------------------------------------------------------------------- real
def _real_step(req: dict) -> dict:
    import anthropic  # imported lazily so the server runs without the SDK

    client = anthropic.Anthropic()
    user_msg = build_user_message(req)

    def _call() -> str:
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": _SCHEMA},
            },
            messages=[{"role": "user", "content": user_msg}],
        )
        return next(b.text for b in resp.content if b.type == "text")

    last_err = None
    for attempt in range(2):
        raw = _call()
        try:
            data = json.loads(raw)
            _validate(data)
            data["action"] = _normalize_action(data.get("action"))
            data.setdefault("extracted", [])
            data.setdefault("extractedItems", [])
            return data
        except Exception as e:  # malformed once -> retry with correction appended
            last_err = e
            req = {**req, "prompt": req["prompt"] + f"\n\n(Previous reply invalid: {e}. Return valid JSON matching the schema.)"}

    raise ValueError(f"LLM output failed validation twice: {last_err}")


def _validate(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("not an object")
    if data.get("status") not in {"action", "done"}:
        raise ValueError("bad status")
    if data["status"] == "action":
        a = data.get("action") or {}
        if a.get("type") not in {"click", "scroll", "type", "wait", "extract"}:
            raise ValueError("bad action.type")
        if a["type"] in {"click", "type"} and not a.get("targetId"):
            raise ValueError(f"{a['type']} needs targetId")
    if data["status"] == "done" and not data.get("answer"):
        raise ValueError("done needs answer")


# ------------------------------------------------------------------------- public
def decide_step(req: dict) -> tuple[dict, str]:
    """Returns (response_dict, engine) where engine is 'mock' or the model id."""
    if _FORCE_MOCK:
        return mock_step(req), "mock"
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return mock_step(req), "mock"
    if not (os.environ.get("ANTHROPIC_API_KEY") or Path.home().joinpath(".config/anthropic").exists()):
        return mock_step(req), "mock"
    try:
        return _real_step(req), _MODEL
    except Exception as e:
        return {
            "status": "error",
            "code": "llm_malformed" if "validation" in str(e) else "llm_unavailable",
            "message": str(e)[:300],
        }, "error"
