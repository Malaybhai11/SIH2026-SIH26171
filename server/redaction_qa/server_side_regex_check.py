"""Server-side second line of redaction defense (PRD §5.2).

The server must never trust the client's redaction blindly. Re-run the deterministic
regex layer over the sanitized DOM; re-redact any residual PII and count it as a QA
metric. The request is NOT rejected (demo resilience) — it is repaired and logged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
AADHAAR_RE = re.compile(r"\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b")
PAN_RE = re.compile(r"\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b")
UPI_RE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9._-]{1,63}@(?:ok)?[A-Za-z]{2,15}\b(?![.@-]\w)")
IN_MOBILE_RE = re.compile(r"(?<![\w+\[])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)")

_VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
       [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
_VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
       [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]


def verhoeff_valid(s: str) -> bool:
    d = re.sub(r"\D", "", s)
    c = 0
    for i, ch in enumerate(reversed(d)):
        c = _VD[c][_VP[i % 8][ord(ch) - 48]]
    return c == 0
CC_CANDIDATE_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
PHONE_CANDIDATE_RE = re.compile(
    r"(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{2,4}(?:[\s.\-]?\d{2,4}){1,3}"
)

TOKENS = {
    "EMAIL": "[REDACTED_EMAIL]",
    "SSN": "[REDACTED_SSN]",
    "ID": "[REDACTED_ID]",
    "AADHAAR": "[REDACTED_AADHAAR]",
    "PAN": "[REDACTED_PAN]",
    "UPI": "[REDACTED_UPI]",
    "CC": "[REDACTED_CC]",
    "PHONE": "[REDACTED_PHONE]",
}


def luhn_valid(s: str) -> bool:
    digits = re.sub(r"\D", "", s)
    if not (13 <= len(digits) <= 19):
        return False
    total, dbl = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if dbl:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        dbl = not dbl
    return total % 10 == 0


def _scrub(text: str) -> tuple[str, dict[str, int]]:
    hits: dict[str, int] = {}

    def bump(t: str, n: int = 1):
        hits[t] = hits.get(t, 0) + n

    def sub_simple(rx: re.Pattern, tag: str, token: str, s: str) -> str:
        def repl(m):
            bump(tag)
            return token

        return rx.sub(repl, s)

    text = sub_simple(EMAIL_RE, "EMAIL", TOKENS["EMAIL"], text)
    text = sub_simple(SSN_RE, "SSN", TOKENS["SSN"], text)

    def cc_repl(m):
        if luhn_valid(m.group(0)):
            bump("CC")
            return TOKENS["CC"]
        return m.group(0)

    text = CC_CANDIDATE_RE.sub(cc_repl, text)
    def aadhaar_repl(m):
        if verhoeff_valid(m.group(0)):
            bump("AADHAAR")
            return TOKENS["AADHAAR"]
        return m.group(0)

    text = AADHAAR_RE.sub(aadhaar_repl, text)
    text = sub_simple(PAN_RE, "PAN", TOKENS["PAN"], text)

    def upi_repl(m):
        if re.search(r"@(gmail|yahoo|outlook|hotmail)$", m.group(0), re.I):
            return m.group(0)
        bump("UPI")
        return TOKENS["UPI"]

    text = UPI_RE.sub(upi_repl, text)
    text = sub_simple(IN_MOBILE_RE, "PHONE", TOKENS["PHONE"], text)

    def phone_repl(m):
        raw = m.group(0)
        digits = re.sub(r"\D", "", raw)
        # international formats need a strong separator; space-grouped digit runs are
        # usually order/reference numbers (Indian mobiles are caught by IN_MOBILE_RE)
        if 10 <= len(digits) <= 15 and re.search(r"[+()\-]", raw) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", raw):
            bump("PHONE")
            return TOKENS["PHONE"]
        return raw

    text = PHONE_CANDIDATE_RE.sub(phone_repl, text)
    return text, hits


def scrub_text(text: str) -> tuple[str, dict[str, int]]:
    """Scrub raw text using deterministic regex rules; returns (repaired_text, hits)."""
    return _scrub(text)


@dataclass
class QAResult:
    sanitized_dom: list
    leak_count: int = 0
    leaks_by_type: dict = field(default_factory=dict)
    leaked_element_ids: list = field(default_factory=list)


def check_and_repair(sanitized_dom: list) -> QAResult:
    result = QAResult(sanitized_dom=[])
    for node in sanitized_dom:
        node = dict(node)
        for fld in ("text", "author", "label", "value", "placeholder", "href"):
            val = node.get(fld)
            if not isinstance(val, str) or not val:
                continue
            repaired, hits = _scrub(val)
            if hits:
                n = sum(hits.values())
                result.leak_count += n
                for k, v in hits.items():
                    result.leaks_by_type[k] = result.leaks_by_type.get(k, 0) + v
                if node.get("id"):
                    result.leaked_element_ids.append(node["id"])
                node[fld] = repaired
        result.sanitized_dom.append(node)
    return result


def scrub_tree(obj, skip_keys=("redactedScreenshot",)):
    """Recursively scrub every string in a JSON-like object (prompt, tabs, accumulated
    data, memory facts...). Returns (repaired_obj, hits_by_type)."""
    hits: dict[str, int] = {}

    def walk(x, key=None):
        if isinstance(x, str):
            if key in skip_keys:
                return x
            out, h = _scrub(x)
            for k, v in h.items():
                hits[k] = hits.get(k, 0) + v
            return out
        if isinstance(x, list):
            return [walk(v, key) for v in x]
        if isinstance(x, dict):
            return {k: walk(v, k) for k, v in x.items()}
        return x

    return walk(obj), hits
