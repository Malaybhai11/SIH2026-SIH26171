// DOM Extractor — walks the visible DOM and returns a compact, accessibility-like
// tree (NOT raw HTML: less noise, smaller payload, smaller PII surface).
//
// Runs inside the content script (needs a real `document`).

import { isSensitiveField } from "./fieldSensitivity.js";

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

// B2: a page can hide text from a human (so it never shows on screen) while
// leaving it perfectly readable in the DOM — the classic way to smuggle an
// instruction aimed at an AI agent past a person glancing at the page.
// inViewport() above already drops zero-size and fully off-screen elements
// (covers display:none and position:absolute;left:-9999px); this covers the
// techniques that still leave a normal-looking, in-viewport rect: hidden via
// visibility, faded via opacity, shrunk to an unreadable font size, or painted
// the same colour as its own background.
function parseRgb(c) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(c || "");
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}
function isVisibleToUser(el) {
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch {
    return true; // can't tell — fail open, rely on the injection-language flag instead
  }
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
  const opacity = parseFloat(cs.opacity);
  if (!Number.isNaN(opacity) && opacity <= 0.05) return false;
  const fontSize = parseFloat(cs.fontSize);
  if (!Number.isNaN(fontSize) && fontSize < 2) return false;
  const fg = parseRgb(cs.color);
  const bg = parseRgb(cs.backgroundColor);
  if (fg && bg && bg.a > 0.5 && fg.r === bg.r && fg.g === bg.g && fg.b === bg.b) return false;
  return true;
}

// input[type=X] -> accessibility role. Anything not listed here (text, search,
// email, url, tel, number, password, date/time pickers, …) falls through to
// "textbox", which is correct for those — but NOT for file/checkbox/radio, which
// need their own action types (`check`) or can't be filled programmatically at all.
const INPUT_TYPE_ROLE = {
  submit: "button",
  button: "button",
  image: "button",
  reset: "button",
  checkbox: "checkbox",
  radio: "radio",
  file: "file",
  range: "slider",
  color: "button",
};

export const ALERT_CONTAINER_SELECTORS = [
  ".toaster",
  ".toast-container",
  ".toasts",
  "[data-sonner-toaster]",
  "[data-radix-toast-viewport]",
  ".Toastify",
  ".ant-message",
  ".ant-notification",
  ".notifications-container",
].join(", ");

export const GLOBAL_ALERT_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '[role="alertdialog"]',
  '[aria-live="assertive"]',
  '[aria-live="polite"]',
  '[data-sonner-toast]',
  '[data-radix-toast-content]',
  '.react-hot-toast',
  '.Toastify__toast',
  '.MuiAlert-root',
  '.MuiSnackbar-root',
  '.ant-message-notice',
  '.ant-notification-notice',
  '.toast',
  '.alert',
  '.notification',
  '[class*="toast" i]:not(body):not(html):not(#root):not(#__next):not([data-sonner-toaster]):not(.toaster):not(.toast-container)',
  '[class*="alert" i]:not(body):not(html):not(#root):not(#__next)',
  '[class*="snackbar" i]',
  '[data-testid*="toast" i]',
  '[data-testid*="alert" i]',
  '[data-testid*="error" i]',
  '[class*="error-message" i]',
  '[class*="invalid-feedback" i]',
  '[class*="text-destructive" i]',
].join(", ");

function inferRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") return INPUT_TYPE_ROLE[(el.type || "text").toLowerCase()] || "textbox";
  if (el.isContentEditable) return "textbox";
  try {
    if (el.matches?.('[data-sonner-toast], [data-radix-toast-content], .toast, [class*="toast" i], [class*="alert" i]')) {
      return "alert";
    }
    if (el.matches?.('[class*="error" i], [class*="invalid" i], [class*="destructive" i]')) {
      return "alert";
    }
  } catch {}
  const map = {
    a: "link",
    button: "button",
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
    dialog: "dialog",
  };
  return map[tag] || tag;
}

