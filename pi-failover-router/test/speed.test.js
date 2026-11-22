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

test("the newest sample decides, so a degradation shows at once", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 40, now);
  cache = recordSample(cache, REF, 41, now);
  cache = recordSample(cache, REF, 1, now);
  assert.equal(tokensPerSecond(cache, REF), 1, "the newest measurement wins, not the history");
});

test("the history is kept but no average is taken from it", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 10, now);
  cache = recordSample(cache, REF, 20, now);
  assert.equal(cache.channels[REF].samples.length, 2, "the history is still kept");
  assert.equal(tokensPerSecond(cache, REF), 20);
});

test("samples are capped so old measurements cannot dominate", () => {
  let cache = emptyCache();
  for (let i = 1; i <= MAX_SAMPLES + 3; i += 1) cache = recordSample(cache, REF, i, 1);
  assert.equal(cache.channels[REF].samples.length, MAX_SAMPLES);
  assert.equal(tokensPerSecond(cache, REF), MAX_SAMPLES + 3, "the newest sample survives the cap");
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
  assert.equal(cache.channels[REF].attempts.length, 1);
  assert.equal(cache.channels[REF].attempts[0].ok, false);
  assert.equal(cache.channels[REF].attempts[0].message, "timeout after 15000 ms");
  assert.equal(cache.channels[REF].attempts[0].at, now);
  assert.deepEqual(dueRefs(cache, [REF], now + 1), [REF], "a failed channel is due again immediately");
});

test("a failure keeps the samples a channel already had", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 40, now - SPEED_TTL_MS - 1);
  cache = recordFailure(cache, REF, "boom", now);
  assert.equal(tokensPerSecond(cache, REF), 40, "a known channel stays known after one failure");
  assert.deepEqual(
    cache.channels[REF].attempts.map((a) => a.ok),
    [true, false],
    "the failure is appended to the attempts, not over the sample",
  );
});

test("a later success clears the remembered failure", () => {
  const now = 1_000_000;
  let cache = recordFailure(emptyCache(), REF, "boom", now);
  cache = recordSample(cache, REF, 30, now + 1);
  assert.equal(cache.channels[REF].attempts.at(-1).ok, true);
  assert.match(cache.channels[REF].attempts.at(-1).message, /30\.0 tok\/s/);
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
  assert.equal(tokensPerSecond(legacy, REF), 20, "a legacy cache reads as its newest sample");
  assert.deepEqual(legacy.channels[REF].attempts, [], "a version 1 cache records no attempts");
});

test("the probe module re-exports the same timeout tiers as the cache", async () => {
  const probe = await import("../lib/speed-probe.js");
  assert.deepEqual(probe.PROBE_TIMEOUT_TIERS_MS, PROBE_TIMEOUT_TIERS_MS);
});

test("a channel that is merely slow is measured on the wider tier", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  // The budget polls every 250 ms, so a tier below that granularity can never be
  // overrun before the reply lands. Milliseconds still stand in for the real
  // tiers: proving which tier did the work must not cost 35 s of wall time.
  const tiers = [300, 900];
  const logs = [];
  // A reply that misses the short tier and lands inside the wide one.
  const complete = async (model, _context, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ usage: { output: 100 } }), 600);
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
    tiers,
    wideMs: tiers[1],
  });
  assert.deepEqual(failed, []);
  assert.equal(measured.length, 1);
  assert.equal(measured[0].timeoutTierMs, tiers[1], "the wide tier did the work");
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
    // Short tiers plus a short wide floor: the real 99 s wait is not the point.
    tiers: [40, 100],
    wideMs: 100,
  });
  assert.deepEqual(measured, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /no answer within/);
});

test("a probe that comes back as a channel error reports the provider text", async () => {
  const { measureChannel } = await import("../lib/speed-probe.js");
  const complete = async () => ({
    role: "assistant",
    stopReason: "error",
    errorMessage:
      'status_code=400, body: {"error":{"message":"gpt-6.2-sol requires Responses for tool calls; this account only supports Chat Completions","type":"invalid_request_error"}}',
    usage: { output: 0 },
  });
  await assert.rejects(
    () => measureChannel({ model: { provider: "p", id: "m" }, complete, requestModel: {} }),
    /channel error.*requires Responses for tool calls/,
  );
});

test("a probe that returns no usage says what the response actually was", async () => {
  const { measureChannel } = await import("../lib/speed-probe.js");
  const complete = async () => ({ role: "assistant", stopReason: "stop", usage: undefined });
  await assert.rejects(
    () => measureChannel({ model: { provider: "p", id: "m" }, complete, requestModel: {} }),
    /no output tokens.*stopReason=stop.*no usage/,
  );
});

test("a probe that returns an empty usage reports the numbers", async () => {
  const { measureChannel } = await import("../lib/speed-probe.js");
  const complete = async () => ({
    role: "assistant",
    stopReason: "stop",
    usage: { input: 12, output: 0, totalTokens: 12 },
  });
  await assert.rejects(
    () => measureChannel({ model: { provider: "p", id: "m" }, complete, requestModel: {} }),
    /no output tokens.*stopReason=stop.*usage=\{input:12,output:0/,
  );
});

test("a healthy response still measures", async () => {
  const { measureChannel } = await import("../lib/speed-probe.js");
  let clock = 0;
  const now = () => (clock += 500);
  const complete = async () => ({ role: "assistant", stopReason: "stop", usage: { output: 100 } });
  const result = await measureChannel({ model: { provider: "p", id: "m" }, complete, requestModel: {}, now });
  assert.equal(result.outputTokens, 100);
  assert.ok(result.tokensPerSecond > 0);
});

test("the probe asks for a level the channel accepts, never off", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  const seen = [];
  const complete = async (model, _context, options) => {
    seen.push(options.thinkingLevel);
    // The measurement divides tokens by elapsed time, so a reply in the same
    // millisecond would be rejected as "no elapsed time".
    await new Promise((done) => setTimeout(done, 5));
    return { usage: { output: 100 } };
  };
  const { measured } = await probeChannels({
    refs: ["subrouter-best/gpt-6.2-sol"],
    find: () => ({
      provider: "subrouter-best",
      id: "gpt-6.2-sol",
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    }),
    complete,
    tiers: [300],
    wideMs: 300,
  });
  assert.equal(measured.length, 1);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], "off", "reasoning must never be switched off for a channel that refuses it");
  assert.equal(seen[0], "low");
});

