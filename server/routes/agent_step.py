"""POST /agent/step — see docs/api-contract.md."""

from __future__ import annotations

import time
from typing import Any, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from server.llm.client import decide_step
from server.redaction_qa.server_side_regex_check import check_and_repair

router = APIRouter()

# In-process QA counters (dev-time metrics; not persisted).
QA_STATS = {"requests": 0, "leak_catch_events": 0, "leaked_spans": 0}


class Rect(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0


class Node(BaseModel):
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
    sendScreenshot: bool = False
    redactedScreenshot: Optional[str] = None
    sanitizedDom: list[Node] = Field(default_factory=list)
    accumulatedData: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/agent/step")
def agent_step(req: StepRequest) -> dict:
    t0 = time.perf_counter()
    QA_STATS["requests"] += 1

    # 1. Server-side redaction QA (defense in depth) — repair, don't reject.
    dom_dicts = [n.model_dump() for n in req.sanitizedDom]
    qa = check_and_repair(dom_dicts)
    if qa.leak_count:
        QA_STATS["leak_catch_events"] += 1
        QA_STATS["leaked_spans"] += qa.leak_count

    # 2. Hand the repaired context to the step decider.
    llm_input = req.model_dump()
    llm_input["sanitizedDom"] = qa.sanitized_dom
    decision, engine = decide_step(llm_input)

    # 3. Shape the response per the contract.
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


@router.get("/agent/qa-stats")
def qa_stats() -> dict:
    reqs = QA_STATS["requests"] or 1
    return {
        **QA_STATS,
        "leak_catch_rate": round(QA_STATS["leak_catch_events"] / reqs, 4),
    }
