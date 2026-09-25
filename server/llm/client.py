"""LLM step decider.

Providers (selected via LLM_PROVIDER, or auto-detected from which key is present):
  - "vlm"       : ANY OpenAI-compatible endpoint serving an open-weights model — the
                  default for SIH (offline-deployable). Qwen2.5-VL / Llama-4-Scout /
                  Gemma-3 via vLLM, Ollama, LM Studio, or cloud hosts (OpenRouter, Groq,
                  Together). Receives the REDACTED, Set-of-Marks screenshot as an image.
                  Env: VLM_BASE_URL, VLM_MODEL, VLM_API_KEY (optional), VLM_IMAGES=1|0
  - "inception" : Inception Labs Mercury 2 (text-only diffusion LLM, OpenAI-compatible)
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
from .plan_prompt import SYSTEM as _PLAN_SYSTEM, build_user_message as _build_plan_message
from .synthesize_prompt import SYSTEM as _SYNTH_SYSTEM, build_user_message as _build_synth_message

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

_PLAN_SCHEMA = json.loads((_ROOT / "server/llm/plan_schema.json").read_text())
_PLAN_SCHEMA = {k: v for k, v in _PLAN_SCHEMA.items() if not k.startswith("$")}  # strip $comment

_SYNTH_SCHEMA = json.loads((_ROOT / "server/llm/synthesize_schema.json").read_text())
_SYNTH_SCHEMA = {k: v for k, v in _SYNTH_SCHEMA.items() if not k.startswith("$")}  # strip $comment

_FORCE_MOCK = os.environ.get("MOCK_LLM", "").lower() in {"1", "true", "yes"}
_PROVIDER = os.environ.get("LLM_PROVIDER", "").lower().strip()

_INCEPTION_KEY = os.environ.get("INCEPTION_API_KEY", "")
_INCEPTION_BASE = os.environ.get("INCEPTION_BASE_URL", "https://api.inceptionlabs.ai/v1")
_INCEPTION_MODEL = os.environ.get("INCEPTION_MODEL", "mercury-2")

_ANTHROPIC_MODEL = os.environ.get("AGENT_MODEL", "claude-opus-5")

_VLM_BASE = os.environ.get("VLM_BASE_URL", "").rstrip("/")
_VLM_MODEL = os.environ.get("VLM_MODEL", "qwen2.5vl:7b")
_VLM_KEY = os.environ.get("VLM_API_KEY", "")
_VLM_IMAGES = os.environ.get("VLM_IMAGES", "1").lower() not in {"0", "false", "no"}

# Slow open-weights VLM endpoints (CPU inference, cold model load, big image payload)
# can take 10-90s for a single step — this is the one knob for both the plain and
# streaming chat calls.
_CHAT_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", "60"))

_ACTION_KEYS = ("type", "targetId", "url", "amount", "text", "ms", "index", "value", "checked", "key", "fields")
_ACTION_TYPES = {
    "click", "scroll", "type", "wait", "extract", "navigate", "open_tab", "switch_tab", "back",
    "select", "check", "hover", "press_key", "fill_form", "remember", "note",
    "save_image", "compile_report",
}


def resolve_provider() -> str:
    if _FORCE_MOCK:
        return "mock"
    if _PROVIDER in {"vlm", "inception", "anthropic", "mock"}:
        return _PROVIDER
    if _VLM_BASE:
        return "vlm"
    if _INCEPTION_KEY:
        return "inception"
    if os.environ.get("ANTHROPIC_API_KEY") or (Path.home() / ".config/anthropic").exists():
        return "anthropic"
    return "mock"


def engine_label() -> str:
    p = resolve_provider()
    return {"vlm": _VLM_MODEL, "inception": _INCEPTION_MODEL, "anthropic": _ANTHROPIC_MODEL, "mock": "mock"}[p]


def provider_info() -> dict:
    p = resolve_provider()
    return {
        "provider": p,
        "engine": engine_label(),
        "seesImages": p == "vlm" and _VLM_IMAGES,
        "openWeights": p in {"vlm", "mock"},
    }


# ------------------------------------------------------------- OpenAI-compatible core
def _extract_json(content: str) -> Any:
    """Models without strict JSON mode sometimes wrap output in prose / code fences."""
    try:
        return json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def _chat_json(base: str, key: str, model: str, system: str, user_text: str, schema_name: str,
               schema: dict, validate, image_b64: str | None = None) -> dict:
    """One OpenAI-compatible chat call constrained to `schema`, one retry-with-correction.
    Falls back from json_schema -> json_object -> plain for servers that lack them."""
    import httpx

    user_content: Any = user_text
    if image_b64:
        user_content = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user_content}]
    formats = [
        {"type": "json_schema", "json_schema": {"name": schema_name, "strict": False, "schema": schema}},
        {"type": "json_object"},
        None,
    ]
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    last_err: Exception | None = None
    with httpx.Client(timeout=_CHAT_TIMEOUT_S) as http:
        fmt_i = 0
        for attempt in range(3):
            body: dict[str, Any] = {"model": model, "temperature": 0, "messages": messages}
            if formats[fmt_i]:
                body["response_format"] = formats[fmt_i]
            r = http.post(f"{base}/chat/completions", headers=headers, json=body)
            if r.status_code == 400 and fmt_i < len(formats) - 1 and "response_format" in r.text:
                fmt_i += 1  # server doesn't support this JSON mode — degrade and retry
                continue
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            try:
                data = _extract_json(content)
                validate(data)
                return data
            except Exception as e:  # retry-with-correction
                last_err = e
                messages = messages[:2] + [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": f"That was invalid ({e}). Return ONLY valid JSON matching the schema."},
                ]
    raise ValueError(f"{model} output failed validation: {last_err}")


def _read_sse_deltas(r):
    """Reads an OpenAI-compatible chat-completions SSE stream (an open httpx streaming
    Response), yielding ('delta', text) for each content fragment as it arrives.
    Returns the full accumulated content via the generator's return value."""
    acc = ""
    for line in r.iter_lines():
        if not line or not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except Exception:
            continue  # a stray keep-alive/comment line — ignore, not fatal
        delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content")
        if delta:
            acc += delta
            yield ("delta", delta)
    return acc


def _chat_json_stream(base: str, key: str, model: str, system: str, user_text: str, schema_name: str,
                      schema: dict, validate, image_b64: str | None = None):
    """Streaming counterpart to _chat_json. Yields ('delta', text) as content tokens
    arrive over SSE, then exactly one of ('done', data) / ('error', message).

    Malformed/invalid streamed output gets ONE non-streaming retry-with-correction
    (via _chat_json) rather than re-streaming the correction turn — that turn is short
    and doesn't need progressive UI feedback, and it reuses _chat_json's existing
    format-degradation logic (json_schema -> json_object -> plain)."""
    import httpx

    user_content: Any = user_text
    if image_b64:
        user_content = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user_content}]
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    body: dict[str, Any] = {
        "model": model,
        "temperature": 0,
        "messages": messages,
        "stream": True,
        "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": False, "schema": schema}},
    }

    content_acc = ""
    try:
        with httpx.Client(timeout=_CHAT_TIMEOUT_S) as http:
            with http.stream("POST", f"{base}/chat/completions", headers=headers, json=body) as r:
                if r.status_code == 400:
                    # server doesn't support response_format + stream together — degrade
                    # to plain streaming (still gets us progressive text) and rely on
                    # _extract_json's prose/fence handling for the final parse.
                    r.close()
                    body.pop("response_format", None)
                    with http.stream("POST", f"{base}/chat/completions", headers=headers, json=body) as r2:
                        r2.raise_for_status()
                        content_acc = yield from _read_sse_deltas(r2)
                else:
                    r.raise_for_status()
                    content_acc = yield from _read_sse_deltas(r)
    except Exception as e:
        yield ("error", f"stream request failed: {e}")
        return

    try:
        data = _extract_json(content_acc)
        validate(data)
        yield ("done", data)
    except Exception as e:
        try:
            data = _chat_json(base, key, model, system, user_text, schema_name, schema, validate, image_b64=image_b64)
            yield ("done", data)
        except Exception as e2:
            yield ("error", f"output failed validation after correction retry: {e2}")


# --------------------------------------------------------------------------- shared
def _normalize_action(a: dict | None) -> dict | None:
    if not a:
        return None
    return {k: a.get(k) for k in _ACTION_KEYS}


def _blank_item(d: dict) -> dict:
    return {k: d.get(k) for k in ("author", "text", "timestamp", "href")}


_ITEM_STR_FIELDS = ("author", "text", "timestamp", "href")
_ITEM_MAX_STR_LEN = 500
_ITEM_MAX_COUNT = 200
_ITEM_MAX_FIELDS = 20