function isInteractive(el) {
  const tag = el.tagName.toLowerCase();
  if (["a", "button", "input", "textarea", "select"].includes(tag)) return true;
  const role = el.getAttribute("role");
  if (["button", "link", "menuitem", "tab", "checkbox", "textbox"].includes(role)) return true;
  if (el.isContentEditable) return true;
  if (el.hasAttribute("onclick") || el.tabIndex >= 0) return true;
  return false;
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

// innerText honours <br> and block boundaries ("Rohan Mehta\nHouse No. 12");
// textContent would glue them into "Rohan MehtaHouse No. 12".
function visibleText(el) {
  const t = el.innerText;
  return cleanText(typeof t === "string" ? t.replace(/\n+/g, " · ") : el.textContent);
}

function extractFormFieldText(el) {
  const parts = [];

  // 1. Associated label text
  let labelText = "";
  if (el.labels && el.labels.length) {
    labelText = Array.from(el.labels).map((l) => cleanText(l.textContent)).filter(Boolean).join(" ");
  }
  if (!labelText && el.getAttribute("aria-labelledby")) {
    const ids = el.getAttribute("aria-labelledby").split(/\s+/);
    labelText = ids.map((id) => cleanText(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
  }
  if (!labelText && el.id) {
    try {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) labelText = cleanText(labelEl.textContent);
    } catch {}
  }
  if (!labelText) {
    const parentLabel = el.closest?.("label");
    if (parentLabel) {
      try {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll("input, textarea, select, button").forEach((i) => i.remove());
        labelText = cleanText(clone.textContent);
      } catch {}
    }
  }
  if (!labelText && el.getAttribute("aria-label")) {
    labelText = cleanText(el.getAttribute("aria-label"));
  }

  // 2. Placeholder
  const placeholder = el.getAttribute("placeholder");

  // 3. Name or id
  const nameOrId = el.name || el.id;

  // Primary field name
  const primaryName = labelText || placeholder || nameOrId || "";
  if (primaryName) parts.push(primaryName);

  if (placeholder && placeholder !== primaryName) {
    parts.push(`placeholder: "${cleanText(placeholder)}"`);
  }

  if (el.value) {
    // sensitive fields (password, card, CVV, OTP, Aadhaar...) only say THAT they are
    // filled; the value never enters the payload, not even tokenised
    parts.push(isSensitiveField(el) ? "value: <filled, hidden on device>" : `value: "${cleanText(el.value)}"`);
  }

  const isRequired = el.required || el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
  if (isRequired) {
    parts.push("REQUIRED");
  }

  // Validation error state and message
  let errorMsg = "";
  if (el.getAttribute("aria-errormessage")) {
    const errEl = document.getElementById(el.getAttribute("aria-errormessage"));
    if (errEl) errorMsg = cleanText(errEl.textContent);
  }
  if (!errorMsg) {
    const container = el.closest?.(".form-group, .form-item, .field, [class*='field'], [class*='form'], div") || el.parentElement;
    if (container) {
      const nearbyErr = container.querySelector(
        '[role="alert"], [class*="error" i], [class*="invalid" i], [class*="destructive" i], [data-error]'
      );
      if (nearbyErr && nearbyErr !== el && cleanText(nearbyErr.textContent)) {
        errorMsg = cleanText(nearbyErr.textContent);
      }
    }
  }

  const isAriaInvalid = el.getAttribute("aria-invalid") === "true";
  let isUserInvalid = false;
  try {
    isUserInvalid = el.matches?.(":user-invalid") || false;
  } catch {}

  if (!errorMsg && (isAriaInvalid || isUserInvalid) && el.validationMessage) {
    errorMsg = cleanText(el.validationMessage);
  }

  if (errorMsg) {
    parts.push(`VALIDATION ERROR: "${errorMsg}"`);
  } else if (isAriaInvalid || isUserInvalid) {
    parts.push("INVALID");
  }

  return parts.join(" | ") || cleanText(el.value || "");
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
  const activeToasts = [];

  // Combine site-specific selector with global toast/alert selectors so alerts
  // and floating notifications are never missed regardless of the active site config.
  const selector = cfg.itemSelector
    ? `${cfg.itemSelector}, ${GLOBAL_ALERT_SELECTORS}`
    : GLOBAL_ALERT_SELECTORS;

  const candidates = document.querySelectorAll(selector);
  for (const el of candidates) {
    if (seenEls.has(el)) continue;
    seenEls.add(el);

    // Skip toast container wrappers (e.g. .toaster, [data-sonner-toaster])
    try {
      if (el.matches?.(ALERT_CONTAINER_SELECTORS)) continue;
    } catch {}

    // Skip non-interactive children inside an alert element to avoid duplicating alert text
    try {
      const parentAlert = el.parentElement?.closest?.(GLOBAL_ALERT_SELECTORS);
      if (parentAlert && parentAlert !== el && !isInteractive(el)) continue;
    } catch {}

    // File inputs can't be filled programmatically (browsers reject any value but
    // "") even when — as with many upload buttons — an invisible one is layered
    // over a visible custom control and so still passes the viewport check below.
    // Surfacing it as a normal "textbox" just invites the agent to try to type
    // into it and fail every time.
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file") continue;

    const rect = el.getBoundingClientRect();
    if (!inViewport(rect)) continue;

    let id = el.getAttribute(AGENT_ID_ATTR);
    if (!id) {
      id = nextId();
      el.setAttribute(AGENT_ID_ATTR, id);
    }

    const tag = el.tagName.toLowerCase();
    const hasFieldConfig = cfg.fields && Object.keys(cfg.fields).length > 0;

    // B2: text invisible to a human never reaches the payload — a hidden div full
    // of instructions aimed at an agent doesn't get read as if it were the page's
    // real content. Form fields keep their text (a password/CVV field's own value
    // is never serialised anyway — see extractFormFieldText — and a hidden input's
    // label isn't an injection vector), only free text is gated.
    let text = "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      text = extractFormFieldText(el);
    } else if (!isVisibleToUser(el)) {
      text = "";
    } else if (hasFieldConfig) {
      text = firstText(el, cfg.fields.text) || visibleText(el);
    } else {
      text =
        visibleText(el) ||
        cleanText(el.getAttribute("aria-label") || el.getAttribute("title") || el.value || (tag === "img" ? el.alt : "") || "");
    }

    // Check if this is a toast or alert notification
    const isToastOrAlert =
      el.getAttribute("role") === "alert" ||
      el.getAttribute("role") === "status" ||
      el.matches?.(GLOBAL_ALERT_SELECTORS);

    if (isToastOrAlert) {
      const rawToastText = cleanText(el.textContent);
      if (rawToastText && !activeToasts.includes(rawToastText)) {
        activeToasts.push(rawToastText);
      }
      if (text && !text.toLowerCase().startsWith("toast") && !text.toLowerCase().startsWith("[toast")) {
        text = `[TOAST / ALERT]: ${text}`;
      }
    }

    const node = {
      id,
      role: isToastOrAlert ? "alert" : cfg.role || inferRole(el),
      text,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      interactive: isInteractive(el),
    };

    if (el.tagName === "SELECT") {
      node.value = el.value;
      node.options = [...el.options].map((o) => ({ value: o.value, text: cleanText(o.textContent) }));
    } else if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      node.checked = el.checked;
      node.value = el.value;
    } else if (el.tagName === "IMG") {
      // Resolved absolute URL so the LLM can see (and later target via save_image)
      // which images exist without guessing blindly.
      node.src = el.currentSrc || el.src || "";
    }

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

  // Generic pages keep much of their content in div/span/td/dd text that no item
  // selector names. Add every visible text block not already covered, then restore
  // reading order, so the server sees what the user sees (visual-context accuracy).
  if (cfg.id === "generic") addTextBlocks(nodes, seenEls);

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
      loginWall: detectLoginWall(),
      captchaWall: detectCaptcha(),
      toasts: activeToasts,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    },
  };
}

