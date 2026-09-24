// Build script for the extension.
//
//   node build.mjs                    -> dist/          (Chrome / Edge / Brave, MV3)
//   node build.mjs --target firefox   -> dist-firefox/  (Firefox 128+, MV3)
//   node build.mjs --watch
//
// Entry points:
//   background.js  ESM   (Chrome: service worker; Firefox: background page that also
//                         hosts the perception engine — Firefox has no offscreen API)
//   offscreen.js   ESM   (Chrome only: hosts the perception engine; WebGPU/WASM)
//   content.js     IIFE  (content scripts cannot be ESM via manifest)
//   popup.js       IIFE
//
// Static: models/ (ONNX + label embeddings, fetched by scripts/fetch_models.mjs) and
// the onnxruntime-web WASM runtime under ort/ — everything local, nothing from a CDN.

import * as esbuild from "esbuild";
import { cp, mkdir, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = "extension";
const argTarget = process.argv.indexOf("--target");
const TARGET = argTarget > 0 ? process.argv[argTarget + 1] : "chrome";
const FIREFOX = TARGET === "firefox";
const OUT = FIREFOX ? "dist-firefox" : "dist";
const watch = process.argv.includes("--watch");

const entries = [
  { in: `${SRC}/background.js`, out: `${OUT}/background.js`, format: "esm" },
  { in: `${SRC}/content.js`, out: `${OUT}/content.js`, format: "iife" },
  { in: `${SRC}/popup.js`, out: `${OUT}/popup.js`, format: "iife" },
];
if (!FIREFOX) entries.push({ in: `${SRC}/offscreen.js`, out: `${OUT}/offscreen.js`, format: "esm" });

const staticFiles = ["popup.html", "popup.css", "dashboard.html", "dashboard.js", ...(FIREFOX ? [] : ["offscreen.html"])];

// Shipped models only (dev-only files like the CLIP text tower stay behind).
const SHIP_MODELS = [
  "clip_labels.json",
  "yunet/face_detection_yunet_2023mar.onnx",
  "Xenova/mobileclip_s0/onnx/vision_model_fp16.onnx",
  "onnx-community/bert-small-pii-detection-ONNX/onnx/model_quantized.onnx",
  "onnx-community/bert-small-pii-detection-ONNX/tokenizer.json",
  "onnx-community/bert-small-pii-detection-ONNX/config.json",
];
// onnxruntime-web/webgpu bundle loads this runtime (WebGPU EP + WASM CPU EP).
const ORT_FILES = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"];

async function manifest() {
  const m = JSON.parse(await readFile(path.join(SRC, "manifest.json"), "utf8"));
  if (FIREFOX) {
    m.background = { scripts: ["background.js"], type: "module" };
    m.permissions = m.permissions.filter((p) => p !== "offscreen");
    delete m.cross_origin_embedder_policy;
    delete m.cross_origin_opener_policy;
    delete m.minimum_chrome_version;
    m.browser_specific_settings = { gecko: { id: "aavaran@sih26171.local", strict_min_version: "128.0" } };
  }
  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(m, null, 2));
}

async function copyStatic() {
  await mkdir(OUT, { recursive: true });
  for (const f of staticFiles) {
    const from = path.join(SRC, f);
    if (existsSync(from)) await cp(from, path.join(OUT, f));
  }
  await manifest();
  const missing = [];
  for (const f of SHIP_MODELS) {
    const from = path.join(SRC, "models", f);
    if (!existsSync(from)) {
      missing.push(f);
      continue;
    }
    await mkdir(path.dirname(path.join(OUT, "models", f)), { recursive: true });
    await cp(from, path.join(OUT, "models", f));
  }
  if (missing.length) console.warn(`[build] missing models (run: node scripts/fetch_models.mjs):\n  ${missing.join("\n  ")}`);
  await mkdir(path.join(OUT, "ort"), { recursive: true });
  for (const f of ORT_FILES) await cp(path.join("node_modules/onnxruntime-web/dist", f), path.join(OUT, "ort", f));
}

// Firefox: swap the offscreen-backed perception host for the in-process one.
const firefoxHostPlugin = {
  name: "perception-host",
  setup(build) {
    build.onResolve({ filter: /perceptionHost\.js$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/perceptionHost\.js$/, "perceptionHost.firefox.js")),
    }));
  },
};

const commonOptions = {
  bundle: true,
  target: FIREFOX ? ["firefox128"] : ["chrome116"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  plugins: FIREFOX ? [firefoxHostPlugin] : [],
};

async function sizeReport() {
  let total = 0;
  const walk = async (d) => {
    for (const f of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`[build] ${OUT}/ total ${(total / 1e6).toFixed(1)} MB`);
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await copyStatic();
  if (watch) {
    for (const e of entries) {
      const ctx = await esbuild.context({ ...commonOptions, entryPoints: [e.in], outfile: e.out, format: e.format });
      await ctx.watch();
    }
    console.log("[build] watching for changes...");
    return;
  }
  await Promise.all(entries.map((e) => esbuild.build({ ...commonOptions, entryPoints: [e.in], outfile: e.out, format: e.format })));
  await sizeReport();
  console.log(`[build] wrote ${OUT}/ — load it unpacked (${FIREFOX ? "about:debugging → This Firefox → Load Temporary Add-on → manifest.json" : "chrome://extensions → Load unpacked"})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
