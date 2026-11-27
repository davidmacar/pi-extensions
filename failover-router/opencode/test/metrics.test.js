import test from "node:test";
import assert from "node:assert/strict";
import { candidateOrder } from "../src/route.js";
import { createMetrics } from "../src/metrics.js";
import { SPEED_TTL_MS } from "../../common/speed-cache.js";

const stateDir = "/dev/null/failover-router-metrics-test";
const channel = (baseURL, apiKey = "test-only-key") => ({ baseURL, apiKey });

function priceConfig() {
  return {
    refreshMarketplace: true,
    probeSpeed: false,
    channels: {
      "subrouter-expensive": channel("https://expensive.invalid/v1"),
      "subrouter-cheap": channel("https://cheap.invalid/v1"),
      ordinary: channel("https://ordinary.invalid/v1"),
    },
    profiles: {
      cost: { order: "cost", protocol: "chat/completions", chain: [
        { channel: "subrouter-expensive", model: "model-a" },
        { channel: "ordinary", model: "model-a" },
        { channel: "subrouter-cheap", model: "model-b" },
      ] },
    },
  };
}

test("marketplace refresh uses configured SubRouter refs and feeds shared price ordering until hourly expiry", async () => {
  let clock = 100;
  const calls = [];
  const metrics = createMetrics({ config: priceConfig(), stateDir, now: () => clock, log: () => {}, fetchImpl: async url => {
    const parsed = new URL(url);
    calls.push(parsed.searchParams.get("model"));
    const model = parsed.searchParams.get("model");
    const rows = model === "model-a"
      ? [{ provider_slug: "expensive", model_name: model, input_price: 8, price_currency: "CNY" }]
      : [{ provider_slug: "cheap", model_name: model, input_price: 1, price_currency: "CNY" }];
    return new Response(JSON.stringify({ success: true, data: rows }), { status: 200 });
  } });
  try {
    const profile = priceConfig().profiles.cost;
    await metrics.prepare(profile);
    assert.deepEqual(calls.sort(), ["model-a", "model-b"]);
    assert.deepEqual(candidateOrder(profile, priceConfig().channels, metrics.getMetrics()).map(step => step.channel), [
      "subrouter-cheap", "subrouter-expensive", "ordinary",
    ]);
    assert.equal(metrics.getMetrics().priceCache.prices["subrouter-cheap/model-b"].input_price, 1);

    await metrics.prepare(profile);
    assert.equal(calls.length, 2, "fresh marketplace cache should not refetch");
    clock += 60 * 60_000;
    await metrics.prepare(profile);
    assert.equal(calls.length, 4, "hour-old marketplace cache should refresh");
  } finally {
    metrics.close();
  }
});

test("speed probes use each profile protocol, configured effort and shared token-usage ordering; refresh after TTL", async () => {
  let clock = 1_000;
  const requests = [];
  const config = {
    refreshMarketplace: false,
    probeSpeed: true,
    channels: {
      chat: channel("https://chat.invalid/v1"),
      responses: channel("https://responses.invalid/v1"),
    },
    profiles: {
      chat: { order: "speed", protocol: "chat/completions", chain: [
        { channel: "chat", model: "chat-model", reasoningEffort: "high", reasoningLevels: ["low", "high"] },
      ] },
      responses: { order: "speed", protocol: "responses", chain: [
        { channel: "responses", model: "responses-model", reasoningEffort: "medium", reasoningLevels: ["medium", "high"] },
      ] },
    },
  };
  const metrics = createMetrics({ config, stateDir, now: () => (clock += 10), log: () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body, authorization: options.headers.authorization });
    const tokens = body.model === "chat-model" ? 5 : 30;
    const usage = String(url).endsWith("/responses") ? { output_tokens: tokens } : { completion_tokens: tokens };
    return new Response(JSON.stringify({ usage }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  try {
    await metrics.prepare(config.profiles.chat);
    await metrics.prepare(config.profiles.responses);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://chat.invalid/v1/chat/completions");
    assert.equal(requests[0].body.reasoning_effort, "high");
    assert.equal(requests[0].body.max_completion_tokens, 50);
    assert.equal(requests[0].authorization, "Bearer test-only-key");
    assert.equal(requests[1].url, "https://responses.invalid/v1/responses");
    assert.equal(requests[1].body.reasoning.effort, "medium");
    assert.equal(requests[1].body.max_output_tokens, 50);
    assert.equal(requests[1].body.store, false);

    const speedProfile = { order: "speed", chain: [
      { channel: "chat", model: "chat-model" },
      { channel: "responses", model: "responses-model" },
    ] };
    assert.deepEqual(candidateOrder(speedProfile, config.channels, metrics.getMetrics()).map(step => step.channel), ["responses", "chat"]);
    clock += SPEED_TTL_MS;
    await metrics.prepare(config.profiles.responses);
    assert.equal(requests.length, 3, "stale speed measurement should refresh");
  } finally {
    metrics.close();
  }
});

test("a non-speed profile never triggers an opted-in speed probe", async () => {
  let calls = 0;
  const config = {
    refreshMarketplace: false,
    probeSpeed: true,
    channels: { provider: channel("https://provider.invalid/v1") },
    profiles: {
      cost: { order: "cost", protocol: "chat/completions", chain: [{ channel: "provider", model: "model" }] },
      speed: { order: "speed", protocol: "chat/completions", chain: [{ channel: "provider", model: "another-model" }] },
    },
  };
  const metrics = createMetrics({ config, stateDir, now: () => 100, log: () => {}, fetchImpl: async () => { calls += 1; } });
  try {
    await metrics.prepare(config.profiles.cost);
    assert.equal(calls, 0);
    assert.deepEqual(metrics.getMetrics().speedCache.channels, {});
  } finally {
    metrics.close();
  }
});

test("probe failures never copy an upstream error body into diagnostics or the speed cache", async () => {
  const secret = "test-only-upstream-secret";
  const logs = [];
  const config = {
    refreshMarketplace: false,
    probeSpeed: true,
    channels: { provider: channel("https://provider.invalid/v1", secret) },
    profiles: { speed: { order: "speed", protocol: "chat/completions", chain: [
      { channel: "provider", model: "model" },
    ] } },
  };
  const metrics = createMetrics({ config, stateDir, now: (() => { let value = 100; return () => value += 10; })(), log: line => logs.push(line), fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: secret } }), { status: 401 }) });
  try {
    await metrics.prepare(config.profiles.speed);
    const serialized = JSON.stringify(metrics.getMetrics().speedCache);
    assert.doesNotMatch(serialized, /test-only-upstream-secret/);
    assert.doesNotMatch(logs.join("\n"), /test-only-upstream-secret/);
    assert.match(serialized, /HTTP 401/);
  } finally {
    metrics.close();
  }
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function speedConfig() {
  const responses = { order: "speed", protocol: "responses", chain: [{ channel: "ordinary", model: "shared" }] };
  const chat = { order: "speed", protocol: "chat/completions", chain: [{ channel: "ordinary", model: "shared" }] };
  const distinct = { ...chat, chain: [{ channel: "ordinary", model: "distinct" }] };
  const config = priceConfig();
  return { ...config, refreshMarketplace: false, probeSpeed: true,
    profiles: { ...config.profiles, chat, responses, distinct } };
}

