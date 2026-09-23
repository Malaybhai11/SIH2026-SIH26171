// Precompute MobileCLIP-S0 text embeddings for every zero-shot label prompt, so the
// client ships only the 23 MB image tower (the 170 MB text tower never leaves the
// build machine). Re-run after editing prompts:
//
//   node scripts/fetch_models.mjs --dev && node scripts/build_clip_labels.mjs
//
// Output: extension/models/clip_labels.json

import { AutoTokenizer, CLIPTextModelWithProjection, env } from "@huggingface/transformers";
import { writeFile } from "node:fs/promises";

env.localModelPath = process.cwd() + "/extension/models/";
env.allowRemoteModels = false;

// Several prompts per class; the classifier max-pools over them.
// `sensitive: true` region classes are black-boxed on the screenshot.
const SETS = {
  screen: [
    ["login", ["a screenshot of a login page with username and password fields", "a sign in web page", "a website login form with a password box"]],
    ["signup_form", ["a screenshot of a registration form web page with many input fields", "a web form to fill in personal details", "an online application form"]],
    ["kyc_identity", ["a screenshot of an identity verification page with an ID card image", "a KYC web page asking to upload Aadhaar or PAN card", "a web page showing a scanned identity document"]],
    ["checkout_payment", ["a screenshot of a checkout page with credit card payment fields", "an online payment page", "a shopping cart checkout web page"]],
    ["banking", ["a screenshot of an internet banking dashboard with account balance", "a bank account statement web page with transactions", "a netbanking website"]],
    ["email_inbox", ["a screenshot of an email inbox", "a web mail client showing a list of emails", "a gmail inbox page"]],
    ["social_feed", ["a screenshot of a social media feed with posts", "a twitter timeline", "a news feed of posts with profile pictures"]],
    ["profile_page", ["a screenshot of a user profile page with a profile photo", "a social network profile page", "a personal profile web page"]],
    ["search_results", ["a screenshot of search engine results", "a google search results page", "a list of web search results"]],
    ["article", ["a screenshot of a news article web page", "a wikipedia article", "a blog post with paragraphs of text"]],
    ["product_listing", ["a screenshot of an online shopping website with product photos and prices", "an e-commerce product page", "a grid of products for sale"]],
    ["dashboard_table", ["a screenshot of an analytics dashboard with charts", "a web page with a large data table", "an admin panel with graphs"]],
    ["video", ["a screenshot of a video streaming website", "a youtube video page", "a web video player"]],
    ["map", ["a screenshot of an online map", "google maps web page"]],
    ["document_viewer", ["a screenshot of a PDF document viewer", "a scanned document open in a browser"]],
    ["chat", ["a screenshot of a chat messaging web app", "whatsapp web conversation", "a customer support chat window"]],
    ["code_repo", ["a screenshot of a github code repository page", "source code in a web page"]],
    ["error_captcha", ["a screenshot of a captcha verification page", "a web page error 404 not found", "an access denied error page"]],
  ],
  region: [
    ["face_photo", ["a photo of a person's face", "a close-up portrait photo", "a profile picture of a person", "a selfie", "a passport size photo of a person"], true],
    ["people_photo", ["a photo of a group of people", "a photo of a person standing"], true],
    ["id_card", ["an Aadhaar card", "a PAN card", "a photo of an identity card with a photo and text", "a driving licence card", "a passport data page", "a government issued ID card"], true],
    ["bank_card", ["a photo of a credit card", "a debit card with card number"], true],
    ["signature", ["a handwritten signature", "a scanned signature in ink on white paper", "a cursive autograph written with a pen", "handwritten name in cursive"], true],
    ["qr_code", ["a QR code", "a black and white square QR code"], true],
    ["document_scan", ["a scanned paper document with printed text", "a photo of a form filled by hand", "a bank cheque"], true],
    ["chart", ["a bar chart with axes", "a pie chart", "a line chart with axes and labels", "a data visualization dashboard"]],
    ["logo", ["a company logo", "an app icon", "a brand logo on a plain background"]],
    ["product", ["a product photo on white background", "a photo of shoes", "a photo of a smartphone", "a photo of clothes"]],
    ["scenery", ["a landscape photo", "a photo of a city", "a photo of nature", "a photo of a building"]],
    ["space", ["a photo of a rocket launch", "a satellite image of earth", "a photo of the moon or planets"]],
    ["map", ["a map", "a satellite map view"]],
    ["ui_graphic", ["a user interface icon", "a banner advertisement with text", "an illustration", "a screenshot of text"]],
    ["food", ["a photo of food"]],
    ["vehicle", ["a photo of a car", "a photo of a vehicle"]],
    ["animal", ["a photo of an animal", "a photo of a dog or cat"]],
  ],
};

const id = "Xenova/mobileclip_s0";
const tokenizer = await AutoTokenizer.from_pretrained(id);
const model = await CLIPTextModelWithProjection.from_pretrained(id, { dtype: "fp32" });

const out = { model: id, logitScale: 100, sets: {} };
for (const [name, classes] of Object.entries(SETS)) {
  const list = [];
  for (const [cid, prompts, sensitive] of classes) {
    const inputs = tokenizer(prompts, { padding: "max_length", truncation: true, max_length: 77 });
    const { text_embeds } = await model(inputs);
    const D = text_embeds.dims[1];
    for (let p = 0; p < prompts.length; p++) {
      const v = Array.from(text_embeds.data.slice(p * D, (p + 1) * D));
      const n = Math.hypot(...v);
      list.push({ id: cid, prompt: prompts[p], sensitive: !!sensitive, emb: v.map((x) => +(x / n).toFixed(5)) });
    }
  }
  out.sets[name] = { classes: list, sensitive: classes.filter((c) => c[2]).map((c) => c[0]) };
  console.log(`${name}: ${classes.length} classes, ${list.length} prompts`);
}
await writeFile("extension/models/clip_labels.json", JSON.stringify(out));
console.log("wrote extension/models/clip_labels.json");
