import { test } from "node:test";
import assert from "node:assert/strict";
import { joinOcrWords, mapSpansToWordBoxes } from "./ocr.js";
import { detectSpans } from "../redact.js";

test("joinOcrWords builds a single-space-joined string with correct offsets", () => {
  const words = [
    { text: "Rohan", x: 0, y: 0, w: 10, h: 10 },
    { text: "Mehta", x: 12, y: 0, w: 10, h: 10 },
  ];
  const { text, offsets } = joinOcrWords(words);
  assert.equal(text, "Rohan Mehta");
  assert.deepEqual(offsets.map((o) => [o.start, o.end]), [[0, 5], [6, 11]]);
});

test("mapSpansToWordBoxes maps a multi-word PII span to every word it covers", async () => {
  const words = [
    { text: "2341", x: 0, y: 0, w: 20, h: 10 },
    { text: "2341", x: 24, y: 0, w: 20, h: 10 },
    { text: "2346", x: 48, y: 0, w: 20, h: 10 },
  ];
  const { text, offsets } = joinOcrWords(words);
  assert.equal(text, "2341 2341 2346");
  const spans = await detectSpans(text, {});
  assert.equal(spans[0]?.type, "AADHAAR");
  const boxes = mapSpansToWordBoxes(spans, offsets);
  assert.equal(boxes.length, 3); // all 3 words of the Aadhaar number get their own box
  assert.deepEqual(boxes.map((b) => b.x), [0, 24, 48]);
  assert.ok(boxes.every((b) => b.type === "AADHAAR"));
});

test("mapSpansToWordBoxes finds nothing when there is no PII", async () => {
  const words = [{ text: "hello", x: 0, y: 0, w: 10, h: 10 }, { text: "world", x: 12, y: 0, w: 10, h: 10 }];
  const { text, offsets } = joinOcrWords(words);
  const spans = await detectSpans(text, {});
  assert.deepEqual(mapSpansToWordBoxes(spans, offsets), []);
});
