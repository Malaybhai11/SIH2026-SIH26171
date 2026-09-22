"""LLM step decider.

Providers (selected via LLM_PROVIDER, or auto-detected from which key is present):
  - "inception" : Inception Labs Mercury 2 (diffusion LLM, OpenAI-compatible, very fast)
  - "anthropic" : Claude with structured output
  - "mock"      : deterministic mock stepper (no key / MOCK_LLM=1) so the pipeline
                  runs fully offline

All providers are constrained to action_schema.json and validated identically, with
one retry-with-correction on malformed output.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .prompt_templates import SYSTEM, build_user_message, _target_count

_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    p = _ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

_SCHEMA = json.loads((_ROOT / "server/llm/action_schema.json").read_text())
_SCHEMA = {k: v for k, v in _SCHEMA.items() if not k.startswith("$")}  # strip $comment

_FORCE_MOCK = os.environ.get("MOCK_LLM", "").lower() in {"1", "true", "yes"}
_PROVIDER = os.environ.get("LLM_PROVIDER", "").lower().strip()

_INCEPTION_KEY = os.environ.get("INCEPTION_API_KEY", "")
_INCEPTION_BASE = os.environ.get("INCEPTION_BASE_URL", "https://api.inceptionlabs.ai/v1")
_INCEPTION_MODEL = os.environ.get("INCEPTION_MODEL", "mercury-2")

_ANTHROPIC_MODEL = os.environ.get("AGENT_MODEL", "claude-opus-5")

_ACTION_KEYS = ("type", "targetId", "url", "amount", "text", "ms", "index")
_ACTION_TYPES = {"click", "scroll", "type", "wait", "extract", "navigate", "open_tab", "switch_tab", "back"}


def resolve_provider() -> str:
    if _FORCE_MOCK:
        return "mock"
    if _PROVIDER in {"inception", "anthropic", "mock"}:
        return _PROVIDER
    if _INCEPTION_KEY:
        return "inception"
    if os.environ.get("ANTHROPIC_API_KEY") or (Path.home() / ".config/anthropic").exists():
        return "anthropic"
    return "mock"


def engine_label() -> str:
    p = resolve_provider()
    return {"inception": _INCEPTION_MODEL, "anthropic": _ANTHROPIC_MODEL, "mock": "mock"}[p]


# --------------------------------------------------------------------------- shared
def _normalize_action(a: dict | None) -> dict | None:
    if not a:
        return None
    return {k: a.get(k) for k in _ACTION_KEYS}


def _blank_item(d: dict) -> dict:
    return {k: d.get(k) for k in ("author", "text", "timestamp", "href")}


def _validate(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("not an object")
    if data.get("status") not in {"action", "done"}:
        raise ValueError("bad status")
    if data["status"] == "action":
        a = data.get("action") or {}
        if a.get("type") not in _ACTION_TYPES:
            raise ValueError("bad action.type")
        if a["type"] in {"click", "type"} and not a.get("targetId"):
            raise ValueError(f"{a['type']} needs targetId")
        if a["type"] in {"navigate", "open_tab"} and not a.get("url"):
            raise ValueError(f"{a['type']} needs url")
    if data["status"] == "done" and not data.get("answer"):
        raise ValueError("done needs answer")


def _finalize(data: dict) -> dict:
    data["action"] = _normalize_action(data.get("action"))
    data.setdefault("extracted", [])
    data.setdefault("extractedItems", [])
    data.setdefault("reasoning", "")
    return data


# --------------------------------------------------------------------------- mock
def mock_step(req: dict) -> dict:
    prompt = req.get("prompt", "")
    target = _target_count(prompt)
    snapshot = req.get("sanitizedDom") or []
    acc = req.get("accumulatedData") or []

    if target == 0:
        # Not a collection task — the mock stepper can't browse/reason, so it just
        # reports what's visible. (Use a real provider for question tasks.)
        visible = [
            (n.get("text") or "").strip()
            for n in snapshot
            if (n.get("text") or "").strip()
        ][:15]
        return _finalize(
            {
                "status": "done",
                "answer": "[MOCK_LLM] Question tasks need a real LLM provider. Visible on the page:\n"
                + "\n".join(f"- {t[:160]}" for t in visible),
                "reasoning": "mock cannot answer free-form questions",
            }
        )

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
        return _finalize(
            {
                "status": "done",
                "answer": f'[MOCK_LLM] {len(items)} item(s) for "{prompt}":\n' + "\n".join(lines),
                "extractedItems": items,
                "reasoning": "mock: target reached or iteration cap",
            }
        )
    return _finalize(
        {
            "status": "action",
            "action": {"type": "scroll", "targetId": None, "amount": 900, "text": None, "ms": None},
            "extracted": unique_new,
            "reasoning": f"mock: {projected}/{target} collected, scrolling",
        }
    )


# ---------------------------------------------------------------------- inception
def _inception_step(req: dict) -> dict:
    import httpx

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": build_user_message(req)},
    ]
    body = {
        "model": _INCEPTION_MODEL,
        "temperature": 0,
        "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "agent_step", "strict": False, "schema": _SCHEMA},
        },
    }

    last_err = None
    with httpx.Client(timeout=30.0) as http:
        for _ in range(2):
            r = http.post(
                f"{_INCEPTION_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {_INCEPTION_KEY}"},
                json=body,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            try:
                data = json.loads(content)
                _validate(data)
                return _finalize(data)
            except Exception as e:  # one retry-with-correction
                last_err = e
                body["messages"] = messages + [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": f"That was invalid ({e}). Return ONLY valid JSON matching the schema."},
                ]
    raise ValueError(f"Mercury output failed validation twice: {last_err}")


# ---------------------------------------------------------------------- anthropic
def _anthropic_step(req: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": build_user_message(req)}]

    last_err = None
    for _ in range(2):
        resp = client.messages.create(
            model=_ANTHROPIC_MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=messages,
        )
        raw = next(b.text for b in resp.content if b.type == "text")
        try:
            data = json.loads(raw)
            _validate(data)
            return _finalize(data)
        except Exception as e:
            last_err = e
            messages = [
                {"role": "user", "content": build_user_message(req)
                 + f"\n\n(Previous reply invalid: {e}. Return valid JSON matching the schema.)"}
            ]
    raise ValueError(f"LLM output failed validation twice: {last_err}")


# ------------------------------------------------------------------------- public
_STEP_FNS = {"inception": _inception_step, "anthropic": _anthropic_step, "mock": mock_step}


def decide_step(req: dict) -> tuple[dict, str]:
    """Returns (response_dict, engine) where engine is the model id or 'mock'/'error'."""
    provider = resolve_provider()
    if provider == "mock":
        return mock_step(req), "mock"
    try:
        return _STEP_FNS[provider](req), engine_label()
    except Exception as e:
        msg = str(e)
        code = "llm_malformed" if "validation" in msg or "schema" in msg else "llm_unavailable"
        return {"status": "error", "code": code, "message": msg[:300]}, "error"
