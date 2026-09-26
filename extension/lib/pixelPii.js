// DOM-grounded pixel redaction. Runs in the content script.
//
// The text layer (redact.js) finds PII spans in strings; this module finds the SAME
// spans on screen: visible text is grouped per block element, scanned (rules + NER),
// and every span becomes exact rectangles via Range.getClientRects(). The screenshot
// is then black-boxed at those rectangles — so an email that is tokenised in the DOM
// payload is also invisible in the pixels the VLM sees. Pixel-exact by construction
// (no OCR guesswork), which is what redaction precision is scored on.
//
// It also reports:
//   * sensitive form fields (password / card / OTP / Aadhaar... by type, autocomplete,
//     name) — boxed whole, whatever their current value;
//   * image-like regions (img/video/canvas/background-image) for the vision models;
//   * interactive element marks for Set-of-Marks grounding.

import { detectSpans } from "./redact.js";
import { fieldKind } from "./fieldSensitivity.js";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "TITLE", "IFRAME"]);
const MAX_TEXT_NODES = 2500;

function vpRect(r) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return null;
  return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(vw, r.right) - Math.max(0, r.left), h: Math.min(vh, r.bottom) - Math.max(0, r.top) };
}

const blockCache = new WeakMap();
function blockOf(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    // SVG <text> (an id-card/PAN-card rendered as SVG, not raster) is its own block:
    // it doesn't participate in CSS block/inline layout the way HTML does, and a
    // Range spanning across the SVG boundary into surrounding HTML text produces
    // unreliable getClientRects() results — stopping here keeps SVG text scanned
    // (and boxed) as its own self-contained unit instead of being silently dropped.
    if (cur.tagName === "text") return cur;
    let isBlock = blockCache.get(cur);
    if (isBlock === undefined) {
      const d = getComputedStyle(cur).display;
      isBlock = !d.startsWith("inline") && d !== "contents";
      blockCache.set(cur, isBlock);
    }
    if (isBlock) return cur;
    // A shadow-root boundary: cur's next parentElement is null even though cur
    // isn't document.body (a shadow tree's own top-level nodes have no
    // parentElement — the ShadowRoot itself isn't an Element). Stop here and treat
    // it as its own block, instead of falling through to document.body below,
    // which would wrongly merge unrelated shadow-root text into one block keyed
    // on the light-DOM body.
    if (!cur.parentElement) return cur;
    cur = cur.parentElement;
  }
  return document.body;
}

// E2: an open shadow root (any real web-component: most design systems use one)
// renders on screen exactly like light DOM, but document.body's own TreeWalker
// never descends into it — a shadow tree is a separate node tree. A CLOSED shadow
// root is unreachable from content-script JS by design (the browser enforces
// that, same as it enforces cross-origin isolation) and is out of scope here.
function findOpenShadowRoots(root, out = []) {
  const els = root.querySelectorAll ? root.querySelectorAll("*") : [];
  for (const el of els) {
    if (el.shadowRoot) {
      out.push(el.shadowRoot);
      findOpenShadowRoots(el.shadowRoot, out);
    }
  }
  return out;
}

/** Visible text grouped by block ancestor, with per-node offsets. Walks document.body
 * plus every reachable open shadow root as its own extra TreeWalker root. */
