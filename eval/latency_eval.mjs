// Client resource use + latency (criteria 4 and 5), through the real extension.
//
//   node eval/latency_eval.mjs [--rounds 3]
//
// For each perception mode: cold start (first page, models loading), then warm
// per-step perception on every demo page (fresh frames, then an unchanged frame to
// show the cache), engine memory (WASM + weights) and model bytes. Task wall-clock
// latency comes from eval/results/e2e_*.json (eval/task_e2e.mjs).

import { launch, openPage, tabIdFor, preview } from "./e2e_harness.mjs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://localhost:8000";
const PAGES = ["kyc", "inbox", "social", "checkout", "register"];
const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1]) || 3;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const out = { generatedAt: new Date().toISOString(), machine: `${(await import("node:os")).cpus()[0].model} x${(await import("node:os")).cpus().length}, no GPU (WASM backend)`, modes: {} };
for (const mode of ["eco", "balanced"]) {
  const { browser, ctl } = await launch();
  const call = (op) => ctl.evaluate((op) => chrome.runtime.sendMessage({ target: "perception", op, payload: {} }), op);
  const r = { cold: null, warm: [], cached: [], stages: [] };
  for (let k = 0; k < rounds; k++) {
    for (const name of PAGES) {
      const url = `${SERVER}/demo/${name}.html?r=${k}`;
      const page = await openPage(browser, url);
      const tabId = await tabIdFor(ctl, url);
      const a = await preview(ctl, tabId, mode);
      if (!r.cold) r.cold = a.timings.perceptionTotalMs;
      else r.warm.push(a.timings.perceptionTotalMs);
      r.stages.push(a.timings);
      const b = await preview(ctl, tabId, mode); // unchanged frame
      r.cached.push(b.timings.perceptionTotalMs);
      await page.close();
    }
  }
  const stats = (await call("stats"))?.result;
  const mem = (await call("memory"))?.result;
  const avg = (k) => Math.round(r.stages.slice(1).reduce((a, t) => a + (t[k] || 0), 0) / Math.max(1, r.stages.length - 1));
  out.modes[mode] = {
    coldStartMs: r.cold,
    warmStepMs: { median: pct(r.warm, 50), p90: pct(r.warm, 90), n: r.warm.length },
    unchangedFrameMs: { median: pct(r.cached, 50), p90: pct(r.cached, 90) },
    avgStageMs: { domAndText: avg("domAndTextMs"), textPiiNer: avg("pixelNerMs"), vision: avg("analyzeMs"), paint: avg("redactMs") },
    modelsLoaded: Object.fromEntries(Object.entries(stats?.models || {}).map(([k, v]) => [k, { MB: +(v.bytes / 1e6).toFixed(1), loadMs: v.loadMs }])),
    modelMB: stats?.modelMB,
    engineMemoryMB: mem?.totalMB,
    memoryMethod: mem?.method,
    backend: stats?.ep,
    threads: stats?.threads,
  };
  console.log(mode, JSON.stringify(out.modes[mode]));
  await browser.close();
}
// end-to-end task latency from the task runs
const e2e = {};
for (const f of (await readdir("eval/results")).filter((x) => x.startsWith("e2e_"))) {
  const j = JSON.parse(await readFile(`eval/results/${f}`, "utf8"));
  const steps = j.steps || [];
  e2e[j.task] = {
    passed: j.passed, wallMs: j.wallMs, steps: steps.length,
    avgServerMs: steps.length ? Math.round(steps.reduce((a, s) => a + (s.serverMs || 0), 0) / steps.length) : null,
    avgPerceptionMs: steps.length ? Math.round(steps.reduce((a, s) => a + (s.perceptionMs || 0), 0) / steps.length) : null,
    leaks: j.leakCheck?.leaked?.length ?? null,
  };
}
out.e2eTasks = e2e;
await mkdir("eval/results", { recursive: true });
await writeFile("eval/results/latency.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(e2e, null, 1));
