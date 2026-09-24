"""POST /agent/plan — decomposes a task into 1-5 independent sub-goals before any browsing starts."""

from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from server.llm.client import decide_plan, mock_plan

router = APIRouter()


class PlanRequest(BaseModel):
    prompt: str
    currentUrl: Optional[str] = None


@router.post("/agent/plan")
def agent_plan(req: PlanRequest) -> dict:
    t0 = time.perf_counter()

    decision, engine = decide_plan(req.model_dump())

    # Planning is best-effort — never hard-fail the whole task because the LLM choked.
    # Degrade to the same single-subtask shape mock_plan produces.
    if decision.get("status") == "error" or not decision.get("subtasks"):
        decision = mock_plan(req.model_dump())
        engine = "mock"

    out = {
        "subtasks": decision.get("subtasks")[:5],  # belt-and-suspenders past the schema cap
        "reasoning": decision.get("reasoning", ""),
    }
    out["_debug"] = {
        "engine": engine,
        "serverMs": round((time.perf_counter() - t0) * 1000),
    }
    return out