export function collectTextBlocks() {
  const acceptNode = (n) => {
    if (!n.data || !/\S/.test(n.data)) return NodeFilter.FILTER_REJECT;
    const p = n.parentElement;
    // SVG <text>/<tspan> content IS scanned (see blockOf: it's grouped as its own
    // block) — only truly non-textual SVG (paths, shapes) has no text nodes to
    // walk into anyway, so no extra guard is needed here beyond SKIP_TAGS.
    if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  };
  const blocks = new Map();
  let count = 0;
  const elVisible = new WeakMap();
  const roots = [document.body, ...findOpenShadowRoots(document)];
  for (const root of roots) {
    if (count >= MAX_TEXT_NODES) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode });
    for (let n = walker.nextNode(); n && count < MAX_TEXT_NODES; n = walker.nextNode()) {
      const p = n.parentElement;
      let vis = elVisible.get(p);
      if (vis === undefined) {
        vis = !!vpRect(p.getBoundingClientRect());
        elVisible.set(p, vis);
      }
      if (!vis) continue;
      count++;
      const b = blockOf(p);
      let blk = blocks.get(b);
      if (!blk) blocks.set(b, (blk = { text: "", parts: [] }));
      // <br> and inline-block siblings render as separate lines: keep them apart so
      // "Rohan Mehta<br>House No. 12" is not read as one token "MehtaHouse"
      if (blk.text && (n.previousSibling?.nodeName === "BR" || (!/\s$/.test(blk.text) && p !== blk.lastParent && p.previousElementSibling?.nodeName === "BR"))) blk.text += "\n";
      blk.parts.push({ node: n, start: blk.text.length });
      blk.text += n.data;
      blk.lastParent = p;
    }
  }
  return [...blocks.values()].filter((b) => /\S/.test(b.text) && b.text.length <= 5000);
}

/** Client rects (viewport CSS px) of [start,end) in a block made of text-node parts. */
function spanRects(block, start, end) {
  const rects = [];
  const range = document.createRange();
  for (const part of block.parts) {
    const ps = part.start;
    const pe = ps + part.node.data.length;
    if (pe <= start || ps >= end) continue;
    range.setStart(part.node, Math.max(0, start - ps));
    range.setEnd(part.node, Math.min(part.node.data.length, end - ps));
    for (const r of range.getClientRects()) {
      const v = vpRect(r);
      if (v && v.w >= 1 && v.h >= 1) rects.push(v);
    }
  }
  return rects;
}

// E2: PII placed in a ::before/::after CSS `content` string is never a DOM text
// node at all — collectTextBlocks (Range/TreeWalker based) structurally cannot see
// it, yet it renders on screen exactly like real text. There is no Range API for a
// pseudo-element, so an exact sub-rectangle isn't available; the whole host
// element's box is blacked out instead — the same "can't localise precisely, cover
// the region" fallback already used for unreachable cross-origin iframes (D1, see
// privacyPipeline.js). getComputedStyle(el, pseudo).content only yields a plain
// string for a literal CSS string value ("..."); attr()/counter()/url() etc. are
// left alone (out of scope: they don't carry an attacker-authored literal value).
const MAX_PSEUDO_SCAN = 3000;
function collectPseudoContent() {
  const out = [];
  const els = document.body.querySelectorAll("*");
  let n = 0;
  for (const el of els) {
    if (n++ > MAX_PSEUDO_SCAN) break;
    for (const pseudo of ["::before", "::after"]) {
      let cs;
      try {
        cs = getComputedStyle(el, pseudo);
      } catch {
        continue;
      }
      const raw = cs.content;
      if (!raw || raw === "none" || raw === "normal") continue;
      const m = /^["'](.*)["']$/.exec(raw);
      if (!m || !m[1].trim()) continue;
      const v = vpRect(el.getBoundingClientRect());
      if (!v) continue;
      out.push({ text: m[1], v });
    }
  }
  return out;
}

/**
 * Scan the viewport for pixel-level PII.
 * @param {(texts:string[])=>Promise<Array<Array<span>>>} [nerBatch]
 * @returns {Promise<{ boxes: Array<{x,y,w,h,type,value,source}>, stats }>}  values stay in the extension
 */
export async function scanViewportPii(nerBatch, known = [], customTerms = []) {
  const t0 = performance.now();
  const blocks = collectTextBlocks();
  let nerSpans = null;
  if (nerBatch) {
    const texts = blocks.map((b) => b.text.replace(/\s+/g, " ").length > 2 ? b.text : "");
    try {
      nerSpans = await nerBatch(texts);
    } catch (e) {
      console.warn("[pixelPii] NER unavailable, rules only", e);
    }
  }
  const tNer = performance.now();

  const boxes = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const pre = nerSpans?.[i] || [];
    const spans = await detectSpans(b.text, { nerTag: nerSpans ? async () => pre : undefined, known, customTerms });
    for (const s of spans) {
      for (const r of spanRects(b, s.start, s.end)) boxes.push({ ...r, type: s.type, value: s.value, source: s.source });
    }
  }

  // E2: ::before/::after generated content — no exact sub-rect available, so the
  // whole host element is boxed (see collectPseudoContent's doc comment).
  for (const { text, v } of collectPseudoContent()) {
    const spans = await detectSpans(text, { known, customTerms });
    if (spans.length) boxes.push({ ...v, type: spans[0].type, value: text, source: "pseudo" });
  }

  // form fields: sensitive by kind (always), personal by value (when filled)
  for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select")) {
    const v = vpRect(el.getBoundingClientRect());
    if (!v) continue;
    const kind = fieldKind(el);
    const value = el.tagName === "SELECT" ? el.selectedOptions?.[0]?.textContent || "" : el.value || "";
    if (kind && kind !== "PERSONAL_FIELD") {
      boxes.push({ ...v, type: kind, value, source: "field" });
      continue;
    }
    if (!value) continue;
    if (kind === "PERSONAL_FIELD") {
      boxes.push({ ...v, type: "PERSONAL_FIELD", value, source: "field" });
      continue;
    }
    const spans = await detectSpans(value, { known, customTerms });
    if (spans.length) boxes.push({ ...v, type: spans[0].type, value, source: "field" });
  }

  return {
    boxes,
    stats: { blocks: blocks.length, nerMs: Math.round(tNer - t0), totalMs: Math.round(performance.now() - t0) },
  };
}