const TEXT_BLOCK_LIMIT = 200;
const blockDisplay = new WeakMap();
function isBlock(el) {
  let v = blockDisplay.get(el);
  if (v === undefined) {
    const d = getComputedStyle(el).display;
    v = !d.startsWith("inline") && d !== "contents";
    blockDisplay.set(el, v);
  }
  return v;
}

function addTextBlocks(nodes, extractedEls) {
  const covered = (el) => {
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) if (extractedEls.has(cur)) return true;
    return false;
  };
  const blocks = new Map();
  // B2: same visibility gate as the main extraction loop — text hidden from a
  // human (opacity/visibility/tiny font/same-colour) is dropped here too, not
  // just for elements the site config or global selectors already matched.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.data && /\S/.test(n.data) && n.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(n.parentElement.tagName) && isVisibleToUser(n.parentElement)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const p = t.parentElement;
    if (covered(p)) continue;
    let b = p;
    while (b && b !== document.body && !isBlock(b)) b = b.parentElement;
    if (!b || b === document.body || covered(b)) continue;
    if (!blocks.has(b)) blocks.set(b, true);
  }
  let added = 0;
  const entries = nodes.map((n) => ({ n, el: document.querySelector(`[${AGENT_ID_ATTR}="${n.id}"]`) }));
  for (const b of blocks.keys()) {
    if (added >= TEXT_BLOCK_LIMIT) break;
    const rect = b.getBoundingClientRect();
    if (!inViewport(rect)) continue;
    // own text only: skip text belonging to nested blocks (they become their own nodes)
    let text = "";
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      let owner = t.parentElement;
      while (owner && owner !== b && !isBlock(owner)) owner = owner.parentElement;
      if (owner === b && !/^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(t.parentElement.tagName) && isVisibleToUser(t.parentElement)) {
        if (t.previousSibling?.nodeName === "BR" || t.parentElement.previousElementSibling?.nodeName === "BR") text += " · ";
        text += t.data;
      }
    }
    text = cleanText(text);
    if (!text || text.length < 2) continue;
    let id = b.getAttribute(AGENT_ID_ATTR);
    if (!id) {
      id = nextId();
      b.setAttribute(AGENT_ID_ATTR, id);
    }
    const node = {
      id,
      role: "text",
      text,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      interactive: isInteractive(b),
    };
    entries.push({ n: node, el: b });
    added++;
  }
  entries.sort((a, b) => {
    if (!a.el || !b.el || a.el === b.el) return 0;
    return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  nodes.length = 0;
  for (const e of entries) nodes.push(e.n);
}

/** Heuristic: is the page a sign-in gate rather than real content? */
export function detectLoginWall() {
  const url = location.href;
  if (/\/(i\/flow\/login|login|account\/login|signin|sign[_-]?in|auth)(\/|\?|#|$)/i.test(url)) {
    return true;
  }
  const host = location.hostname;
  if (/(^|\.)(x|twitter)\.com$/i.test(host)) {
    if (
      document.querySelector(
        '[data-testid="loginButton"], [data-testid="LoginForm_Login_Button"], input[autocomplete="username"], [data-testid="sheetDialog"]',
      )
    ) {
      return true;
    }
    // X unauthenticated interstitial modal / bottom sheet. `.?` between "what"
    // and "s" matches a straight apostrophe, a curly one, or none — the two
    // checks here previously used different apostrophe characters, so one could
    // silently never match the live page's actual text.
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog && /sign in to x|log in to x|see what.?s happening/i.test(dialog.innerText || "")) {
      return true;
    }
    // logged-out x.com renders almost no timeline articles
    const timeline = document.querySelectorAll('article[data-testid="tweet"]').length;
    const signInCta = /log in|sign up|see what.?s happening/i.test(document.body?.innerText || "");
    if (timeline === 0 && signInCta) return true;
  }
  // a sign-in gate = password + at most a username field, on an otherwise thin page;
  // a password field inside a bigger form (KYC confirm, checkout) is not a wall
  const bodyLen = (document.body?.innerText || "").length;
  const pw = document.querySelector('input[type="password"]');
  if (pw && bodyLen < 1800) {
    const otherFields = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]), select, textarea")].filter(
      (el) => el.type !== "password",
    ).length;
    if (otherFields <= 2) return true;
  }
  return false;
}

