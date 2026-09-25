"""POST /agent/synthesize — combines multiple sub-agents' results into one final answer."""

from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from server.llm.client import decide_synthesize, mock_synthesize, sanitize_items

router = APIRouter()


class SubAgentResult(BaseModel):
    goal: str
    answer: Optional[str] = None
    extractedItems: list = []
    error: Optional[str] = None


class SynthesizeRequest(BaseModel):
    originalPrompt: str
    subAgentResults: list[SubAgentResult]


@router.post("/agent/synthesize")
def agent_synthesize(req: SynthesizeRequest) -> dict:
    t0 = time.perf_counter()
    payload = req.model_dump()
    # subAgentResults[].extractedItems comes straight from the client (each sub-agent's
    # accumulated data), not from an LLM — sanitize it the same way agent_step does its
    # own LLM output, so a malformed/oversized item can't reach the synthesis prompt.
    for r in payload.get("subAgentResults") or []:
        r["extractedItems"] = sanitize_items(r.get("extractedItems") or [])

    decision, engine = decide_synthesize(payload)

    # Synthesis is best-effort — never hard-fail the whole task because the LLM choked.
    # Degrade to the same concatenation shape the mock synthesizer (and the extension's
    # own local fallback) would produce.
    if decision.get("status") == "error" or not decision.get("answer"):
        decision = mock_synthesize(payload)
        engine = "mock"

    out = {"answer": decision.get("answer", "")}
    out["_debug"] = {
        "engine": engine,
        "serverMs": round((time.perf_counter() - t0) * 1000),
    }
    return out
