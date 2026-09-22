// Minimal, dependency-free markdown-to-HTML renderer for the popup's Answer panel.
// The text being rendered ultimately comes from an LLM reading arbitrary web pages —
// untrusted content — so we escape HTML entities FIRST and only then apply markdown
// transforms on top of the already-escaped text. Never the reverse: markdown syntax
// characters (*, `, [, ], (, ), -, digits, .) aren't in the escape set, so this order
// can't reopen an HTML/XSS hole.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// Inline transforms — run on already-escaped text. Order matters: code spans first
// (so their contents skip bold/italic/link), then links, then bold, then italic.
function inlineMarkdown(line) {
  line = line.replace(/`([^`]+)`/g, "<code>$1</code>");
  // [text](url) — only allow http(s) URLs; anything else (javascript:, data:, etc.)
  // simply doesn't match and is left as literal escaped text.
  line = line.replace(
    /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  line = line.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return line;
}

export function renderMarkdownLite(text) {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/);

  const blocks = [];
  let listBuffer = [];
  let listType = null; // "ul" | "ol"
  let paraBuffer = [];

  function flushList() {
    if (listBuffer.length) {
      const items = listBuffer.map((l) => `<li>${inlineMarkdown(l)}</li>`).join("");
      blocks.push(`<${listType}>${items}</${listType}>`);
      listBuffer = [];
      listType = null;
    }
  }
  function flushPara() {
    if (paraBuffer.length) {
      blocks.push(`<p>${paraBuffer.map(inlineMarkdown).join("<br>")}</p>`);
      paraBuffer = [];
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flushList();
      flushPara();
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (listType !== "ul") flushList();
      listType = "ul";
      listBuffer.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (listType !== "ol") flushList();
      listType = "ol";
      listBuffer.push(numbered[1]);
    } else {
      flushList();
      paraBuffer.push(line);
    }
  }
  flushList();
  flushPara();

  return blocks.join("");
}