// reCAPTCHA (and similar widgets) inject their OWN internal helper iframes on any
// page that merely loads the script anywhere — most commonly the accessibility
// "aframe" and the checkbox "anchor" frame, both permanently 0x0/hidden by design,
// present even for invisible v3 scoring nobody ever sees. Only the interactive
// challenge frame ("bframe" — the picture-grid puzzle) or a widget that's actually
// VISIBLE on screen indicates a real wall blocking the page, so those hidden
// helper iframes are excluded here; a plain `iframe[src*="recaptcha"]` selector
// matched them and produced false positives on ordinary pages (see eval/results).
const CAPTCHA_HIDDEN_IFRAME_RE = /recaptcha\/api2\/(aframe|anchor)/i;
function hasVisibleCaptchaWidget() {
  const candidates = document.querySelectorAll(
    'iframe[src*="recaptcha"], .g-recaptcha, #recaptcha, iframe[src*="hcaptcha"], .h-captcha, #px-captcha, [class*="datadome"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #arkose, div[data-e2e="arkose-frame"], iframe[src*="challenges.cloudflare.com"], .cf-turnstile',
  );
  for (const el of candidates) {
    if (el.tagName === "IFRAME" && CAPTCHA_HIDDEN_IFRAME_RE.test(el.src || "")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) return true;
  }
  return false;
}

