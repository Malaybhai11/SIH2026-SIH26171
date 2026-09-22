// Run: node --test extension/lib/humanBehavior.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gaussianRandom,
  logNormalRandom,
  fittsDuration,
  minimumJerk,
  cubicBezier,
  generateBezierPath,
  resolveKeyDetails,
  getRealisticTargetPoint,
  QWERTY_ADJACENT,
  KEY_CODES,
} from "./humanBehavior.js";

test("gaussianRandom respects bounds and produces variation", () => {
  const min = 50;
  const max = 150;
  const mean = 100;
  const stdDev = 20;

  const samples = [];
  for (let i = 0; i < 200; i++) {
    const val = gaussianRandom(mean, stdDev, min, max);
    assert.ok(val >= min, `val ${val} < min ${min}`);
    assert.ok(val <= max, `val ${val} > max ${max}`);
    samples.push(val);
  }

  const sampleMean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // Sample mean should be reasonably close to 100
  assert.ok(sampleMean > 85 && sampleMean < 115, `sample mean ${sampleMean} out of expected range`);
});

test("logNormalRandom produces positive skewed values within bounds", () => {
  const min = 40;
  const max = 400;
  const mean = 120;
  const stdDev = 30;

  for (let i = 0; i < 100; i++) {
    const val = logNormalRandom(mean, stdDev, min, max);
    assert.ok(val >= min && val <= max, `logNormal val ${val} out of bounds`);
  }
});

test("fittsDuration scales with distance and target size", () => {
  const shortEasy = fittsDuration(50, 100);
  const longHard = fittsDuration(800, 20);

  assert.ok(longHard > shortEasy, `expected longHard (${longHard}) > shortEasy (${shortEasy})`);
  assert.ok(shortEasy >= 140 && shortEasy <= 700);
  assert.ok(longHard >= 140 && longHard <= 700);
});

test("minimumJerk polynomial satisfies boundary and velocity profile", () => {
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);

  const mid = minimumJerk(0.5);
  assert.equal(mid, 0.5);

  // Derivative is low at start and end, highest in middle
  const t1 = 0.1;
  const t2 = 0.5;
  const t3 = 0.9;
  const diffStart = minimumJerk(t1) - minimumJerk(0);
  const diffMid = minimumJerk(0.55) - minimumJerk(0.45);
  const diffEnd = minimumJerk(1) - minimumJerk(t3);

  assert.ok(diffMid > diffStart);
  assert.ok(diffMid > diffEnd);
});

test("cubicBezier correctly interpolates start and end", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 10, y: 50 };
  const p2 = { x: 90, y: 50 };
  const p3 = { x: 100, y: 100 };

  const start = cubicBezier(p0, p1, p2, p3, 0);
  assert.equal(start.x, 0);
  assert.equal(start.y, 0);

  const end = cubicBezier(p0, p1, p2, p3, 1);
  assert.equal(end.x, 100);
  assert.equal(end.y, 100);
});

test("generateBezierPath produces smooth multi-point trajectory ending at destination", () => {
  const path = generateBezierPath(100, 100, 500, 400, 50);

  assert.ok(path.length >= 8, `path should have at least 8 points, got ${path.length}`);
  const lastPoint = path[path.length - 1];
  assert.equal(lastPoint.x, 500);
  assert.equal(lastPoint.y, 400);

  // Check that points don't have sudden teleporting jumps
  for (let i = 1; i < path.length; i++) {
    const stepDist = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    assert.ok(stepDist < 100, `Step distance between points ${i-1} and ${i} was too large: ${stepDist}`);
  }
});

test("getRealisticTargetPoint lands inside bounding box with padding", () => {
  const mockElement = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 120,
      height: 40,
      right: 220,
      bottom: 240,
    }),
  };

  for (let i = 0; i < 50; i++) {
    const pt = getRealisticTargetPoint(mockElement);
    assert.ok(pt.clientX >= 100 && pt.clientX <= 220, `clientX ${pt.clientX} out of bounds`);
    assert.ok(pt.clientY >= 200 && pt.clientY <= 240, `clientY ${pt.clientY} out of bounds`);
  }
});

test("resolveKeyDetails maps printable characters and special keys correctly", () => {
  const a = resolveKeyDetails("a");
  assert.equal(a.key, "a");
  assert.equal(a.code, "KeyA");
  assert.equal(a.keyCode, 65);

  const space = resolveKeyDetails(" ");
  assert.equal(space.key, " ");
  assert.equal(space.code, "Space");
  assert.equal(space.keyCode, 32);

  const enter = resolveKeyDetails("Enter");
  assert.equal(enter.key, "Enter");
  assert.equal(enter.code, "Enter");
  assert.equal(enter.keyCode, 13);
});

test("QWERTY_ADJACENT has reasonable neighbor mappings", () => {
  assert.ok(QWERTY_ADJACENT.a.includes("s"));
  assert.ok(QWERTY_ADJACENT.h.includes("j"));
  assert.ok(QWERTY_ADJACENT.k.includes("l"));
});
