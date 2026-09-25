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

from server.middleware import BodySizeLimitMiddleware, RateLimitMiddleware, SecurityHeadersMiddleware
from server.routes.agent_step import router as agent_router
from server.routes.agent_plan import router as agent_plan_router
from server.routes.agent_synthesize import router as agent_synthesize_router
from server.routes.audit_view import router as audit_view_router

app = FastAPI(title="Aavaran — privacy-aware agent server", version="0.2.0")

# Middlewares run outermost-first on the way in; added innermost-first below so CORS
# (which must see every response, including 413/429s, to attach its headers) ends up
# outermost. See server/middleware.py for the size cap and rate limiter themselves.
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

# The extension calls this server from a chrome-extension://<32-char-id> origin (the id
# is assigned per install/build, so it can't be pinned to one value); localhost/127.0.0.1
# is allowed too for local tooling (curl, the audit viewer, eval scripts) that runs from
# a browser context. No credentials are used, so allow_credentials stays off.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$|^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

app.include_router(agent_router)
app.include_router(agent_plan_router)
app.include_router(agent_synthesize_router)
app.include_router(audit_view_router)

# Synthetic demo sites (bank KYC, webmail, social feed, checkout, registration form).
# Every PII element carries data-pii / data-face ground-truth labels used by eval/.
app.mount("/demo", StaticFiles(directory=Path(__file__).parent / "demo", html=True), name="demo")


@app.get("/health")
def health() -> dict:
    from server.llm.client import provider_info

    return {"ok": True, **provider_info()}
