"""FastAPI entrypoint.

    pip install -r requirements.txt
    uvicorn server.app:app --reload --port 8000

Runs fully offline: without ANTHROPIC_API_KEY (or with MOCK_LLM=1) the step decider
falls back to a deterministic mock stepper.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.routes.agent_step import router as agent_router

app = FastAPI(title="Privacy-Preserving Browser Agent — step server", version="0.1.0")

# The extension calls from a chrome-extension:// origin; allow all for the demo.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router)


@app.get("/health")
def health() -> dict:
    from server.llm.client import _FORCE_MOCK, _MODEL

    engine = "mock" if (_FORCE_MOCK or not os.environ.get("ANTHROPIC_API_KEY")) else _MODEL
    return {"ok": True, "engine": engine}
