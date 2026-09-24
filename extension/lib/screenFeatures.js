// Screen understanding = pixels + structure.
//
// MobileCLIP sees pixels but was never trained on user interfaces; the DOM knows the
// structure exactly (a password field IS a password field) but not how the page
// looks. Fusing them on-device gives a far more reliable screen state than either
// alone. The features below are structural COUNTS only — no text, no values — so
// they are safe to use anywhere (and to report to the server as visual context).
//
// domScreenFeatures() must stay self-contained (no imports, no closures): the eval
// harness injects it into pages with page.evaluate() to score the shipped logic.

export function domScreenFeatures() {
  const vh = innerHeight;
  const vw = innerWidth;
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh * 1.5;
  };
  const q = (s) => [...document.querySelectorAll(s)].filter(inView);
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return (Math.max(0, Math.min(r.right, vw) - Math.max(0, r.left)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(0, r.top))) / (vw * vh);
  };
  const fields = q("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=image]), select, textarea");
  const pw = fields.filter((f) => f.type === "password").length;
  const text = (document.body?.innerText || "").slice(0, 20000);
  const words = text.split(/\s+/).filter(Boolean).length;
  const title = `${document.title} ${[...document.querySelectorAll("h1")].map((h) => h.innerText).join(" ")}`.slice(0, 400);
  const lower = text.toLowerCase();
  const has = (re) => (re.test(lower) ? 1 : 0);
  const imgs = q("img").filter((i) => i.getBoundingClientRect().width >= 60);
  const largest = (sel) => q(sel).reduce((m, el) => Math.max(m, area(el)), 0);
  return {
    fields: fields.length,
    pw,
    otherFields: fields.length - pw,
    emailFields: fields.filter((f) => f.type === "email" || /e-?mail/i.test(`${f.name} ${f.id} ${f.placeholder} ${f.getAttribute("autocomplete") || ""}`)).length,
    cardFields: fields.filter((f) => /cc-|card|cvv|cvc|expir/i.test(`${f.name} ${f.id} ${f.placeholder} ${f.getAttribute("autocomplete") || ""}`)).length,
    fileInputs: document.querySelectorAll("input[type=file]").length,
    searchValue: fields.some((f) => (f.type === "search" || /search|query|^q$/i.test(`${f.name} ${f.id} ${f.getAttribute("role") || ""}`)) && f.value) ? 1 : 0,
    urlQuery: /[?&](q|query|search|keyword|k|_nkw|text)=/i.test(location.search) ? 1 : 0,
    links: q("a[href]").length,
    images: imgs.length,
    roundImages: imgs.filter((i) => parseFloat(getComputedStyle(i).borderRadius) >= i.getBoundingClientRect().width / 3).length,
    videoArea: +largest("video, iframe[src*='youtube'], iframe[src*='vimeo'], [class*='video-player' i], [class*='player' i] video").toFixed(2),
    canvasArea: +largest("canvas").toFixed(2),
    mapHint: document.querySelector(".leaflet-container, .mapboxgl-map, .ol-viewport, .gm-style, [class*='maplibre']") ? 1 : 0,
    pdfHint: document.querySelector("embed[type='application/pdf'], #viewer.pdfViewer, pdf-viewer") || /\.pdf($|\?)/i.test(location.pathname) || document.contentType === "application/pdf" ? 1 : 0,
    tableRows: q("tr, [role=row]").length,
    codeLines: q("pre, code, .blob-code, [class*='code-line' i], td.blob-code").reduce((n, el) => n + Math.min(200, (el.innerText || "").split("\n").length), 0),
    articles: q("article, [role=article]").length,
    paragraphs: q("p").filter((p) => (p.innerText || "").length > 80).length,
    words,
    prices: (text.match(/(?:₹|rs\.?|\$|€|£|inr|usd)\s?\d[\d,]*(?:\.\d+)?/gi) || []).length,
    captcha: document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .cf-turnstile, iframe[src*='challenges.cloudflare'], #px-captcha, [class*='captcha' i]") || /verify you are human|i'?m not a robot|verification required|performing security verification|unusual (traffic|activity)/i.test(text.slice(0, 3000)) ? 1 : 0,
    errorTitle: /\b(404|403|500|not found|page not found|access denied|no such|isn'?t available|unavailable|error)\b/i.test(title) || (words < 80 && /\b(404|not found)\b/i.test(lower)) ? 1 : 0,
    kycHint: has(/\b(kyc|aadhaa?r|pan card|passport|identity (proof|verification)|re-kyc|e-kyc)\b/),
    bankHint: has(/\b(account balance|available balance|a\/c no|ifsc|net ?banking|statement|transactions?|beneficiar)/),
    inboxHint: /\binbox\b/i.test(title) || (has(/\b(inbox|compose|drafts|sent mail|spam)\b/) && has(/\b(from|subject|unread)\b|\d+ unread/)) ? 1 : 0,
    chatHint: has(/\b(type a message|send message|chat|channel|dm|direct message)\b/) && q("textarea, [contenteditable=true], [role=textbox]").length > 0 ? 1 : 0,
    profileHint: has(/\b(followers|following|joined|repositories|posts|connections|about me)\b/) && imgs.some((i) => i.getBoundingClientRect().width >= 120) ? 1 : 0,
    repoHint: has(/\b(commits?|branch(es)?|pull requests?|readme|fork|star|issues)\b/) && has(/\b(code|files?)\b/) ? 1 : 0,
    feedHint: has(/\b(\d+[hm] ago|\d+[hmd]\b|likes?|reposts?|retweets?|comments?|replies|points by|upvotes?)\b/) ? 1 : 0,
  };
}