test("a channel that answers with an error is not retried on a wider tier", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  let attempts = 0;
  const logs = [];
  const complete = async () => {
    attempts += 1;
    return {
      stopReason: "error",
      errorMessage: '400: {"message":"gpt-6.2-sol does not support reasoning effort \\"none\\""}',
      usage: { output: 0 },
    };
  };
  const { measured, failed } = await probeChannels({
    refs: ["sol/x"],
    find: () => ({ provider: "sol", id: "x", thinkingLevelMap: { low: "low" } }),
    complete,
    log: (m) => logs.push(m),
    tiers: [300, 900],
    wideMs: 900,
  });
  assert.deepEqual(measured, []);
  assert.equal(failed.length, 1);
  assert.equal(attempts, 1, "a channel-owned error must not cost a second request");
  assert.match(failed[0].message, /channel error/);
  assert.equal(
    logs.some((m) => /timed out/.test(m)),
    false,
    "a hard error must not be reported as a timeout",
  );
});

test("a silent channel is still retried on the next tier", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  let attempts = 0;
  const logs = [];
  const complete = async (_model, _context, options) => {
    attempts += 1;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new Error(options.signal.reason?.message ?? "aborted")),
        { once: true },
      );
    });
  };
  const { failed } = await probeChannels({
    refs: ["dead/y"],
    find: () => ({ provider: "dead", id: "y" }),
    complete,
    log: (m) => logs.push(m),
    tiers: [300, 600],
    wideMs: 600,
  });
  assert.equal(attempts, 2, "silence still moves to the wider tier");
  assert.equal(failed.length, 1);
});

test("a channel that just degraded loses the lead on its newest measurement", () => {
  const chain = [{ model: "a/one" }, { model: "b/two" }];
  let cache = emptyCache();
  for (const speed of [80, 82, 79, 81]) cache = recordSample(cache, "a/one", speed, 1);
  for (const speed of [20, 21, 19, 22]) cache = recordSample(cache, "b/two", speed, 1);
  assert.deepEqual(
    orderBySpeed(chain, cache, tokensPerSecond).map((s) => s.model),
    ["a/one", "b/two"],
    "a/one is still the faster channel",
  );

  // a/one collapses on its newest measurement. Its fast history must not defend it.
  cache = recordSample(cache, "a/one", 5, 2);
  assert.deepEqual(
    orderBySpeed(chain, cache, tokensPerSecond).map((s) => s.model),
    ["b/two", "a/one"],
    "the newest sample decides the head of the chain",
  );
});

test("every attempt is recorded with the message that explains it", () => {
  const now = 1_000_000;
  let cache = recordSample(emptyCache(), REF, 40, now, 15000, "40.0 tok/s (100 tokens in 2500 ms, 15s tier)");
  cache = recordFailure(cache, REF, "400: does not support reasoning effort none", now + 1);
  const attempts = cache.channels[REF].attempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((a) => a.ok), [true, false]);
  assert.match(attempts[0].message, /40\.0 tok\/s/);
  assert.match(attempts[1].message, /does not support reasoning effort/);
  assert.equal(attempts[0].at, now);
  assert.equal(attempts[1].at, now + 1);
});

test("a success without a message still records one", () => {
  const cache = recordSample(emptyCache(), REF, 12.34, 5);
  assert.match(cache.channels[REF].attempts[0].message, /12\.3 tok\/s/);
});

test("only the last five attempts are kept", () => {
  let cache = emptyCache();
  for (let i = 1; i <= 7; i += 1) cache = recordFailure(cache, REF, `failure ${i}`, i);
  const attempts = cache.channels[REF].attempts;
  assert.equal(attempts.length, 5);
  assert.match(attempts[0].message, /failure 3/);
  assert.match(attempts[4].message, /failure 7/);
});

test("a cache stored before attempts existed keeps its error as an attempt", () => {
  const legacy = normalizeCache({
    kind: "pi-failover-router.speed",
    version: 2,
    channels: {
      [REF]: { samples: [10], measuredAt: 5, lastError: { at: 6, message: "no output tokens" } },
    },
  });
  const attempts = legacy.channels[REF].attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].message, "no output tokens");
  assert.equal(legacy.channels[REF].lastError, undefined, "the old field is unified, not duplicated");
});

test("a successful measurement carries the message that describes it", async () => {
  const { probeChannels } = await import("../lib/speed-probe.js");
  const complete = async () => {
    await new Promise((done) => setTimeout(done, 5));
    return { usage: { output: 100 } };
  };
  const { measured } = await probeChannels({
    refs: ["fast/z"],
    find: () => ({ provider: "fast", id: "z" }),
    complete,
    tiers: [300],
    wideMs: 300,
  });
  assert.equal(measured.length, 1);
  assert.match(measured[0].message, /tok\/s/, "the speed is in the message");
  assert.match(measured[0].message, /100 tokens/, "so is the token count");
  assert.match(measured[0].message, /0\.3s tier/, "and the tier that worked");
});
