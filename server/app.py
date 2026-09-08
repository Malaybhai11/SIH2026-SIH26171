"""FastAPI entrypoint.

    pip install -r requirements.txt
    uvicorn server.app:app --reload --port 8000

Provider is chosen by LLM_PROVIDER (inception | anthropic | mock) or auto-detected
from whichever key is present. With no key (or MOCK_LLM=1) it runs a deterministic
mock stepper, fully offline. Config is read from a gitignored .env at the repo root.
"""

from __future__ import annotations

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
    from server.llm.client import resolve_provider, engine_label

    return {"ok": True, "provider": resolve_provider(), "engine": engine_label()}