// Log-space evidence each structural cue adds to a screen class. Written from the
// class definitions, not fitted to the eval pages (see eval/README.md — dev/held-out).
export function screenPriors(f) {
  const p = {};
  const add = (k, v) => (p[k] = (p[k] || 0) + v);
  if (f.captcha) add("error_captcha", 4);
  if (f.errorTitle) add("error_captcha", 3);
  if (f.pw && f.otherFields <= 2) add("login", 3);
  if (!f.pw && f.fields >= 1 && f.fields <= 2 && f.words < 250 && !f.searchValue && !f.urlQuery) add("login", 1);
  if (f.fields >= 4 && (f.pw || f.emailFields)) add("signup_form", 2.5);
  if (f.fields >= 5 && !f.cardFields) add("signup_form", 1);
  if (f.cardFields) add("checkout_payment", 3);
  if (f.kycHint && (f.fileInputs || f.images)) add("kyc_identity", 2.5);
  if (f.bankHint) add("banking", 1.5);
  if (f.inboxHint) add("email_inbox", 3);
  if (f.chatHint) add("chat", 1.5);
  if (f.profileHint) add("profile_page", 1.5);
  if (f.repoHint && f.codeLines >= 5) add("code_repo", 2);
  if (f.codeLines >= 30) add("code_repo", 1.5);
  if ((f.searchValue || f.urlQuery) && f.links >= 10) add("search_results", 2.5);
  if (f.paragraphs >= 6 && f.words >= 500) add("article", 2);
  if (f.prices >= 5 && f.images >= 4) add("product_listing", 3);
  if (f.tableRows >= 15) add("dashboard_table", 2);
  if (f.canvasArea >= 0.08 && !f.mapHint) add("dashboard_table", 1);
  if (f.videoArea >= 0.15) add("video", 3);
  if (f.mapHint || f.canvasArea >= 0.5) add("map", 3);
  if (f.pdfHint) add("document_viewer", 3);
  if (f.feedHint && (f.articles >= 3 || f.roundImages >= 3)) add("social_feed", 2);
  return p;
}

