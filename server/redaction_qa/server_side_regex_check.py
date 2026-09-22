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
NATIONAL_ID_RE = re.compile(r"\b\d{4}\s\d{4}\s\d{4}\b")
CC_CANDIDATE_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
PHONE_CANDIDATE_RE = re.compile(
    r"(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{2,4}(?:[\s.\-]?\d{2,4}){1,3}"
)

TOKENS = {
    "EMAIL": "[REDACTED_EMAIL]",
    "SSN": "[REDACTED_SSN]",
    "ID": "[REDACTED_ID]",
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
    text = sub_simple(NATIONAL_ID_RE, "ID", TOKENS["ID"], text)

    def phone_repl(m):
        raw = m.group(0)
        digits = re.sub(r"\D", "", raw)
        if 10 <= len(digits) <= 15 and re.search(r"[\s.\-()+]", raw):
            bump("PHONE")
            return TOKENS["PHONE"]
        return raw

    text = PHONE_CANDIDATE_RE.sub(phone_repl, text)
    return text, hits


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
        for fld in ("text", "author"):
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
