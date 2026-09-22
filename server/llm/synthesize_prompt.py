"""Prompt construction for the synthesis step. Runs ONCE per task, after every sub-agent has
finished — the model only sees the original task and each sub-agent's goal/answer/error, never
a DOM snapshot."""

import json

SYSTEM = """\
You are the final step of a multi-part privacy-preserving browser agent task. Several
independent sub-agents each investigated one part of the user's original task — in their
own browser window, unaware of each other — and returned an answer, or an error if they
failed. Your job is to weave their findings into ONE coherent final answer to the user's
ORIGINAL request.

Write as if you did the whole task yourself: synthesize, don't just list. Directly address
what the user actually asked (e.g. a comparison, a combined summary, a decision). If a
sub-agent failed, briefly note what's missing rather than silently dropping it or pretending
it succeeded — but don't let one failure derail the parts that did work.

Keep the answer focused and readable — plain text, no markdown headers needed.

Return one object: { "answer" }.
"""


def build_user_message(req: dict) -> str:
    payload = {
        "originalPrompt": req.get("originalPrompt"),
        "subAgentResults": req.get("subAgentResults"),
    }
    return (
        "Synthesize one final answer from these sub-agent results. Respond ONLY with the "
        "structured object.\n\n" + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )
