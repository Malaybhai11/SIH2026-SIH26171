"""GET /audit/view — read-only browser for the server's own audit trail.

Deliberately dumb: server-rendered HTML, no JS framework, no new frontend build step.
Off by default (404s) unless AUDIT_LOG=1 was explicitly opted into for this run, so a
real deployment doesn't grow an unauthenticated data-browsing endpoint by accident —
if there is nothing to audit there is nothing to view. What it shows is exactly what
requests.jsonl holds: already-tokenized fields per the API contract, never raw values;
the "leakCatch" column re-runs the same server-side regex QA
(server/redaction_qa/server_side_regex_check.py) live over each stored entry so a
genuine miss would show up here too, not just in /agent/qa-stats. A thumbnail, when
shown, is the exact redacted JPEG the extension sent (only ever written when
AUDIT_IMAGES=1) — never a raw screenshot, since the server never receives one.
"""

from __future__ import annotations

import html
import time

from fastapi import APIRouter, Response

from server.audit import store
from server.redaction_qa.server_side_regex_check import check_and_repair, scrub_text

router = APIRouter(prefix="/audit", tags=["audit"])


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""))


def _repair_entry(entry: dict) -> tuple[str, int, dict]:
    """Re-runs the same server-side regex QA the live request path uses, and returns
    the REPAIRED prompt text (never the raw stored one) plus leak counts.

    requests.jsonl deliberately logs the payload exactly as it arrived (that's what
    lets this QA layer be verified from the outside) — which means a client-side
    redaction bug can, in principle, leave a raw value sitting in the log. This page
    must not become a second leak surface for that case, so it never echoes a stored
    string verbatim; every string it renders goes through scrub_text/check_and_repair
    first, the same as the live /agent/step path does before the LLM ever sees it."""
    total = 0
    by_type: dict[str, int] = {}

    dom = entry.get("sanitizedDom")
    if isinstance(dom, list):
        qa = check_and_repair(dom)
        total += qa.leak_count
        for k, v in qa.leaks_by_type.items():
            by_type[k] = by_type.get(k, 0) + v

    prompt_repaired, hits = scrub_text(entry.get("prompt") or "")
    total += sum(hits.values())
    for k, v in hits.items():
        by_type[k] = by_type.get(k, 0) + v

    return prompt_repaired, total, by_type


@router.get("/view", response_class=Response)
def view(n: int = 100) -> Response:
    if not store.AUDIT:
        return Response(
            "<p>Audit logging is off for this run (start the server with AUDIT_LOG=1 to use this page).</p>",
            media_type="text/html",
            status_code=404,
        )

    n = max(1, min(n, 500))
    entries = list(reversed(store.tail_entries(n)))

    rows = []
    for e in entries:
        ts = e.get("_receivedAt")
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "?"
        prompt_repaired, leak_total, leak_by_type = _repair_entry(e)
        prompt = prompt_repaired[:160]
        shot = e.get("redactedScreenshot") or {}
        sha = shot.get("sha256", "")
        thumb = ""
        if sha and store.image_path(sha):
            thumb = f'<img src="/audit/view/image/{_esc(sha)}.jpg" width="120" loading="lazy" alt="redacted screenshot">'
        leak_detail = ", ".join(f"{k}:{v}" for k, v in leak_by_type.items())
        leak_label = f"{leak_total} ({leak_detail})" if leak_total else "0"
        rows.append(
            "<tr>"
            f"<td>{_esc(when)}</td>"
            f"<td>{_esc(str(e.get('taskId', ''))[:8])}</td>"
            f"<td>{_esc(e.get('iteration', ''))}</td>"
            f"<td>{_esc(e.get('screenState', ''))}</td>"
            f"<td class='prompt'>{_esc(prompt)}</td>"
            f"<td>{_esc(shot.get('bytes', ''))}</td>"
            f"<td class=\"{'leak' if leak_total else ''}\">{_esc(leak_label)}</td>"
            f"<td>{thumb}</td>"
            "</tr>"
        )

    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Aavaran audit log</title>
<style>
body {{ font: 13px/1.4 system-ui, sans-serif; margin: 24px; color: #1a1a1a; }}
h1 {{ font-size: 18px; margin-bottom: 4px; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 16px; }}
th, td {{ border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }}
th {{ background: #f4f4f4; }}
.prompt {{ max-width: 420px; word-break: break-word; }}
.leak {{ color: #b00020; font-weight: 600; }}
.note {{ color: #555; max-width: 900px; }}
</style></head>
<body>
<h1>Aavaran server audit log</h1>
<p class="note">Every field below is what the extension already tokenized/redacted before sending
(per the API contract, <code>sanitizedDom</code> / <code>prompt</code> carry <code>[TYPE_n]</code> tokens, never raw
values). The <b>leakCatch</b> column re-runs the server-side regex QA
(<code>server/redaction_qa/server_side_regex_check.py</code>) live over the stored entry, so a genuine miss would show
up here, not just in <code>/agent/qa-stats</code>. A thumbnail, when present, is the exact redacted JPEG the extension
sent (<code>AUDIT_IMAGES=1</code>) — never a raw screenshot. Read-only. Showing {len(entries)} of the last {n} requested,
newest first.</p>
<table>
<tr><th>time</th><th>task</th><th>iter</th><th>screenState</th><th>prompt</th><th>image bytes</th><th>leakCatch</th><th>thumbnail</th></tr>
{''.join(rows) if rows else '<tr><td colspan="8">no audit entries yet</td></tr>'}
</table>
</body></html>"""
    return Response(body, media_type="text/html")


@router.get("/view/image/{sha}.jpg")
def view_image(sha: str) -> Response:
    if not store.AUDIT or not store.AUDIT_IMAGES:
        return Response(status_code=404)
    path = store.image_path(sha)
    if not path:
        return Response(status_code=404)
    return Response(path.read_bytes(), media_type="image/jpeg")
