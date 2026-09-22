// DOM Extractor — walks the visible DOM and returns a compact, accessibility-like
// tree (NOT raw HTML: less noise, smaller payload, smaller PII surface).
//
// Runs inside the content script (needs a real `document`).

const AGENT_ID_ATTR = "data-agent-id";
const TEXT_LIMIT = 300;
let idCounter = 0;

function nextId() {
  return `n_${String(idCounter++).padStart(4, "0")}`;
}

function inViewport(rect) {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < vh &&
    rect.left < vw
  );
}

function inferRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  const map = {
    a: "link",
    button: "button",
    input: el.type === "submit" || el.type === "button" ? "button" : "textbox",
    textarea: "textbox",
    select: "combobox",
    article: "article",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    li: "listitem",
    p: "paragraph",
    img: "image",
    nav: "navigation",
  };
  return map[tag] || tag;
}

function isInteractive(el) {
  const tag = el.tagName.toLowerCase();
  if (["a", "button", "input", "textarea", "select"].includes(tag)) return true;
  const role = el.getAttribute("role");
  if (["button", "link", "menuitem", "tab", "checkbox", "textbox"].includes(role)) return true;
  if (el.hasAttribute("onclick") || el.tabIndex >= 0) return true;
  return false;
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

function firstText(root, selector) {
  if (!selector) return "";
  const el = root.querySelector(selector);
  return el ? cleanText(el.textContent) : "";
}

function firstHref(root, selector) {
  if (!selector) return "";
  const el = root.querySelector(selector);
  if (!el) return "";
  try {
    return new URL(el.getAttribute("href"), location.href).href;
  } catch {
    return el.getAttribute("href") || "";
  }
}

function siblingRowMeta(itemEl, cfg) {
  // Hacker News: score/age are in the NEXT <tr>.
  if (!cfg.siblingMeta) return {};
  const nextRow = itemEl.nextElementSibling;
  if (!nextRow) return {};
  const out = {};
  for (const [k, sel] of Object.entries(cfg.siblingMeta)) {
    const el = nextRow.querySelector(sel);
    if (el) out[k] = cleanText(el.textContent);
  }
  return out;
}

/**
 * Extract a snapshot of the currently visible, config-relevant elements.
 * @param {object} siteConfig  from siteConfigs.js
 * @returns {{ nodes: Array<object>, meta: object }}
 */
export function extractSnapshot(siteConfig) {
  const cfg = siteConfig;
  const nodes = [];
  const seenEls = new WeakSet();

  const candidates = document.querySelectorAll(cfg.itemSelector);
  for (const el of candidates) {
    if (seenEls.has(el)) continue;
    seenEls.add(el);

    const rect = el.getBoundingClientRect();
    if (!inViewport(rect)) continue;

    let id = el.getAttribute(AGENT_ID_ATTR);
    if (!id) {
      id = nextId();
      el.setAttribute(AGENT_ID_ATTR, id);
    }

    const hasFieldConfig = cfg.fields && Object.keys(cfg.fields).length > 0;
    const text = hasFieldConfig
      ? firstText(el, cfg.fields.text) || cleanText(el.textContent)
      : cleanText(el.textContent) || cleanText(el.getAttribute("aria-label") || el.value || "");

    const node = {
      id,
      role: cfg.role || inferRole(el),
      text,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      interactive: isInteractive(el),
    };

    if (hasFieldConfig) {
      if (cfg.fields.author) node.author = firstText(el, cfg.fields.author);
      if (cfg.fields.href) node.href = firstHref(el, cfg.fields.href);
      const t = el.querySelector(cfg.fields.timestamp || "time");
      if (t) node.timestamp = t.getAttribute("datetime") || cleanText(t.textContent);
    } else if (el.tagName === "A") {
      node.href = firstHref(el.parentElement || document, "a[href]") || el.href;
    }

    const sib = siblingRowMeta(el, cfg);
    if (Object.keys(sib).length) node.meta = sib;

    // Skip empty non-interactive nodes — pure noise.
    if (!node.text && !node.interactive && !node.href) continue;
    nodes.push(node);
  }

  return {
    nodes,
    meta: {
      siteConfigId: cfg.id,
      url: location.href,
      hostname: location.hostname,
      title: document.title,
      scrollY: window.scrollY,
      scrollMax: document.documentElement.scrollHeight - window.innerHeight,
      articleRoleCount: nodes.filter((n) => n.role === "article").length,
      hasPasswordField: !!document.querySelector('input[type="password"]'),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    },
  };
}

function keyFor(node, dedupeKey) {
  if (dedupeKey === "href" && node.href) return node.href;
  if (dedupeKey === "text" && node.text) return node.text;
  return node.id;
}

/**
 * Scroll the page in increments, re-extracting and de-duplicating, until
 * `targetCount` unique items are collected or we run out of scroll / attempts.
 * @returns {Promise<{ nodes: Array<object>, meta: object, exhausted: boolean }>}
 */
export async function collectWithScroll(siteConfig, {
  targetCount = 10,
  maxAttempts = 12,
  step = 900,
  settleMs = 700,
} = {}) {
  const cfg = siteConfig;
  const byKey = new Map();
  let lastMeta = null;
  let attempts = 0;
  let stagnation = 0;

  const absorb = () => {
    const { nodes, meta } = extractSnapshot(cfg);
    lastMeta = meta;
    let added = 0;
    for (const n of nodes) {
      const k = keyFor(n, cfg.dedupeKey);
      if (!byKey.has(k)) {
        byKey.set(k, n);
        added++;
      }
    }
    return added;
  };

  absorb();
  while (byKey.size < targetCount && attempts < maxAttempts) {
    const beforeY = window.scrollY;
    window.scrollBy(0, step);
    await new Promise((r) => setTimeout(r, settleMs));
    const added = absorb();
    attempts++;

    const movedTo = window.scrollY;
    if (movedTo === beforeY || added === 0) {
      stagnation++;
      if (stagnation >= 2) break; // dead-end: rate limit / login wall / end of feed
    } else {
      stagnation = 0;
    }
  }

  return {
    nodes: [...byKey.values()].slice(0, Math.max(targetCount, byKey.size)),
    meta: { ...lastMeta, scrollAttempts: attempts, uniqueCollected: byKey.size },
    exhausted: byKey.size < targetCount,
  };
}

export function getElementByAgentId(id) {
  return document.querySelector(`[${AGENT_ID_ATTR}="${CSS.escape(id)}"]`);
}

export function resetIdCounter() {
  idCounter = 0;
}
