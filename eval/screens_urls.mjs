// URL list for the screen-state dataset: [label, url]. Labels are by URL intent and
// are VERIFIED against the capture afterwards (bot-check walls served to a headless
// browser are relabelled error_captcha, unusable captures dropped) — see
// eval/screens_train.mjs and eval/results/screens_labels.json.

const S = process.env.SERVER || "http://localhost:8000";
const q = ["isro", "chandrayaan 3", "navic gps", "satellite imagery", "gaganyaan", "webgpu", "onnx runtime", "monsoon forecast"];
const enc = encodeURIComponent;

export const URLS = [
  // login
  ...["https://github.com/login", "https://www.linkedin.com/login", "https://stackoverflow.com/users/login", "https://www.reddit.com/login/",
    "https://discord.com/login", "https://www.dropbox.com/login", "https://id.atlassian.com/login", "https://www.netflix.com/login",
    "https://www.instagram.com/accounts/login/", "https://www.twitch.tv/login", "https://www.pinterest.com/login/", "https://www.canva.com/login",
    "https://trello.com/login", "https://app.slack.com/signin", "https://login.yahoo.com/", "https://www.tumblr.com/login",
    "https://www.figma.com/login", "https://www.notion.so/login", "https://account.proton.me/login", "https://www.hackerrank.com/auth/login",
    "https://leetcode.com/accounts/login/", "https://www.coursera.org/?authMode=login", "https://www.udemy.com/join/login-popup/",
    "https://www.quora.com/", "https://auth.openai.com/log-in", "https://www.saucedemo.com/", "https://parabank.parasoft.com/parabank/index.htm",
    "https://practicetestautomation.com/practice-test-login/", "https://the-internet.herokuapp.com/login", "https://web.libera.chat/"].map((u) => ["login", u]),
  // signup
  ...["https://github.com/signup", "https://gitlab.com/users/sign_up", "https://www.reddit.com/register/", "https://www.duolingo.com/register",
    "https://signup.heroku.com/", "https://www.twitch.tv/signup", "https://www.notion.so/signup", "https://www.figma.com/signup",
    "https://www.hackerrank.com/auth/signup", "https://leetcode.com/accounts/signup/", "https://parabank.parasoft.com/parabank/register.htm",
    "https://demoqa.com/automation-practice-form", "https://www.w3schools.com/howto/tryit.asp?filename=tryhow_css_register_form",
    "https://formy-project.herokuapp.com/form", "https://practice.expandtesting.com/register", "https://www.mozilla.org/en-US/firefox/accounts/",
    "https://accounts.spotify.com/en/signup", "https://www.pinterest.com/", `${S}/demo/register.html`].map((u) => ["signup_form", u]),
  // search results
  ...q.slice(0, 5).map((x) => ["search_results", `https://html.duckduckgo.com/html/?q=${enc(x)}`]),
  ...q.slice(2, 6).map((x) => ["search_results", `https://www.bing.com/search?q=${enc(x)}`]),
  ...q.slice(0, 3).map((x) => ["search_results", `https://search.brave.com/search?q=${enc(x)}`]),
  ...q.slice(3, 6).map((x) => ["search_results", `https://en.wikipedia.org/w/index.php?search=${enc(x)}&fulltext=1&ns0=1`]),
  ...q.slice(4, 7).map((x) => ["search_results", `https://github.com/search?q=${enc(x)}&type=repositories`]),
  ...q.slice(0, 2).map((x) => ["search_results", `https://www.ecosia.org/search?q=${enc(x)}`]),
  ...q.slice(5, 8).map((x) => ["search_results", `https://stackoverflow.com/search?q=${enc(x)}`]),
  // articles
  ...Array.from({ length: 10 }, () => ["article", "https://en.wikipedia.org/wiki/Special:Random"]),
  ...["https://en.wikipedia.org/wiki/Indian_Space_Research_Organisation", "https://en.wikipedia.org/wiki/Aryabhata_(satellite)", "https://en.wikipedia.org/wiki/Vikram_Sarabhai",
    "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API", "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas",
    "https://docs.python.org/3/tutorial/introduction.html", "https://docs.python.org/3/library/json.html", "https://arxiv.org/abs/2311.17049",
    "https://arxiv.org/abs/1706.03762", "https://www.gutenberg.org/files/1342/1342-h/1342-h.htm", "https://www.britannica.com/topic/Indian-Space-Research-Organisation",
    "https://go.dev/doc/effective_go", "https://www.rust-lang.org/learn", "https://en.wikipedia.org/wiki/Web_browser"].map((u) => ["article", u]),
  // product listings
  ...["headphones", "laptop", "saree", "cricket bat", "watch"].map((x) => ["product_listing", `https://www.ebay.com/sch/i.html?_nkw=${enc(x)}`]),
  ...["smartphone", "shoes", "television", "kurta"].map((x) => ["product_listing", `https://www.flipkart.com/search?q=${enc(x)}`]),
  ...["shoes", "backpack", "mixer grinder"].map((x) => ["product_listing", `https://www.snapdeal.com/search?keyword=${enc(x)}`]),
  ...["https://books.toscrape.com/", "https://books.toscrape.com/catalogue/category/books/science_22/index.html", "https://scrapeme.live/shop/",
    "https://www.ikea.com/in/en/cat/chairs-fu002/", "https://www.ikea.com/in/en/cat/lamps-li002/", "https://webscraper.io/test-sites/e-commerce/allinone/computers/laptops",
    "https://www.saucedemo.com/inventory.html", "https://magento.softwaretestingboard.com/women/tops-women.html", "https://demo.opencart.com/index.php?route=product/category&path=20",
    "https://www.decathlon.in/sports/running"].map((u) => ["product_listing", u]),
  // code
  ...["microsoft/onnxruntime", "huggingface/transformers.js", "opencv/opencv", "onnx/onnx", "facebook/react", "python/cpython", "rust-lang/rust",
    "tensorflow/tfjs", "ggerganov/llama.cpp", "denoland/deno"].map((r) => ["code_repo", `https://github.com/${r}`]),
  ...["torvalds/linux/blob/master/kernel/sched/core.c", "python/cpython/blob/main/Lib/json/decoder.py", "onnx/onnx/blob/main/onnx/checker.py",
    "microsoft/onnxruntime/blob/main/js/web/lib/index.ts"].map((r) => ["code_repo", `https://github.com/${r}`]),
  ...["https://gitlab.com/gitlab-org/gitlab-runner", "https://gitlab.com/inkscape/inkscape", "https://codeberg.org/forgejo/forgejo", "https://git.sr.ht/~sircmpwn/scdoc/tree"].map((u) => ["code_repo", u]),
  // video
  ...["https://vimeo.com/76979871", "https://vimeo.com/1084537", "https://vimeo.com/22439234", "https://archive.org/details/BigBuckBunny_124",
    "https://archive.org/details/night_of_the_living_dead", "https://archive.org/details/Sita_Sings_the_Blues", "https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity",
    "https://www.ted.com/talks/brene_brown_the_power_of_vulnerability", "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://www.youtube.com/watch?v=21X5lGlDOfg",
    "https://www.dailymotion.com/video/x8j2ldb", "https://peertube.tv/w/9c9de5e8-0a1e-484a-b099-e80766180a6d"].map((u) => ["video", u]),
  // maps
  ...[[23.02, 72.57], [12.97, 77.59], [28.61, 77.2], [19.07, 72.87], [13.08, 80.27], [22.57, 88.36], [48.85, 2.35], [40.71, -74.0]].map(([a, b]) => ["map", `https://www.openstreetmap.org/#map=12/${a}/${b}`]),
  ...["https://www.bing.com/maps?cp=19.07~72.87&lvl=11", "https://www.bing.com/maps?cp=28.61~77.20&lvl=12", "https://wego.here.com/?map=28.61,77.20,12",
    "https://wego.here.com/?map=12.97,77.59,12", "https://opentopomap.org/#map=12/30.73/79.07"].map((u) => ["map", u]),
  // dashboards / tables
  ...["https://www.worldometers.info/world-population/population-by-country/", "https://www.worldometers.info/co2-emissions/", "https://coinmarketcap.com/",
    "https://www.coingecko.com/", "https://www.x-rates.com/table/?from=INR&amount=1", "https://www.x-rates.com/table/?from=USD&amount=1",
    "https://play.grafana.org/d/000000012/grafana-play-home", "https://finance.yahoo.com/markets/stocks/most-active/", "https://www.speedtest.net/global-index",
    "https://ourworldindata.org/grapher/population", "https://datatables.net/examples/basic_init/zero_configuration.html", "https://www.w3schools.com/html/html_tables.asp"].map((u) => ["dashboard_table", u]),
  // errors / captcha walls
  ...["https://github.com/this-page-does-not-exist-26171", "https://en.wikipedia.org/wiki/Special:Nonexistent_page_26171", "https://www.google.com/recaptcha/api2/demo",
    "https://httpstat.us/404", "https://stackoverflow.com/questions/0", "https://www.bbc.com/nonexistent-page-26171", "https://developer.mozilla.org/en-US/docs/Nope_26171",
    "https://www.python.org/nope-26171", "https://gitlab.com/nope-26171/nope", "https://www.ikea.com/in/en/nope-26171", "https://www.reddit.com/r/nope26171nope/",
    "https://www.apple.com/nope-26171", "https://www.nasa.gov/nope-26171", "https://www.isro.gov.in/nope26171.html", "https://www.amazon.in/s?k=phone"].map((u) => ["error_captcha", u]),
  // documents
  ...["https://arxiv.org/pdf/2311.17049", "https://arxiv.org/pdf/1706.03762", "https://arxiv.org/pdf/2010.11929", "https://arxiv.org/pdf/2103.00020",
    "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "https://www.africau.edu/images/default/sample.pdf",
    "https://pdfobject.com/pdf/sample.pdf", "https://arxiv.org/pdf/1512.03385"].map((u) => ["document_viewer", u]),
  // profiles
  ...["torvalds", "gaearon", "xenova", "karpathy", "sindresorhus", "tj"].map((u) => ["profile_page", `https://github.com/${u}`]),
  ...["https://huggingface.co/Xenova", "https://huggingface.co/apple", "https://mastodon.social/@Gargron", "https://mastodon.social/@mastodonusercount",
    "https://dev.to/ben", "https://stackoverflow.com/users/22656/jon-skeet", "https://www.kaggle.com/alexisbcook"].map((u) => ["profile_page", u]),
  // feeds
  ...["https://news.ycombinator.com/", "https://news.ycombinator.com/newest", "https://news.ycombinator.com/show", "https://lobste.rs/", "https://lobste.rs/newest",
    "https://mastodon.social/explore", "https://mastodon.social/tags/space", "https://mastodon.social/tags/india", "https://old.reddit.com/r/space/",
    "https://old.reddit.com/r/ISRO/", "https://dev.to/", "https://bsky.app/", "https://tildes.net/"].map((u) => ["social_feed", u]),
  // private-type screens (synthetic demo sites + public demo apps)
  ["kyc_identity", `${S}/demo/kyc.html`],
  ["email_inbox", `${S}/demo/inbox.html`],
  ["email_inbox", "https://www.mailinator.com/v4/public/inboxes.jsp?to=test"],
  ["email_inbox", "https://www.mailinator.com/v4/public/inboxes.jsp?to=demo"],
  ["checkout_payment", `${S}/demo/checkout.html`],
  ["checkout_payment", "https://checkout.stripe.dev/"],
  ["social_feed", `${S}/demo/social.html`],
  // Indian public-service and consumer sites (A2: the classifier is trained almost
  // entirely on global consumer/dev sites above — govt e-service portals in
  // particular have a distinct visual language: bilingual headers, official
  // emblems, dense tables, and (genuinely) very heavy CAPTCHA/bot-check use, which
  // is exactly the "error_captcha" category this classifier most needs to get
  // right without over-firing on ordinary forms. Public landing/login pages only —
  // no authentication, no scraping past the login wall.
  ...["https://www.irctc.co.in/nget/train-search", "https://parivahan.gov.in/parivahan/", "https://www.india.gov.in/",
    "https://www.mygov.in/"].map((u) => ["article", u]),
  ...["https://digilocker.gov.in/", "https://www.incometax.gov.in/iec/foportal/", "https://www.gst.gov.in/",
    "https://uidai.gov.in/my-aadhaar/get-aadhaar.html", "https://www.epfindia.gov.in/site_en/index.php",
    "https://www.onlinesbi.sbi/", "https://www.icicibank.com/", "https://www.hdfcbank.com/",
    "https://www.indiapost.gov.in/", "https://www.passportindia.gov.in/AppOnlineProject/welcomeLink"].map((u) => ["login", u]),
  ...["https://www.flipkart.com/", "https://www.myntra.com/", "https://www.bigbasket.com/",
    "https://www.paytm.com/", "https://www.airindia.com/", "https://www.makemytrip.com/"].map((u) => ["product_listing", u]),
  ...["https://data.gov.in/", "https://www.rbi.org.in/Scripts/BS_ViewMasCirculardetails.aspx",
    "https://www.nseindia.com/", "https://www.bseindia.com/"].map((u) => ["dashboard_table", u]),
];
