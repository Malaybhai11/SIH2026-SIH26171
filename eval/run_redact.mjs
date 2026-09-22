// Runs the extension's redaction logic (extension/lib/redact.js) over every fixture
// in eval/pii_test_set/ and prints a JSON report to stdout for metrics.py.
//
//   node eval/run_redact.mjs [testSetDir]
//
// NER is not wired here (mock mode) — only the deterministic regex layer runs, which
// is exactly what ships client-side when no ONNX model is present.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactNodes } from "../extension/lib/redact.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || path.join(here, "pii_test_set");

const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
const report = [];

for (const f of files) {
  const fixture = JSON.parse(await readFile(path.join(dir, f), "utf8"));
  const { nodes, log } = await redactNodes(fixture.nodes, {}); // regex layer only
  report.push({
    id: fixture.id,
    predicted: log.map((e) => ({ elementId: e.elementId, type: e.type, value: e.value })),
    redactedNodes: nodes.map((n) => ({ id: n.id, text: n.text, author: n.author ?? null })),
  });
}

process.stdout.write(JSON.stringify(report, null, 2));
