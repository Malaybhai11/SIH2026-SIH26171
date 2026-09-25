// Collects eval/results/*.json into one scorecard mapped to the five SIH criteria.
//
//   npm run eval:summary      -> eval/results/SUMMARY.md (+ summary.json)
//
// Each number is produced by a script in eval/ running the SHIPPED code; see
// eval/README.md for how to reproduce each one.

import { readFile, writeFile } from "node:fs/promises";

const j = async (f) => JSON.parse(await readFile(`eval/results/${f}`, "utf8").catch(() => "null"));
const [pii, faces, red, screens, lat] = await Promise.all(["pii.json", "faces.json", "redaction.json", "screens.json", "latency.json"].map(j));
const tasks = lat?.e2eTasks ?? {};

const s = {
  criterion1_visualContext: screens && {
    screenCategoryAccuracy_unseenSites: screens.accuracy.clipPlusDomPriors,
    zeroShotClipOnly: screens.accuracy.zeroShotClip,
    protocol: screens.protocol,
  },
  criterion2_piiDetection: pii && {
    indian: { recall: pii.indian_synthetic.rulesPlusNer.recall, precision: pii.indian_synthetic.rulesPlusNer.precision, f1: pii.indian_synthetic.rulesPlusNer.f1 },
    ai4privacy: { recall: pii.ai4privacy_en.rulesPlusNer.recall, precision: pii.ai4privacy_en.rulesPlusNer.precision, f1: pii.ai4privacy_en.rulesPlusNer.f1 },
    hindi_devanagari: pii.hindi_synthetic && { recall: pii.hindi_synthetic.rulesOnly.recall, precision: pii.hindi_synthetic.rulesOnly.precision, f1: pii.hindi_synthetic.rulesOnly.f1, note: "rules-only, no Hindi NER model — see pii.json" },
    faces_widerVal: faces && { precision: faces.precision, recall: faces.recall },
  },
  criterion3_redactionPrecision: red && red.aggregate,
  criterion4_clientResources: lat && Object.fromEntries(Object.entries(lat.modes).map(([m, v]) => [m, { engineMemoryMB: v.engineMemoryMB, modelMB: v.modelMB, warmStepMedianMs: v.warmStepMs.median, warmStepP90Ms: v.warmStepMs.p90, unchangedFrameMs: v.unchangedFrameMs.median, coldStartMs: v.coldStartMs }])),
  criterion5_endToEnd: tasks,
};

const md = `# Aavaran — evaluation scorecard

Generated ${new Date().toISOString().slice(0, 10)} from \`eval/results/*.json\`. Machine: ${lat?.machine ?? "n/a"}.

| SIH criterion | Metric | Result |
|---|---|---|
| 1. Visual context accuracy (25%) | Screen category, **unseen websites** (${screens?.protocol ?? ""}) | **${pctf(screens?.accuracy.clipPlusDomPriors)}** (pixels-only zero-shot: ${pctf(screens?.accuracy.zeroShotClip)}) |
| 2. PII detection (20%) | Indian PII set — recall / precision / F1 | **${pii?.indian_synthetic.rulesPlusNer.recall} / ${pii?.indian_synthetic.rulesPlusNer.precision} / ${pii?.indian_synthetic.rulesPlusNer.f1}** |
| | ai4privacy (public, English) — recall / precision / F1 | ${pii?.ai4privacy_en.rulesPlusNer.recall} / ${pii?.ai4privacy_en.rulesPlusNer.precision} / ${pii?.ai4privacy_en.rulesPlusNer.f1} |
| | Hindi/Devanagari set, rules only (no Hindi NER) — recall / precision / F1 | ${pii?.hindi_synthetic?.rulesOnly.recall ?? "n/a"} / ${pii?.hindi_synthetic?.rulesOnly.precision ?? "n/a"} / ${pii?.hindi_synthetic?.rulesOnly.f1 ?? "n/a"} |
| | Faces, WIDER FACE val (≥24 px) — precision / recall | ${faces?.precision} / ${faces?.recall} |
| 3. Redaction precision (20%) | Pixel precision / pixel recall / sensitive objects covered | **${red?.aggregate.pixelPrecision} / ${red?.aggregate.pixelRecall} / ${red ? `${Math.round(red.aggregate.objectRecall * red.aggregate.gtObjects)}/${red.aggregate.gtObjects}` : ""}** |
| 4. Client resources (20%) | Engine memory (WASM+weights), eco / balanced | ${lat?.modes.eco?.engineMemoryMB} MB / ${lat?.modes.balanced?.engineMemoryMB} MB |
| | Perception per step, median (p90), eco / balanced | ${lat?.modes.eco?.warmStepMs.median} (${lat?.modes.eco?.warmStepMs.p90}) ms / ${lat?.modes.balanced?.warmStepMs.median} (${lat?.modes.balanced?.warmStepMs.p90}) ms |
| | Unchanged frame (dHash cache) | ${lat?.modes.balanced?.unchangedFrameMs.median} ms |
| 5. End-to-end latency (15%) | Demo tasks (wall clock, all passed, 0 leaks) | ${Object.entries(tasks).map(([k, v]) => `${k} ${(v.wallMs / 1000).toFixed(1)} s`).join(" · ")} |

Privacy check on every task run: the server's own audit log is searched for each of the user's raw values — **${Object.values(tasks).reduce((a, v) => a + (v.leaks || 0), 0)} leaks** across ${Object.keys(tasks).length} tasks.
`;
function pctf(x) {
  return x == null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}
await writeFile("eval/results/summary.json", JSON.stringify(s, null, 2));
await writeFile("eval/results/SUMMARY.md", md);
console.log(md);