// DOM semantics for an image: alt / aria-label / title / file name / class. Only the
// matched CATEGORY leaves this function — never the attribute text itself.
const DOM_HINTS = [
  ["signature", /\bsign(ature|ed)?\b|autograph/i],
  ["id_card", /aadh?aa?r|\bpan[\s_-]?card|passport|licen[cs]e|voter|\bid[\s_-]?(card|proof|doc)|identity|kyc/i],
  ["bank_card", /credit[\s_-]?card|debit[\s_-]?card|\bcard[\s_-]?(front|back|image)/i],
  ["face_photo", /avatar|profile[\s_-]?(pic|photo|image)|headshot|selfie|portrait|user[\s_-]?photo|customer photo|\bdp\b/i],
  ["qr_code", /\bqr\b|qrcode/i],
];
function domHintFor(el) {
  let file = "";
  try {
    file = new URL(el.currentSrc || el.src || "", location.href).pathname.split("/").pop() || "";
  } catch {}
  const hay = `${el.alt || ""} ${el.getAttribute("aria-label") || ""} ${el.title || ""} ${file} ${el.className || ""} ${el.id || ""}`;
  for (const [cat, re] of DOM_HINTS) if (re.test(hay)) return cat;
  return null;
}

/** Image-like regions for the vision models (viewport CSS px). */
export function collectImageRois(limit = 40) {
  const out = [];
  const seen = new Set();
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const v = vpRect(el.getBoundingClientRect());
    if (!v || v.w < 20 || v.h < 20) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || +cs.opacity === 0) return;
    const id = el.getAttribute("data-agent-id") || `roi_${out.length}`;
    out.push({ id, kind, x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h), domHint: domHintFor(el) });
  };
  for (const el of document.querySelectorAll("img, video, canvas, picture, svg image, object, embed")) push(el, el.tagName.toLowerCase());
  // CSS background images: only elements that plausibly are photos (avatar/photo/cover...)
  for (const el of document.querySelectorAll('[style*="background-image"], [class*="avatar" i], [class*="photo" i], [class*="profile" i], [class*="thumb" i]')) {
    if (out.length >= limit) break;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none" && bg.includes("url(")) push(el, "background");
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit);
}

/** Set-of-Marks: visible interactive nodes from the extractor, viewport CSS px. */
export function interactiveMarks(nodes) {
  const out = [];
  for (const n of nodes) {
    if (!n.interactive) continue;
    const el = document.querySelector(`[data-agent-id="${n.id}"]`);
    if (!el) continue;
    const v = vpRect(el.getBoundingClientRect());
    if (!v) continue;
    out.push({ id: n.id, label: String(parseInt(n.id.slice(2), 10)), x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h) });
  }
  return out;
}
