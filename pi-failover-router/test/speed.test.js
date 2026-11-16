import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SAMPLES,
  PROBE_TIMEOUT_TIERS_MS,
  SPEED_TTL_MS,
  dueRefs,
  emptyCache,
  normalizeCache,
  parseCacheText,
  probeIsDue,
  recordFailure,
  recordSample,
  startingTier,
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

test("a failed probe is recorded so the channel is retried and visible", () => {
  const now = 1_000_000;
  const cache = recordFailure(emptyCache(), REF, "timeout after 15000 ms", now);
  assert.equal(tokensPerSecond(cache, REF), undefined);
  assert.equal(cache.channels[REF].lastError.message, "timeout after 15000 ms");
  assert.equal(cache.channels[REF].lastError.at, now);
  assert.deepEqual(dueRefs(cache, [REF], now + 1), [REF], "a failed channel is due again immediately");
});

test("a failure keeps the samples a channel already had", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 40, now - SPEED_TTL_MS - 1);
  cache = recordFailure(cache, REF, "boom", now);
  assert.equal(tokensPerSecond(cache, REF), 40, "a known channel stays known after one failure");
  assert.notEqual(cache.channels[REF].lastError, undefined);
});

test("a later success clears the remembered failure", () => {
  const now = 1_000_000;
  let cache = recordFailure(emptyCache(), REF, "boom", now);
  cache = recordSample(cache, REF, 30, now + 1);
  assert.equal(cache.channels[REF].lastError, undefined);
  assert.equal(tokensPerSecond(cache, REF), 30);
});

test("only stale, never measured, or failed channels are due", () => {
  const now = 1_000_000;
  const fresh = recordSample(emptyCache(), "a/fresh", 50, now);
  let cache = recordSample(fresh, "b/stale", 50, now - SPEED_TTL_MS - 1);
  cache = recordSample(cache, "c/never", 1, now);
  delete cache.channels["c/never"];
  cache = recordFailure(cache, "d/failed", "timeout", now);
  const refs = ["a/fresh", "b/stale", "c/never", "d/failed"];
  assert.deepEqual(dueRefs(cache, refs, now), ["b/stale", "c/never", "d/failed"]);
});

test("a channel measured after its failure is not due again", () => {
  const now = 1_000_000;
  let cache = recordFailure(emptyCache(), REF, "boom", now - 10);
  cache = recordSample(cache, REF, 12, now);
  assert.deepEqual(dueRefs(cache, [REF], now), []);
});

test("the timeout tier that worked is remembered per channel", () => {
  const now = 1_000_000;
  let cache = emptyCache();
  assert.equal(startingTier(cache, REF), PROBE_TIMEOUT_TIERS_MS[0]);
  cache = recordSample(cache, REF, 9, now, PROBE_TIMEOUT_TIERS_MS[1]);
  assert.equal(startingTier(cache, REF), PROBE_TIMEOUT_TIERS_MS[1]);
});

test("cache version 1 is still readable and upgraded", () => {
  const legacy = normalizeCache({
    kind: "pi-failover-router.speed",
    version: 1,
    channels: { [REF]: { samples: [10, 20], measuredAt: 5 } },
  });
  assert.equal(tokensPerSecond(legacy, REF), 15);
  assert.equal(legacy.channels[REF].lastError, undefined);
});

test("the probe module re-exports the same timeout tiers as the cache", async () => {
  const probe = await import("../lib/speed-probe.js");
  assert.deepEqual(probe.PROBE_TIMEOUT_TIERS_MS, PROBE_TIMEOUT_TIERS_MS);
});

test("a channel that is merely slow is measured on the wider tier", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  const logs = [];
  // 20 s of thinking before the reply: over the short tier, inside the wide one.
  const complete = async (model, _context, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ usage: { output: 100 } }), 20_000);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error(options.signal.reason?.message ?? "aborted"));
        },
        { once: true },
      );
    });
  const { measured, failed } = await probeChannels({
    refs: ["slow/x"],
    find: () => ({ provider: "slow", id: "x" }),
    complete,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(failed, []);
  assert.equal(measured.length, 1);
  assert.equal(measured[0].timeoutTierMs, PROBE_TIMEOUT_TIERS_MS[1], "the wide tier did the work");
  assert.match(logs.join("\n"), /retrying with the next tier/);
});

test("a channel that never answers is recorded with its reason", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  const complete = async (model, _context, options) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new Error(options.signal.reason?.message ?? "aborted")),
        { once: true },
      );
    });
  const { measured, failed } = await probeChannels({
    refs: ["dead/z"],
    find: () => ({ provider: "dead", id: "z" }),
    complete,
  });
  assert.deepEqual(measured, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /no answer within/);
});
