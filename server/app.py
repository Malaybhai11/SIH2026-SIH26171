"""FastAPI entrypoint.

    pip install -r requirements.txt
    uvicorn server.app:app --reload --port 8000

Provider is chosen by LLM_PROVIDER (inception | anthropic | mock) or auto-detected
from whichever key is present. With no key (or MOCK_LLM=1) it runs a deterministic
mock stepper, fully offline. Config is read from a gitignored .env at the repo root.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.routes.agent_step import router as agent_router
from server.routes.agent_plan import router as agent_plan_router
from server.routes.agent_synthesize import router as agent_synthesize_router

app = FastAPI(title="Aavaran — privacy-aware agent server", version="0.2.0")

# The extension calls from a chrome-extension:// origin; allow all for the demo.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router)
app.include_router(agent_plan_router)
app.include_router(agent_synthesize_router)

# Synthetic demo sites (bank KYC, webmail, social feed, checkout, registration form).
# Every PII element carries data-pii / data-face ground-truth labels used by eval/.
app.mount("/demo", StaticFiles(directory=Path(__file__).parent / "demo", html=True), name="demo")


@app.get("/health")
def health() -> dict:
    from server.llm.client import provider_info

    return {"ok": True, **provider_info()}
