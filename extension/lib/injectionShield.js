// Prompt-injection shield (B2) — a page can hide instructions aimed at an AI agent
// inside its own content (white-on-white text, zero-size fonts, off-screen divs,
// an alt attribute, a hidden comment-like div). The client can't stop a page from
// containing that text, but it can (a) not hand it to the model as if it were
// ordinary content — see domExtractor.js's visibility filtering, which drops text
// that is invisible to a human anyway — and (b) flag anything left that reads like
// an instruction TO an agent, so the server treats it as data, never as a command.
//
// DOM-free by design (same reasoning as redact.js) so the same detector runs in
// the content script and in eval/unit tests.

const PATTERNS = [
  // direct override attempts
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) instructions?/i,
  /disregard (?:all |any )?(?:the )?(?:previous|prior|above|earlier)/i,
  /forget (?:all |any )?(?:the )?(?:previous|prior|above|your) instructions?/i,
  /new instructions?:/i,
  /override (?:your |the )?(?:system|previous) (?:prompt|instructions?)/i,
  // role / identity hijacks
  /you are (?:now |actually )?(?:an? )?(?:ai|agent|assistant|bot|llm)\b/i,
  /act as (?:an? |if you (?:are|were) )/i,
  /system\s*(?:prompt|message)\s*:/i,
  /\[?\s*(?:system|assistant)\s*\]?\s*:/i,
  // exfiltration asks — the specific thing B1's token release policy exists to stop
  // even if the model is talked into trying
  /send (?:your|the|this|all) (?:data|information|details|tokens?|values?) to/i,
  /(?:email|post|submit|upload) (?:this|the|your) (?:data|information|details) to/i,
  /navigate to https?:\/\/[^\s]+\?[^\s]*(?:token|email|phone|aadhaar|card)/i,
  // concealment asks
  /do not (?:tell|inform|mention (?:this|it) to) the user/i,
  /don'?t (?:let|tell) the user know/i,
  /keep this (?:secret|hidden) from the user/i,
];

/** True if `text` reads like an instruction aimed at an AI agent, not page content. */
export function looksLikeInjection(text) {
  if (!text || text.length < 8) return false;
  return PATTERNS.some((re) => re.test(text));
}

/**
 * Scan a set of {id, text} page nodes for injection attempts.
 * @returns {Array<{elementId, snippet}>}
 */
export function scanForInjection(nodes) {
  const hits = [];
  for (const n of nodes) {
    const text = n.text;
    if (typeof text === "string" && looksLikeInjection(text)) {
      hits.push({ elementId: n.id, snippet: text.slice(0, 160) });
    }
  }
  return hits;
}