def sanitize_items(raw: Any) -> list[dict]:
    """Normalizes a collection-item list (LLM 'extracted'/'extractedItems' output, or
    client-supplied 'extractedItems' on /agent/synthesize) into a bounded, typed shape.
    This is real server-side validation, not just schema-constrained generation: a
    provider's JSON mode is a strong hint, not a guarantee, and /agent/synthesize's
    items come straight from the client. Malformed entries (wrong type, oversized
    strings/objects, non-scalar field values) are repaired or dropped rather than
    propagated or allowed to 500 the request."""
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw[:_ITEM_MAX_COUNT]:
        if not isinstance(entry, dict):
            continue  # e.g. a bare string/number the model emitted instead of an object
        item: dict[str, Any] = {}
        for k in _ITEM_STR_FIELDS:
            v = entry.get(k)
            if v is None:
                continue
            if not isinstance(v, str):
                v = str(v)
            item[k] = v[:_ITEM_MAX_STR_LEN]
        fields = entry.get("fields")
        if isinstance(fields, dict):
            clean: dict[str, Any] = {}
            for k, v in list(fields.items())[:_ITEM_MAX_FIELDS]:
                if not isinstance(k, str) or not k:
                    continue
                if isinstance(v, str):
                    v = v[:_ITEM_MAX_STR_LEN]
                elif not isinstance(v, (int, float, bool)) and v is not None:
                    v = str(v)[:_ITEM_MAX_STR_LEN]  # e.g. a nested list/object — flatten to text
                clean[k[:80]] = v
            if clean:
                item["fields"] = clean
        if item:
            out.append(item)
    return out


