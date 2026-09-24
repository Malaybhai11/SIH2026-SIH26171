// Pluggable per-site extraction hints. Known sites get precise selectors; everything
// else falls back to `generic`. Keeping these isolated here means a DOM change on a
// target site is a one-line fix (PRD risk table).

export const SITE_CONFIGS = {
  "x.com": {
    id: "x.com",
    hostPatterns: [/(^|\.)x\.com$/i, /(^|\.)twitter\.com$/i],
    itemSelector: 'article[data-testid="tweet"]',
    fields: {
      text: 'div[data-testid="tweetText"]',
      author: 'div[data-testid="User-Name"] a[role="link"]',
      timestamp: "time",
      href: 'a[href*="/status/"]',
    },
    metrics: {
      likes: 'button[data-testid="like"]',
      reposts: 'button[data-testid="retweet"]',
    },
    dedupeKey: "href",
    role: "article",
  },

  "news.ycombinator.com": {
    id: "news.ycombinator.com",
    hostPatterns: [/(^|\.)news\.ycombinator\.com$/i],
    itemSelector: "tr.athing",
    fields: {
      text: "span.titleline > a",
      href: "span.titleline > a",
    },
    // score/age live in the sibling <tr>; handled specially in the extractor
    siblingMeta: {
      score: "span.score",
      age: "span.age",
    },
    dedupeKey: "href",
    role: "article",
  },

  "en.wikipedia.org": {
    id: "en.wikipedia.org",
    hostPatterns: [/(^|\.)wikipedia\.org$/i],
    itemSelector: "#mw-content-text p, #mw-content-text h2, #mw-content-text h3, #mw-content-text li",
    fields: {},
    dedupeKey: "id",
    role: "paragraph",
  },

  "linkedin.com": {
    id: "linkedin.com",
    hostPatterns: [/(^|\.)linkedin\.com$/i],
    // LinkedIn doesn't expose stable test ids like x.com, and its markup shifts
    // often — several historically-seen hooks are OR'd together here rather than
    // betting on just one. If ALL of these go stale at once, content.js's
    // generic-selector fallback (triggered when a site config matches zero
    // elements) still keeps the page usable instead of silently returning empty.
    itemSelector:
      'div[data-urn], div[data-id^="urn:li:activity"], div.feed-shared-update-v2, div.occludable-update, article',
    fields: {
      text: ".update-components-text, .feed-shared-update-v2__description, span[dir='ltr']",
      href: "a.app-aware-link",
    },
    dedupeKey: "id", // data-urn isn't reliably exposed as a plain href; fall back to node id
    role: "article",
  },

  generic: {
    id: "generic",
    hostPatterns: [],
    // [contenteditable] matters more than it looks: most chat/rich-text composers
    // (ChatGPT included) are a contenteditable div, not an <input>/<textarea> — miss
    // it and the agent has no real text field to target at all.
    // `img` is a last-resort hook so a standalone image (e.g. inside an article)
    // is directly targetable for save_image, not just reachable as a descendant.
    // Toasts, alerts, notifications, and form validation messages are explicitly included
    // so the agent can see floating toasts, error states, and live system feedback.
    itemSelector:
      'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="alert"], [role="status"], [role="alertdialog"], [role="dialog"], [aria-live], article, [role="article"], li, h1, h2, h3, p, [contenteditable="true"], [contenteditable=""], img, [data-sonner-toast], [data-radix-toast-content], .toast, .toaster, .alert, .notification, [class*="toast" i], [class*="alert" i], [class*="notification" i], [class*="snackbar" i], [class*="banner" i], [data-testid*="toast" i], [data-testid*="alert" i], [data-testid*="error" i], [class*="error-message" i], [class*="invalid-feedback" i], [class*="text-destructive" i], [data-error], [data-invalid]',
    fields: {},
    dedupeKey: "id",
    role: null,
  },
};

export function resolveSiteConfig(hostname = "") {
  for (const cfg of Object.values(SITE_CONFIGS)) {
    if (cfg.hostPatterns.some((re) => re.test(hostname))) return cfg;
  }
  return SITE_CONFIGS.generic;
}

export function getSiteConfigById(id) {
  return SITE_CONFIGS[id] ?? SITE_CONFIGS.generic;
}
