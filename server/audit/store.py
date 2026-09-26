"""Server-side audit trail of exactly what arrived (AUDIT_LOG=1).

Only ever holds already-tokenized data: by the API contract, sanitizedDom/prompt carry
[TYPE_n] pseudonyms, not raw values, before they ever leave the extension, and this is
the server's own record of that received payload (redactedScreenshot is logged as
size+hash; the actual JPEG bytes are only written to disk when AUDIT_IMAGES=1, and it
is the redacted image the extension sent — the server never sees a raw one).

Bounded so a long demo day can't fill the disk: the jsonl rotates past AUDIT_MAX_BYTES
(one backup kept) and stored images are capped at AUDIT_MAX_IMAGES, oldest evicted
first. Image filenames are the server's own sha256 hexdigest, never client input, so
there is no path-traversal surface here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from collections import deque
from pathlib import Path

AUDIT = os.environ.get("AUDIT_LOG", "").lower() in {"1", "true", "yes"}
AUDIT_IMAGES = os.environ.get("AUDIT_IMAGES", "").lower() in {"1", "true", "yes"}
AUDIT_DIR = Path(__file__).resolve().parent
LOG_NAME = "requests.jsonl"
MAX_BYTES = int(os.environ.get("AUDIT_MAX_BYTES", 20_000_000))
MAX_IMAGES = int(os.environ.get("AUDIT_MAX_IMAGES", 500))

# In-process "what did the server just receive" cache backing GET /agent/last-received;
# resets on restart, unlike the jsonl file.
RECENT: deque = deque(maxlen=20)


def _rotate_if_needed() -> None:
    p = AUDIT_DIR / LOG_NAME
    try:
        if p.exists() and p.stat().st_size > MAX_BYTES:
            backup = AUDIT_DIR / f"{LOG_NAME}.1"
            backup.unlink(missing_ok=True)
            p.rename(backup)
    except OSError:
        pass  # audit logging must never take the request down with it


def _evict_old_images() -> None:
    try:
        imgs = sorted(AUDIT_DIR.glob("*.jpg"), key=lambda f: f.stat().st_mtime)
    except OSError:
        return
    while len(imgs) >= MAX_IMAGES:
        imgs.pop(0).unlink(missing_ok=True)


def record_request(raw: dict) -> dict:
    """Records one /agent/step request. Returns the (already-redacted) entry logged."""
    entry = {k: v for k, v in raw.items() if k != "redactedScreenshot"}
    img = raw.get("redactedScreenshot")
    if img:
        entry["redactedScreenshot"] = {
            "bytes": len(img) * 3 // 4,
            "sha256": hashlib.sha256(img.encode()).hexdigest()[:16],
        }
    entry["_receivedAt"] = time.time()
    RECENT.append({**entry, "_image": img if AUDIT_IMAGES else None})
    if not AUDIT:
        return entry

    AUDIT_DIR.mkdir(exist_ok=True)
    _rotate_if_needed()
    with open(AUDIT_DIR / LOG_NAME, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    if img and AUDIT_IMAGES:
        sha = entry["redactedScreenshot"]["sha256"]
        try:
            (AUDIT_DIR / f"{sha}.jpg").write_bytes(base64.b64decode(img, validate=True))
            _evict_old_images()
        except (ValueError, OSError):
            pass  # malformed base64 from a buggy/hostile client — drop, don't crash the request
    return entry


def tail_entries(n: int = 100) -> list[dict]:
    """Last n entries from the persisted log, oldest-first (empty if AUDIT_LOG is off
    or nothing has been logged yet)."""
    p = AUDIT_DIR / LOG_NAME
    if not p.exists():
        return []
    buf: deque = deque(maxlen=n)
    with open(p, "r") as f:
        for line in f:
            buf.append(line)
    out = []
    for line in buf:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def image_path(sha256_prefix: str) -> Path | None:
    """Resolves a logged image's sha to its file, or None if absent/malformed — the
    input is attacker-controlled (comes off the URL), so it's validated as a bare hex
    string before ever touching the filesystem."""
    if not sha256_prefix or len(sha256_prefix) != 16 or not all(c in "0123456789abcdef" for c in sha256_prefix):
        return None
    p = AUDIT_DIR / f"{sha256_prefix}.jpg"
    if not p.is_file():
        return None
    return p