def _validate(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("not an object")
    if data.get("status") not in {"action", "done"}:
        raise ValueError("bad status")
    if data["status"] == "action":
        a = data.get("action") or {}
        if a.get("type") not in _ACTION_TYPES:
            raise ValueError("bad action.type")
        if a["type"] in {"click", "type", "select", "check"} and not a.get("targetId"):
            raise ValueError(f"{a['type']} needs targetId")
        if a["type"] in {"navigate", "open_tab"} and not a.get("url"):
            raise ValueError(f"{a['type']} needs url")
        if a["type"] == "press_key" and not a.get("key"):
            raise ValueError("press_key needs key")
        if a["type"] == "fill_form" and not a.get("fields"):
            raise ValueError("fill_form needs fields")
        # remember has no dedicated schema fields — it repurposes targetId as the memory
        # key and text as the value, since those already exist and it's client-side only.
        if a["type"] == "remember" and not (a.get("targetId") and a.get("text")):
            raise ValueError("remember needs targetId (key) and text (value)")
        # note is remember's ephemeral, this-task-only sibling — same field reuse, but
        # targetId (an optional short label) is not required, only text.
        if a["type"] == "note" and not a.get("text"):
            raise ValueError("note needs text")
        # save_image repurposes targetId as the image node to download; text (a caption
        # explaining why it's notable) is optional, since not every save needs one.
        if a["type"] == "save_image" and not a.get("targetId"):
            raise ValueError("save_image needs targetId")
        # compile_report has no dedicated schema fields either — it repurposes text as
        # the report's title/closing summary; no targetId, since it bundles prior work,
        # not one page element.
        if a["type"] == "compile_report" and not a.get("text"):
            raise ValueError("compile_report needs text")
    if data["status"] == "done" and not data.get("answer"):
        raise ValueError("done needs answer")


def _finalize(data: dict) -> dict:
    data["action"] = _normalize_action(data.get("action"))
    data["extracted"] = sanitize_items(data.get("extracted") or [])
    data["extractedItems"] = sanitize_items(data.get("extractedItems") or [])
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
    data = _chat_json(_INCEPTION_BASE, _INCEPTION_KEY, _INCEPTION_MODEL, SYSTEM, build_user_message(req),
                      "agent_step", _SCHEMA, _validate)
    return _finalize(data)


def _inception_step_stream(req: dict):
    yield from _chat_json_stream(_INCEPTION_BASE, _INCEPTION_KEY, _INCEPTION_MODEL, SYSTEM, build_user_message(req),
                                 "agent_step", _SCHEMA, _validate)


# ---------------------------------------------------------------- open-weights VLM
def _vlm_step(req: dict) -> dict:
    image = req.get("redactedScreenshot") if (_VLM_IMAGES and req.get("sendScreenshot")) else None
    data = _chat_json(_VLM_BASE, _VLM_KEY, _VLM_MODEL, SYSTEM, build_user_message(req, has_image=bool(image)),
                      "agent_step", _SCHEMA, _validate, image_b64=image)
    return _finalize(data)


def _vlm_step_stream(req: dict):
    image = req.get("redactedScreenshot") if (_VLM_IMAGES and req.get("sendScreenshot")) else None
    yield from _chat_json_stream(_VLM_BASE, _VLM_KEY, _VLM_MODEL, SYSTEM, build_user_message(req, has_image=bool(image)),
                                 "agent_step", _SCHEMA, _validate, image_b64=image)


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


def _anthropic_step_stream(req: dict):
    import anthropic

    client = anthropic.Anthropic()
    user_msg = build_user_message(req)
    try:
        with client.messages.stream(
            model=_ANTHROPIC_MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": user_msg}],
        ) as stream:
            for text in stream.text_stream:
                yield ("delta", text)
            final = stream.get_final_message()
        raw = next(b.text for b in final.content if b.type == "text")
        data = json.loads(raw)
        _validate(data)
        yield ("done", data)
    except Exception as e:
        yield ("error", str(e))


# ------------------------------------------------------------------------- public
_STEP_FNS = {"vlm": _vlm_step, "inception": _inception_step, "anthropic": _anthropic_step, "mock": mock_step}
_STEP_STREAM_FNS = {"vlm": _vlm_step_stream, "inception": _inception_step_stream, "anthropic": _anthropic_step_stream}


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


def stream_step(req: dict):
    """Streaming counterpart to decide_step. Yields (kind, payload) tuples:
      - ('status', {...})       phase markers, at least one 'waiting_for_model' first
      - ('delta', str)          a fragment of the model's raw output, as it arrives
      - ('done', dict)          the same shape decide_step returns on success (finalized)
      - ('error', str)          a message; the caller shapes it into the same
                                 {"status":"error", code, message} contract decide_step
                                 produces, so a streamed and non-streamed call always end
                                 up looking identical to downstream consumers.
    Always ends in exactly one 'done' or 'error'."""
    provider = resolve_provider()
    yield ("status", {"phase": "waiting_for_model", "provider": provider, "engine": "mock" if provider == "mock" else engine_label()})
    if provider == "mock":
        # No network round-trip to narrate, but keep the same event shape so the
        # extension's stream consumer is exercised even fully offline (MOCK_LLM=1).
        data = mock_step(req)
        if data.get("reasoning"):
            yield ("delta", data["reasoning"])
        yield ("done", data)
        return
    stream_fn = _STEP_STREAM_FNS.get(provider)
    if not stream_fn:
        yield ("error", f"provider '{provider}' has no streaming support")
        return
    try:
        final = None
        for kind, payload in stream_fn(req):
            if kind == "delta":
                yield ("delta", payload)
            elif kind == "error":
                yield ("error", payload)
                return
            elif kind == "done":
                final = payload
        if final is None:
            yield ("error", "stream ended with no result")
        else:
            yield ("done", _finalize(final))
    except Exception as e:
        yield ("error", str(e))


# --------------------------------------------------------------------------- planning
def _validate_plan(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("not an object")
    subtasks = data.get("subtasks")
    if not isinstance(subtasks, list) or not subtasks or len(subtasks) > 5:
        raise ValueError("bad subtasks")
    for s in subtasks:
        if not isinstance(s, dict) or not s.get("id") or not s.get("goal"):
            raise ValueError("subtask needs id + goal")


def mock_plan(req: dict) -> dict:
    return {
        "subtasks": [{"id": "sub_1", "goal": req.get("prompt", ""), "startUrl": None}],
        "reasoning": "mock planner: single subtask",
    }


def _inception_plan(req: dict) -> dict:
    return _chat_json(_INCEPTION_BASE, _INCEPTION_KEY, _INCEPTION_MODEL, _PLAN_SYSTEM, _build_plan_message(req),
                      "agent_plan", _PLAN_SCHEMA, _validate_plan)


def _vlm_plan(req: dict) -> dict:
    return _chat_json(_VLM_BASE, _VLM_KEY, _VLM_MODEL, _PLAN_SYSTEM, _build_plan_message(req),
                      "agent_plan", _PLAN_SCHEMA, _validate_plan)


def _anthropic_plan(req: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": _build_plan_message(req)}]

    last_err = None
    for _ in range(2):
        resp = client.messages.create(
            model=_ANTHROPIC_MODEL,
            max_tokens=4000,
            system=_PLAN_SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _PLAN_SCHEMA}},
            messages=messages,
        )
        raw = next(b.text for b in resp.content if b.type == "text")
        try:
            data = json.loads(raw)
            _validate_plan(data)
            return data
        except Exception as e:
            last_err = e
            messages = [
                {"role": "user", "content": _build_plan_message(req)
                 + f"\n\n(Previous reply invalid: {e}. Return valid JSON matching the schema.)"}
            ]
    raise ValueError(f"LLM output failed validation twice: {last_err}")


_PLAN_FNS = {"vlm": _vlm_plan, "inception": _inception_plan, "anthropic": _anthropic_plan, "mock": mock_plan}


def decide_plan(req: dict) -> tuple[dict, str]:
    """Returns (response_dict, engine) where engine is the model id or 'mock'/'error'."""
    provider = resolve_provider()
    if provider == "mock":
        return mock_plan(req), "mock"
    try:
        return _PLAN_FNS[provider](req), engine_label()
    except Exception as e:
        msg = str(e)
        code = "llm_malformed" if "validation" in msg or "schema" in msg else "llm_unavailable"
        return {"status": "error", "code": code, "message": msg[:300]}, "error"


# ------------------------------------------------------------------------- synthesis
def _validate_synthesize(data: Any) -> None:
    if not isinstance(data, dict):
        raise ValueError("not an object")
    if not data.get("answer"):
        raise ValueError("synthesize needs answer")


def _item_line(it: dict) -> str:
    label = it.get("author") or it.get("text") or ""
    bits = [str(v) for v in (it.get("fields") or {}).values() if v not in (None, "")]
    return " — ".join(p for p in (label, ", ".join(bits)) if p)


def _local_concat(req: dict) -> str:
    # Mirrors extension/background.js's localSynthesize fallback so mock mode is
    # consistent whichever side does it. Falling back to text concatenation used to
    # silently drop structured extractedItems when a sub-agent had no prose answer
    # (e.g. a pure collection task) — list them explicitly instead.
    parts = []
    for r in req.get("subAgentResults") or []:
        goal = r.get("goal", "")
        answer = r.get("answer") or f"(failed: {r.get('error') or 'unknown error'})"
        parts.append(f"## {goal}\n{answer}\n")
        lines = [f"- {_item_line(it)}" for it in sanitize_items(r.get("extractedItems") or [])[:20] if _item_line(it)]
        if lines:
            parts.append("\n".join(lines) + "\n")
    return "\n".join(parts)


def mock_synthesize(req: dict) -> dict:
    return {"answer": _local_concat(req)}


def _inception_synthesize(req: dict) -> dict:
    return _chat_json(_INCEPTION_BASE, _INCEPTION_KEY, _INCEPTION_MODEL, _SYNTH_SYSTEM, _build_synth_message(req),
                      "agent_synthesize", _SYNTH_SCHEMA, _validate_synthesize)


def _vlm_synthesize(req: dict) -> dict:
    return _chat_json(_VLM_BASE, _VLM_KEY, _VLM_MODEL, _SYNTH_SYSTEM, _build_synth_message(req),
                      "agent_synthesize", _SYNTH_SCHEMA, _validate_synthesize)


def _anthropic_synthesize(req: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": _build_synth_message(req)}]

    last_err = None
    for _ in range(2):
        resp = client.messages.create(
            model=_ANTHROPIC_MODEL,
            max_tokens=4000,
            system=_SYNTH_SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SYNTH_SCHEMA}},
            messages=messages,
        )
        raw = next(b.text for b in resp.content if b.type == "text")
        try:
            data = json.loads(raw)
            _validate_synthesize(data)
            return data
        except Exception as e:
            last_err = e
            messages = [
                {"role": "user", "content": _build_synth_message(req)
                 + f"\n\n(Previous reply invalid: {e}. Return valid JSON matching the schema.)"}
            ]
    raise ValueError(f"LLM output failed validation twice: {last_err}")


_SYNTH_FNS = {"vlm": _vlm_synthesize, "inception": _inception_synthesize, "anthropic": _anthropic_synthesize, "mock": mock_synthesize}


def decide_synthesize(req: dict) -> tuple[dict, str]:
    """Returns (response_dict, engine) where engine is the model id or 'mock'/'error'."""
    provider = resolve_provider()
    if provider == "mock":
        return mock_synthesize(req), "mock"
    try:
        return _SYNTH_FNS[provider](req), engine_label()
    except Exception as e:
        msg = str(e)
        code = "llm_malformed" if "validation" in msg or "schema" in msg else "llm_unavailable"
        return {"status": "error", "code": code, "message": msg[:300]}, "error"
