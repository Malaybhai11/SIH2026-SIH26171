// Run: node --test extension/lib/deviceTier.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPerceptionTier, detectDeviceTier } from "./deviceTier.js";

test("low cores -> eco regardless of memory", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 2, deviceMemory: 16 }), "eco");
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 1 }), "eco");
});

test("low memory -> eco regardless of cores", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 16, deviceMemory: 2 }), "eco");
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 16, deviceMemory: 1 }), "eco");
});

test("high cores + high (or unknown) memory -> max", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 8, deviceMemory: 8 }), "max");
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 16, deviceMemory: 32 }), "max");
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 8 }), "max");
});

test("high cores but confirmed low-ish memory -> balanced, not max", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 8, deviceMemory: 4 }), "balanced");
});

test("mid-range or unknown capability -> balanced", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: 4, deviceMemory: 4 }), "balanced");
  assert.equal(pickPerceptionTier({}), "balanced");
  assert.equal(pickPerceptionTier(), "balanced");
});

test("non-finite/garbage inputs fall back to neutral defaults, never throw", () => {
  assert.equal(pickPerceptionTier({ hardwareConcurrency: NaN, deviceMemory: "lots" }), "balanced");
  assert.equal(pickPerceptionTier({ hardwareConcurrency: undefined, deviceMemory: undefined }), "balanced");
});

test("detectDeviceTier never throws without a navigator (e.g. plain Node)", () => {
  assert.doesNotThrow(() => detectDeviceTier());
  assert.equal(typeof detectDeviceTier(), "string");
});
