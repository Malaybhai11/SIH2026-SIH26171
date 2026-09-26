"""POST /agent/step — see docs/api-contract.md."""

from __future__ import annotations

import time
from typing import Any, Literal, Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from server.audit.store import RECENT, record_request
from server.llm.client import decide_step, engine_label, resolve_provider, stream_step
from server.redaction_qa.server_side_regex_check import check_and_repair, scrub_text, scrub_tree

router = APIRouter()

# In-process QA counters (dev-time metrics; not persisted).
QA_STATS = {"requests": 0, "leak_catch_events": 0, "leaked_spans": 0}


class Rect(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0


class Node(BaseModel):
    # keep select options / values / checked / src etc. — they are part of the contract
    model_config = ConfigDict(extra="allow")

    id: str
    role: str = "generic"
    text: str = ""
    rect: Rect = Field(default_factory=Rect)
    interactive: bool = False
    author: Optional[str] = None
    timestamp: Optional[str] = None
    href: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


class StepRequest(BaseModel):
    contractVersion: int = 1
    taskId: str
    prompt: str
    iteration: int = 1
    maxIterations: int = 6
    screenState: str = "unknown"
    screenStateConfidence: float = 0.5
    siteConfigId: str = "generic"
    currentUrl: Optional[str] = None
    openTabs: list[dict[str, Any]] = Field(default_factory=list)
    pageMeta: dict[str, Any] = Field(default_factory=dict)
    sendScreenshot: bool = False
    redactedScreenshot: Optional[str] = None
    sanitizedDom: list[Node] = Field(default_factory=list)
    accumulatedData: list[dict[str, Any]] = Field(default_factory=list)
    memoryFacts: list[Any] = Field(default_factory=list)
    lastActionResult: Optional[dict[str, Any]] = None
    visualContext: dict[str, Any] = Field(default_factory=dict)
    redactionScheme: dict[str, Any] = Field(default_factory=dict)


def _prepare_llm_input(req: StepRequest) -> tuple[dict, Any]:
    """Server-side redaction QA (defense in depth) — repair, don't reject — over every
    string field the client sends, plus toasts. Shared by the sync and streaming routes
    so both get identical privacy guarantees."""
    QA_STATS["requests"] += 1
    record_request(req.model_dump())

    dom_dicts = [n.model_dump() for n in req.sanitizedDom]
    qa = check_and_repair(dom_dicts)
    if qa.leak_count:
        QA_STATS["leak_catch_events"] += 1
        QA_STATS["leaked_spans"] += qa.leak_count

    llm_input = req.model_dump()
    llm_input["sanitizedDom"] = qa.sanitized_dom
    for fld in ("prompt", "openTabs", "accumulatedData", "memoryFacts", "currentUrl", "lastActionResult"):
        repaired, hits = scrub_tree(llm_input.get(fld))
        if hits:
            QA_STATS["leak_catch_events"] += 1
            QA_STATS["leaked_spans"] += sum(hits.values())
            qa.leak_count += sum(hits.values())
            for k, v in hits.items():
                qa.leaks_by_type[k] = qa.leaks_by_type.get(k, 0) + v
        llm_input[fld] = repaired

    if isinstance(llm_input.get("pageMeta"), dict) and "toasts" in llm_input["pageMeta"]:
        toasts = llm_input["pageMeta"].get("toasts")
        if isinstance(toasts, list):
            clean_toasts = []
            for t in toasts:
                if isinstance(t, str):
                    repaired, hits = scrub_text(t)
                    if hits:
                        QA_STATS["leak_catch_events"] += 1
                        QA_STATS["leaked_spans"] += sum(hits.values())
                    clean_toasts.append(repaired)
            llm_input["pageMeta"]["toasts"] = clean_toasts

    return llm_input, qa


def _shape_response(decision: dict, engine: str, qa: Any, t0: float) -> dict:
    """Shapes a decide_step()/stream_step() result into the wire contract. Used by both
    /agent/step and /agent/step/stream so a streamed call's final event is byte-for-byte
    the same JSON shape a non-streamed call returns — existing callers that only ever
    look at the final JSON (eval scripts, the extension's non-streaming path) keep working
    unchanged either way."""
    if decision.get("status") == "error":
        out = decision
    elif decision.get("status") == "done":
        out = {
            "status": "done",
            "answer": decision.get("answer") or "(no answer)",
            "extractedItems": decision.get("extractedItems") or [],
            "reasoning": decision.get("reasoning", ""),
        }
    else:
        out = {
            "status": "action",
            "action": decision.get("action"),
            "extracted": decision.get("extracted") or [],
            "reasoning": decision.get("reasoning", ""),
        }

    out["_debug"] = {
        "engine": engine,
        "serverMs": round((time.perf_counter() - t0) * 1000),
        "leakCatch": {
            "count": qa.leak_count,
            "byType": qa.leaks_by_type,
            "elementIds": qa.leaked_element_ids,
        },
    }
    return out


@router.post("/agent/step")
def agent_step(req: StepRequest) -> dict:
    t0 = time.perf_counter()
    llm_input, qa = _prepare_llm_input(req)
    decision, engine = decide_step(llm_input)
    return _shape_response(decision, engine, qa, t0)


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/agent/step/stream")
def agent_step_stream(req: StepRequest) -> StreamingResponse:
    """Server-Sent Events variant of /agent/step, for a provider call slow enough
    (10-90s for an open-weights VLM) that a blank-waiting popup is a bad experience.
    Same request body and the same server-side redaction QA as /agent/step. Events:
      status  {"phase": "received" | "waiting_for_model", ...}
      delta   {"text": "..."}                 a fragment of the model's raw output
      result  <the exact /agent/step response body>   always the last event
      error   {"message": "..."}               a transport/stream-level failure
    `result` is the contract other code should parse — `status`/`delta` are UI-only
    progress hints and may be skipped entirely (e.g. by LLM_PROVIDER=mock, which still
    emits them, or by a client that just reads the stream to its end)."""
    t0 = time.perf_counter()
    llm_input, qa = _prepare_llm_input(req)
    provider = resolve_provider()

    def gen():
        yield _sse("status", {"phase": "received"})
        try:
            for kind, payload in stream_step(llm_input):
                if kind == "status":
                    yield _sse("status", payload)
                elif kind == "delta":
                    if payload:
                        yield _sse("delta", {"text": payload})
                elif kind == "done":
                    engine = "mock" if provider == "mock" else engine_label()
                    yield _sse("result", _shape_response(payload, engine, qa, t0))
                elif kind == "error":
                    msg = str(payload)
                    code = "llm_malformed" if ("validation" in msg or "schema" in msg) else "llm_unavailable"
                    decision = {"status": "error", "code": code, "message": msg[:300]}
                    yield _sse("result", _shape_response(decision, "error", qa, t0))
        except Exception as e:  # belt-and-suspenders — never let the generator crash silently
            yield _sse("error", {"message": str(e)[:300]})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/agent/qa-stats")
def qa_stats() -> dict:
    reqs = QA_STATS["requests"] or 1
    return {
        **QA_STATS,
        "leak_catch_rate": round(QA_STATS["leak_catch_events"] / reqs, 4),
    }


@router.get("/agent/last-received")
def last_received(n: int = 1, image: bool = False) -> list:
    """What the server actually received on the last n steps (the 'server view')."""
    out = list(RECENT)[-n:]
    return [{k: v for k, v in e.items() if image or k != "_image"} for e in out]
