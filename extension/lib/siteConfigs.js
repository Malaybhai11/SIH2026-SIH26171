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

  generic: {
    id: "generic",
    hostPatterns: [],
    itemSelector:
      'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], article, [role="article"], li, h1, h2, h3, p',
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
