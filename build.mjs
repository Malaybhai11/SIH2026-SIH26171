// Build script for the Chrome extension.
//
// Bundles the three entry points and copies static assets into dist/.
// - background.js  -> ESM  (MV3 service worker, "type": "module")
// - content.js     -> IIFE (content scripts cannot be ESM via manifest)
// - popup.js       -> IIFE
//
// onnxruntime-web is marked external: the vision pipeline dynamically imports it
// and falls back to mock mode when it is absent, so the build never depends on it.

import * as esbuild from "esbuild";
import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = "extension";
const OUT = "dist";
const watch = process.argv.includes("--watch");

const entries = [
  { in: `${SRC}/background.js`, out: `${OUT}/background.js`, format: "esm" },
  { in: `${SRC}/content.js`, out: `${OUT}/content.js`, format: "iife" },
  { in: `${SRC}/popup.js`, out: `${OUT}/popup.js`, format: "iife" },
];

const staticFiles = ["manifest.json", "popup.html", "popup.css", "dashboard.html"];

async function copyStatic() {
  await mkdir(OUT, { recursive: true });
  for (const f of staticFiles) {
    const from = path.join(SRC, f);
    if (existsSync(from)) await cp(from, path.join(OUT, f));
  }
  // Models directory (ONNX + wasm). Ships empty in git; drop real files in to enable.
  const modelsDir = path.join(SRC, "models");
  if (existsSync(modelsDir)) {
    await mkdir(path.join(OUT, "models"), { recursive: true });
    for (const f of await readdir(modelsDir)) {
      await cp(path.join(modelsDir, f), path.join(OUT, "models", f));
    }
  }
}

const commonOptions = {
  bundle: true,
  target: ["chrome116"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  external: ["onnxruntime-web", "onnxruntime-web/webgpu"],
  logLevel: "info",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
};

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await copyStatic();

  if (watch) {
    for (const e of entries) {
      const ctx = await esbuild.context({
        ...commonOptions,
        entryPoints: [e.in],
        outfile: e.out,
        format: e.format,
      });
      await ctx.watch();
    }
    console.log("[build] watching for changes...");
  } else {
    await Promise.all(
      entries.map((e) =>
        esbuild.build({
          ...commonOptions,
          entryPoints: [e.in],
          outfile: e.out,
          format: e.format,
        }),
      ),
    );
    console.log(`[build] wrote ${OUT}/ — load it as an unpacked extension in chrome://extensions`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