/** Heuristic: is the page a CAPTCHA / automated-bot challenge rather than real content? */
export function detectCaptcha() {
  if (hasVisibleCaptchaWidget()) return true;
  if (document.querySelector("#challenge-running, #cf-challenge-running")) return true;
  const title = document.title || "";
  if (/just a moment|attention required/i.test(title)) return true;
  const bodyText = (document.body?.innerText || "").slice(0, 2500);
  if (
    /verify you are human|i'?m not a robot|security check|checking your browser|prove you'?re human|rate limit exceeded|unusual traffic from your computer network/i.test(
      bodyText,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * SPA-aware extract: poll until content appears (or a login wall / try budget).
 * Cheap when the page is already hydrated — first call returns immediately.
 */
export async function waitForContent(siteConfig, { tries = 5, gap = 650 } = {}) {
  let snap = extractSnapshot(siteConfig);
  let n = 0;
  while (snap.nodes.length === 0 && n < tries && !snap.meta.loginWall) {
    await new Promise((r) => setTimeout(r, gap));
    snap = extractSnapshot(siteConfig);
    n += 1;
  }
  snap.meta.waitTries = n;
  return snap;
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
  maxAttempts = 15,
  step = 750,
  settleMs = 1200,
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
    if (lastMeta?.loginWall || lastMeta?.captchaWall) break;

    const beforeY = window.scrollY;
    // Human-like smooth scroll with variance
    const jitteredStep = Math.round(step * (0.88 + Math.random() * 0.24));
    window.scrollBy({ top: jitteredStep, behavior: "smooth" });

    // Adaptive settle delay allowing SPA virtual lists & network responses to hydrate
    const delay = settleMs + Math.random() * 500;
    await new Promise((r) => setTimeout(r, delay));

    const added = absorb();
    attempts++;

    const movedTo = window.scrollY;
    if (movedTo === beforeY || added === 0) {
      stagnation++;
      if (stagnation >= 3) break; // dead-end: rate limit / login wall / end of feed
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