function probeReply(usage = { completion_tokens: 5 }) {
  return new Response(JSON.stringify({ usage }), { headers: { "content-type": "application/json" } });
}

test("overlapping speed requests coalesce per ref without dropping distinct targets or using another profile's protocol", async () => {
  const gate = deferred();
  const requests = [];
  let clock = 0;
  const config = speedConfig();
  const metrics = createMetrics({ config, stateDir, now: () => ++clock, fetchImpl: async (url, { body }) => {
    requests.push([new URL(url).pathname, JSON.parse(body).model]);
    await gate.promise;
    return probeReply(url.endsWith("/responses") ? { output_tokens: 5 } : undefined);
  } });
  try {
    const results = [config.profiles.responses, config.profiles.responses, config.profiles.distinct].map(profile => metrics.prepare(profile));
    gate.resolve();
    await Promise.all(results);
    assert.deepEqual(requests, [["/v1/responses", "shared"], ["/v1/chat/completions", "distinct"]]);
    assert.deepEqual(Object.keys(metrics.getMetrics().speedCache.channels), ["ordinary/shared", "ordinary/distinct"]);
  } finally {
    metrics.close();
  }
});

test("startup wait is bounded; request cancellation is local, while close aborts shared jobs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const config = { ...speedConfig(), refreshMarketplace: true };
  const requests = [];
  const gate = deferred();
  const logs = [];
  const metrics = createMetrics({ config, stateDir, now: () => 100, log: line => logs.push(line), fetchImpl: async (url, options) => {
    requests.push({ url, signal: options.signal });
    await gate.promise;
    throw new Error("test-only-reflected-secret");
  } });
  try {
    const controller = new AbortController();
    const cancelled = metrics.prepare(config.profiles.chat, controller.signal);
    const waiting = metrics.prepare(config.profiles.chat);
    const waitingOnClose = metrics.prepare(config.profiles.distinct);
    await nextTurn();
    assert.equal(requests.length, 3);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.ok(requests.every(({ signal }) => !signal.aborted));

    t.mock.timers.tick(8_000);
    assert.equal(await waiting, undefined);
    const atClose = metrics.prepare(config.profiles.distinct);
    await nextTurn();
    metrics.close();
    assert.ok(requests.every(({ signal }) => signal.aborted));
    await atClose;
    await waitingOnClose;
    gate.resolve();
    await nextTurn();
    assert.equal(requests.length, 3, "close does not start queued probes");
    assert.deepEqual(metrics.getMetrics().speedCache.channels, {});
    assert.deepEqual(metrics.getMetrics().priceCache.prices, {});
    assert.doesNotMatch(logs.join("\n"), /test-only-reflected-secret/);
  } finally {
    gate.resolve();
    metrics.close();
  }
});

test("marketplace refreshes on the hourly timer, retains good rows on failure, and does not log raw failures", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const config = priceConfig();
  let clock = 0;
  let calls = 0;
  const logs = [];
  const metrics = createMetrics({ config, stateDir, now: () => clock, log: line => logs.push(line), fetchImpl: async (url, options) => {
    assert.equal(options.headers, undefined, "marketplace must never receive a credential");
    if (++calls > 2) throw new Error("test-only-reflected-secret");
    const model = new URL(url).searchParams.get("model");
    const provider = model === "model-a" ? "expensive" : "cheap";
    return new Response(JSON.stringify({ success: true, data: [
      { provider_slug: provider, model_name: model, input_price: 1, price_currency: "USD" },
    ] }));
  } });
  try {
    await metrics.prepare(config.profiles.cost);
    await metrics.prepare(config.profiles.cost);
    assert.equal(calls, 2, "epoch zero is also a fresh refresh time");
    clock += 60 * 60_000;
    t.mock.timers.tick(clock);
    await nextTurn();
    assert.equal(calls, 4, "refresh happens even with no incoming request");
    assert.equal(metrics.getMetrics().priceCache.prices["subrouter-cheap/model-b"].price_currency, "USD");
    assert.doesNotMatch(logs.join("\n"), /test-only-reflected-secret/);
  } finally {
    metrics.close();
  }
});
