import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADMISSIBLE_LEVELS,
  isAdmissible,
  resolveLevel,
  supportedLevels,
} from "../lib/thinking-level.js";

/** The shape the catalog declares for a sol channel: off maps to an effort the upstream refuses. */
const sol = {
  provider: "subrouter-best",
  id: "gpt-6.2-sol",
  reasoning: true,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
};

test("off and minimal are never admissible", () => {
  assert.deepEqual(ADMISSIBLE_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(isAdmissible("off"), false);
  assert.equal(isAdmissible("minimal"), false);
  assert.equal(isAdmissible("low"), true);
});

test("a requested level the model supports is kept", () => {
  assert.equal(resolveLevel(sol, "xhigh"), "xhigh");
});

test("a requested off becomes the cheapest level the model does support", () => {
  assert.equal(resolveLevel(sol, "off"), "low");
});

test("a level the model marks unsupported becomes the nearest one it supports", () => {
  const onlyHigh = {
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "high", max: null },
  };
  assert.equal(resolveLevel(onlyHigh, "low"), "high");
  assert.equal(resolveLevel(onlyHigh, "max"), "xhigh");
});

test("no request means no level is added", () => {
  assert.equal(resolveLevel(sol, undefined), undefined);
  assert.equal(resolveLevel(sol, null), undefined);
});

test("a model that supports no level at all gets none", () => {
  const none = { thinkingLevelMap: { low: null, medium: null, high: null, xhigh: null, max: null } };
  assert.deepEqual(supportedLevels(none), []);
  assert.equal(resolveLevel(none, "high"), undefined);
});

test("a model without a map is treated as supporting every admissible level", () => {
  assert.deepEqual(supportedLevels({ provider: "p", id: "i" }), ADMISSIBLE_LEVELS);
});
