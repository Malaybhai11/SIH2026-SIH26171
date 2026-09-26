"""ASGI hardening: request-size cap, in-memory rate limiting, baseline security headers.

Hackathon-scale on purpose: no Redis or other external dependency, just enough that a
stray or hostile client can't exhaust server memory with an oversized body, hammer the
LLM-calling endpoints, or receive a response missing basic browser security headers.
"""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque

from starlette.types import ASGIApp, Receive, Scope, Send

# Redacted screenshots are base64 JPEGs (<=1280px wide) plus a DOM snapshot — a few
# hundred KB in the normal case. 8MB leaves headroom without letting one request hold
# an unbounded amount of memory.
MAX_BODY_BYTES = int(os.environ.get("AAVARAN_MAX_BODY_BYTES", 8_000_000))

# Paced client loop (~1 request/sec/task per the extension's step loop); this is
# generous enough not to trip eval harnesses while still bounding a runaway client.
RATE_LIMIT_PER_MIN = int(os.environ.get("AAVARAN_RATE_LIMIT_PER_MIN", 120))
RATE_LIMIT_WINDOW_S = 60.0
RATE_LIMITED_ROUTES = {("POST", "/agent/step"), ("POST", "/agent/plan"), ("POST", "/agent/synthesize")}


async def _reject(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


class BodySizeLimitMiddleware:
    """Rejects oversized bodies up front via Content-Length, and, for a client that
    lies about (or omits) that header, drains the body itself up to the cap before
    ever handing control to the app.

    This owns the 413 decision start to finish rather than raising an exception mid
    -stream through the inner app: FastAPI's own request-body parsing wraps
    `await request.json()` in a bare `except Exception` (it turns any failure there,
    including a custom exception raised from a wrapped `receive`, into its own generic
    400 "there was an error parsing the body") — a raise-through-receive approach would
    silently degrade to that far less useful response instead of a clean 413.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_bytes:
                    await _reject(send, 413, "request body too large")
                    return
            except ValueError:
                pass

        buffered: list[dict] = []
        seen = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break
            seen += len(message.get("body") or b"")
            if seen > self.max_bytes:
                await _reject(send, 413, "request body too large")
                return
            if not message.get("more_body", False):
                break

        async def replay_receive():
            if buffered:
                return buffered.pop(0)
            return await receive()

        await self.app(scope, replay_receive, send)


class RateLimitMiddleware:
    """Sliding-window limiter per client IP, applied only to the LLM-calling POST
    routes — cheap GETs (/health, /agent/qa-stats, /agent/last-received, /demo/*,
    /audit/*) are exempt."""

    def __init__(self, app: ASGIApp, limit_per_min: int = RATE_LIMIT_PER_MIN, window_s: float = RATE_LIMIT_WINDOW_S) -> None:
        self.app = app
        self.limit = limit_per_min
        self.window = window_s
        self._hits: dict[str, deque] = defaultdict(deque)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or (scope.get("method"), scope.get("path")) not in RATE_LIMITED_ROUTES:
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        key = client[0] if client else "unknown"
        now = time.monotonic()
        hits = self._hits[key]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            await _reject(send, 429, "rate limit exceeded, slow down")
            return
        hits.append(now)
        await self.app(scope, receive, send)


class SecurityHeadersMiddleware:
    """Baseline headers for a server that only ever returns JSON or its own demo HTML
    (never embeds or is embedded by third-party content)."""

    _HEADERS = [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"no-referrer"),
    ]

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                headers.extend(self._HEADERS)
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)