/**
 * Fuse CLIP class probabilities with structural priors: softmax(log p_clip + prior).
 * @param {Array<{id,p}>} clipAll  full CLIP distribution over screen classes
 */
export function fuseScreen(clipAll, features) {
  const prior = features ? screenPriors(features) : {};
  const logits = clipAll.map((c) => ({ id: c.id, l: Math.log(Math.max(c.p, 1e-6)) + (prior[c.id] || 0) }));
  const m = Math.max(...logits.map((x) => x.l));
  const ex = logits.map((x) => ({ id: x.id, e: Math.exp(x.l - m) }));
  const sum = ex.reduce((a, x) => a + x.e, 0);
  const probs = ex.map((x) => ({ id: x.id, p: x.e / sum })).sort((a, b) => b.p - a.p);
  return {
    top: probs[0].id,
    confidence: +probs[0].p.toFixed(3),
    probs: probs.slice(0, 3).map((x) => ({ id: x.id, p: +x.p.toFixed(3) })),
    clipTop: clipAll[0]?.id,
    cues: Object.keys(prior),
  };
}

// ---- trained head (eval/screens_train.mjs) ----------------------------------------
// 10 privacy-relevant categories the head predicts; fine sub-types are refined below.
export const COARSE = ["auth", "form", "search", "reading", "listing", "social", "code", "media", "data", "error"];
export const COARSE_OF = {
  login: "auth",
  signup_form: "form",
  kyc_identity: "form",
  checkout_payment: "form",
  search_results: "search",
  article: "reading",
  document_viewer: "reading",
  product_listing: "listing",
  social_feed: "social",
  profile_page: "social",
  email_inbox: "social",
  chat: "social",
  code_repo: "code",
  video: "media",
  map: "media",
  dashboard_table: "data",
  banking: "data",
  error_captcha: "error",
};
const FEATURE_KEYS = [
  "fields", "pw", "otherFields", "emailFields", "cardFields", "fileInputs", "searchValue", "urlQuery", "links", "images",
  "roundImages", "videoArea", "canvasArea", "mapHint", "pdfHint", "tableRows", "codeLines", "articles", "paragraphs", "words",
  "prices", "captcha", "errorTitle", "kycHint", "bankHint", "inboxHint", "chatHint", "profileHint", "repoHint", "feedHint",
];
/** Structural features -> fixed-length vector (log-scaled counts, scaled to ~[0,1]). */
export function featureVector(f = {}) {
  return FEATURE_KEYS.map((k) => Math.log1p(Math.max(0, Number(f[k]) || 0)) / 4);
}

/**
 * Apply the trained head to [image embedding ; features], then pick the fine
 * sub-type inside the predicted category using the zero-shot+DOM fusion.
 * @param {object} head  screen_head.json
 * @param {Float32Array} emb  L2-normalised image embedding
 * @param {object} features  domScreenFeatures()
 * @param {Array<{id,p}>} clipAll  zero-shot distribution over fine classes
 */
export function classifyScreen(head, emb, features, clipAll) {
  const x = [...emb, ...featureVector(features)];
  const z = head.W.map((w, k) => head.b[k] + w.reduce((a, v, d) => a + v * x[d], 0));
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, v) => a + v, 0);
  const probs = head.classes.map((c, k) => ({ id: c, p: e[k] / s })).sort((a, b) => b.p - a.p);
  const category = probs[0].id;
  const fused = fuseScreen(clipAll, features);
  const inCat = fused.probs.length ? fuseScreen(clipAll.filter((c) => COARSE_OF[c.id] === category), features) : null;
  return {
    category,
    categoryConfidence: +probs[0].p.toFixed(3),
    state: inCat?.top ?? fused.top,
    confidence: +probs[0].p.toFixed(3),
    probs: probs.slice(0, 3).map((x) => ({ id: x.id, p: +x.p.toFixed(3) })),
  };
}
