import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SAMPLES,
  SPEED_TTL_MS,
  emptyCache,
  normalizeCache,
  parseCacheText,
  probeIsDue,
  recordSample,
  tokensPerSecond,
} from "../lib/speed-cache.js";
import { orderBySpeed } from "../lib/speed-order.js";

const REF = "subrouter-znu/deepseek-v4.1-flash-1017";

test("a missing cache reports every channel as due", () => {
  assert.equal(probeIsDue(undefined, [REF], 1_000), true);
});

test("a cache with no channels for the chain is due", () => {
  assert.equal(probeIsDue(emptyCache(), [REF], 1_000), true);
});

test("a fresh sample is not due and one older than 15 minutes is", () => {
  const now = 1_000_000;
  const cache = recordSample(emptyCache(), REF, 42, now);
  assert.equal(probeIsDue(cache, [REF], now + 1), false);
  assert.equal(probeIsDue(cache, [REF], now + SPEED_TTL_MS - 1), false);
  assert.equal(probeIsDue(cache, [REF], now + SPEED_TTL_MS), true);
});

test("one stale channel makes the whole measurement session due", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 42, now);
  cache = recordSample(cache, "subrouter-relai/deepseek-v4.1-flash-1017", 30, now - SPEED_TTL_MS);
  assert.equal(probeIsDue(cache, [REF, "subrouter-relai/deepseek-v4.1-flash-1017"], now), true);
});

test("the median resists one slow sample", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 40, now);
  cache = recordSample(cache, REF, 41, now);
  cache = recordSample(cache, REF, 1, now);
  assert.equal(tokensPerSecond(cache, REF), 40);
});

test("an even sample count averages the two middle values", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 10, now);
  cache = recordSample(cache, REF, 20, now);
  assert.equal(tokensPerSecond(cache, REF), 15);
});

test("samples are capped so old measurements cannot dominate", () => {
  let cache = emptyCache();
  for (let i = 1; i <= MAX_SAMPLES + 3; i += 1) cache = recordSample(cache, REF, i, 1);
  assert.equal(cache.channels[REF].samples.length, MAX_SAMPLES);
  assert.equal(tokensPerSecond(cache, REF), MAX_SAMPLES + 1);
});

test("an unmeasured channel has no throughput", () => {
  assert.equal(tokensPerSecond(emptyCache(), REF), undefined);
});

test("a malformed or foreign cache is rejected instead of trusted", () => {
  assert.equal(normalizeCache(null), undefined);
  assert.equal(normalizeCache({ kind: "other", version: 1, channels: {} }), undefined);
  assert.equal(normalizeCache({ kind: "pi-failover-router.speed", version: 99, channels: {} }), undefined);
  assert.equal(parseCacheText("{not json"), undefined);
  const dropped = normalizeCache({
    kind: "pi-failover-router.speed",
    version: 1,
    channels: { [REF]: { samples: ["fast", -1, 0], measuredAt: 5 } },
  });
  assert.deepEqual(dropped.channels, {});
});

test("ordering puts measured channels by speed and keeps unmeasured ones in place", () => {
  const chain = [
    { model: "a/one" },
    { model: "b/two" },
    { model: "c/three" },
    { model: "d/four" },
  ];
  let cache = emptyCache();
  cache = recordSample(cache, "c/three", 90, 1);
  cache = recordSample(cache, "a/one", 30, 1);
  const ordered = orderBySpeed(chain, cache, tokensPerSecond);
  assert.deepEqual(
    ordered.map((s) => s.model),
    ["c/three", "a/one", "b/two", "d/four"],
  );
});

test("with nothing measured the order is the original cheap-first order", () => {
  const chain = [{ model: "a/one" }, { model: "b/two" }];
  assert.deepEqual(
    orderBySpeed(chain, emptyCache(), tokensPerSecond).map((s) => s.model),
    ["a/one", "b/two"],
  );
  assert.deepEqual(
    orderBySpeed(chain, undefined, tokensPerSecond).map((s) => s.model),
    ["a/one", "b/two"],
  );
});

test("ordering keeps a step's own thinking level attached", () => {
  const chain = [
    { model: "a/one", thinkingLevel: "high" },
    { model: "b/two", thinkingLevel: "max" },
  ];
  const cache = recordSample(emptyCache(), "b/two", 99, 1);
  assert.deepEqual(orderBySpeed(chain, cache, tokensPerSecond), [
    { model: "b/two", thinkingLevel: "max" },
    { model: "a/one", thinkingLevel: "high" },
  ]);
});
