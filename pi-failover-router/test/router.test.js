import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import failoverRouter, { MEASURE_WAIT_MS, noteFailure } from "../index.js";

// A test run must never append to the user's real decision log: that file is the
// record a later diagnosis reads, and test noise buries the real decisions.
const TEST_DECISION_LOG = join(tmpdir(), `pi-failover-router-log-test-${process.pid}.log`);
process.env.PI_FAILOVER_ROUTER_LOG = TEST_DECISION_LOG;
// Router tests must never run the optional installed-shell repair process.
process.env.PI_FAILOVER_ROUTER_NO_PATCHER = "1";

/** Minimal fake ExtensionAPI + model registry that records routing decisions. */
function harness({ config, catalog, subrouterFetch }) {
  const registered = [];
  const logs = [];
  const handlers = new Map();
  const defaultPriceRows = [...new Set(config.virtuals.flatMap(def => def.chain.map(step => step.model)))].map(ref => {
    const slash = ref.indexOf("/");
    const provider = ref.slice(0, slash);
    return { provider_slug: provider.startsWith("subrouter-") ? provider.slice("subrouter-".length) : provider,
      model_name: ref.slice(slash + 1), input_price: 1, price_currency: "USD" };
  });
  const pi = {
    log: (m) => logs.push(m),
    subrouterFetch: subrouterFetch ?? (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: defaultPriceRows }) })),
    registerVirtualModel: (def) => registered.push(def),
    on: (name, fn) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
  };
  const fire = (name, event, extra) => {
    const list = handlers.get(name) ?? [];
    return list.map((fn) => fn(event, { ...ctx, ...extra }));
  };
  const ctx = {
    modelRegistry: {
      find: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id),
    },
  };
  return { pi, ctx, registered, logs, fire, handlers };
}

const catalog = [
  { provider: "subrouter-best", id: "gpt-6.2-sol" },
  { provider: "subrouter-000", id: "gpt-6.2-sol" },
  { provider: "subrouter-fxpayback", id: "gpt-6.2-sol" },
];

const config = {
  virtuals: [
    {
      provider: "router",
      id: "sol",
      name: "Sol failover",
      thinkingLevels: ["high", "xhigh"],
      chain: [
        { model: "subrouter-best/gpt-6.2-sol", thinkingLevel: "xhigh" },
        { model: "subrouter-000/gpt-6.2-sol", thinkingLevel: "xhigh" },
        { model: "subrouter-fxpayback/gpt-6.2-sol", thinkingLevel: "xhigh" },
      ],
    },
  ],
};

function boot(cfg = config, cat = catalog) {
  const h = harness({ config: cfg, catalog: cat });
  const path = join(tmpdir(), `pi-failover-router-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const pricePath = join(tmpdir(), `pi-failover-router-price-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  // A test must never write into the user's real decision log.
  const decisionLog = join(tmpdir(), `pi-failover-router-log-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  process.env.PI_FAILOVER_ROUTER_PRICE_CACHE = pricePath;
  process.env.PI_FAILOVER_ROUTER_LOG = decisionLog;
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  delete process.env.PI_FAILOVER_ROUTER_PRICE_CACHE;
  process.env.PI_FAILOVER_ROUTER_LOG = TEST_DECISION_LOG;
  return { ...h, decisionLog };
}

test("registers one virtual model per configured entry", () => {
  const { registered } = boot();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].provider, "router");
  assert.equal(registered[0].id, "sol");
  assert.deepEqual(registered[0].thinkingLevels, ["high", "xhigh"]);
});

test("first user request waits for session prices before routing", async () => {
  let resolveResponse;
  const pendingResponse = new Promise(resolve => { resolveResponse = resolve; });
  const h = harness({ config, catalog, subrouterFetch: async () => pendingResponse });
  const path = join(tmpdir(), `pi-failover-router-prices-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const pricePath = join(tmpdir(), `pi-failover-router-price-pending-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(config));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  process.env.PI_FAILOVER_ROUTER_PRICE_CACHE = pricePath;
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  delete process.env.PI_FAILOVER_ROUTER_PRICE_CACHE;
  h.fire("session_start", {});
  const route = h.registered[0].route({ reason: "user", messages: [] }, h.ctx);
  assert.equal(typeof route?.then, "function");
  resolveResponse({ ok: true, json: async () => ({ success: true, data: [
    { provider_slug: "best", model_name: "gpt-6.2-sol", input_price: 4, price_currency: "USD" },
    { provider_slug: "000", model_name: "gpt-6.2-sol", input_price: 2, price_currency: "USD" },
    { provider_slug: "fxpayback", model_name: "gpt-6.2-sol", input_price: 1, price_currency: "USD" },
  ] }) });
  const result = await route;
  h.fire("session_shutdown", {});
  assert.equal(result.model.provider, "subrouter-fxpayback");
});

test("first user request goes to the cheapest candidate", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route({ reason: "user", messages: [] }, ctx);
  assert.equal(out.model.provider, "subrouter-best");
  assert.equal(out.thinkingLevel, "xhigh");
});

test("a channel-capability retry rotates to the next candidate", () => {
  const { registered, ctx } = boot();
  registered[0].route({ reason: "user", messages: [] }, ctx);
  const out = registered[0].route(
    {
      reason: "retry",
      messages: [],
      failed: {
        model: { provider: "subrouter-best", id: "gpt-6.2-sol" },
        thinkingLevel: "xhigh",
        message: {
          stopReason: "error",
          errorMessage:
            'status_code=400, bad response status code 400, body: {"error":{"message":"gpt-6.2-sol requires Responses for tool calls; this account only supports Chat Completions","type":"invalid_request_error"}}',
        },
      },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-000");
});

test("an incomplete-stream retry rotates", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route(
    {
      reason: "retry",
      messages: [],
      failed: {
        model: { provider: "subrouter-best", id: "gpt-6.2-sol" },
        thinkingLevel: "xhigh",
        message: {
          stopReason: "error",
          errorMessage: "status_code=499, upstream stream read failed before completion: http2: response body closed",
        },
      },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-000");
});

test("a request-shaped retry does NOT rotate and keeps the failed model", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route(
    {
      reason: "retry",
      messages: [],
      failed: {
        model: { provider: "subrouter-best", id: "gpt-6.2-sol" },
        thinkingLevel: "high",
        message: { stopReason: "error", errorMessage: "400 context_length_exceeded: maximum context length is 1050000" },
      },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-best");
});

test("an unknown error does NOT rotate", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route(
    {
      reason: "retry",
      messages: [],
      failed: {
        model: { provider: "subrouter-best", id: "gpt-6.2-sol" },
        thinkingLevel: "high",
        message: { stopReason: "error", errorMessage: "weird sandbox thing" },
      },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-best");
});

test("continuation sticks to the model of the previous response", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route(
    {
      reason: "continuation",
      messages: [],
      previous: { model: { provider: "subrouter-000", id: "gpt-6.2-sol" }, thinkingLevel: "high" },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-000");
  assert.equal(out.thinkingLevel, "high");
});

test("the failing model enters cooldown and a complete repeat waits for it", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { registered, ctx } = boot();
  const failed = (provider) => ({
    reason: "retry",
    messages: [],
    failed: {
      model: { provider, id: "gpt-6.2-sol" },
      thinkingLevel: "xhigh",
      message: { stopReason: "error", errorMessage: "503 service unavailable" },
    },
  });
  const first = registered[0].route(failed("subrouter-best"), ctx);
  assert.equal(first.model.provider, "subrouter-000");
  const second = registered[0].route(failed("subrouter-000"), ctx);
  assert.equal(second.model.provider, "subrouter-fxpayback");
  const third = registered[0].route(failed("subrouter-fxpayback"), ctx);
  assert.equal(typeof third?.then, "function", "a repeat must honor cooldown");
  t.mock.timers.tick(2 * 60_000);
  assert.equal((await third).model.provider, "subrouter-best");
});

test("a chain step without a level keeps the level the caller selected", () => {
  const cfg = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol failover",
        thinkingLevels: ["high", "xhigh"],
        chain: [{ model: "subrouter-best/gpt-6.2-sol" }, { model: "subrouter-000/gpt-6.2-sol" }],
      },
    ],
  };
  const { registered, ctx } = boot(cfg);

  const first = registered[0].route({ reason: "user", thinkingLevel: "xhigh", messages: [] }, ctx);
  assert.equal(first.model.provider, "subrouter-best");
  assert.equal(first.thinkingLevel, "xhigh");

  const retry = registered[0].route(
    {
      reason: "retry",
      thinkingLevel: "xhigh",
      messages: [],
      failed: {
        model: { provider: "subrouter-best", id: "gpt-6.2-sol" },
        thinkingLevel: "xhigh",
        message: { stopReason: "error", errorMessage: "503 service unavailable" },
      },
    },
    ctx,
  );
  assert.equal(retry.model.provider, "subrouter-000");
  assert.equal(retry.thinkingLevel, "xhigh");
});

test("an explicit chain step level wins over the selected level", () => {
  const { registered, ctx } = boot();
  const out = registered[0].route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(out.thinkingLevel, "xhigh");
});

/** Registry that answers probes after a per-channel delay, so throughput differs. */
function probeHarness({ cfg, catalog, output = 20, latencyMs = () => 20, initialSpeedCache }) {
  const registered = [];
  const handlers = new Map();
  const logs = [];
  const speedPath = join(tmpdir(), `pi-failover-router-speed-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const pricePath = join(tmpdir(), `pi-failover-router-price-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  if (initialSpeedCache) writeFileSync(speedPath, JSON.stringify(initialSpeedCache));
  const pi = {
    log: (m) => logs.push(m),
    subrouterFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ model_name: "gpt-6.2-sol", input_price: 1, price_currency: "USD" }] }) }),
    registerVirtualModel: (def) => registered.push(def),
    on: (event, handler) => handlers.set(event, handler),
  };
  const ctx = {
    modelRegistry: {
      find: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id),
      complete: async (model) => {
        const wait = latencyMs(`${model.provider}/${model.id}`);
        await new Promise((done) => setTimeout(done, wait));
        return { usage: { output } };
      },
    },
  };
  const path = join(tmpdir(), `pi-failover-router-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const decisionLog = join(tmpdir(), `pi-failover-router-log-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(path, JSON.stringify(cfg));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  process.env.PI_FAILOVER_ROUTER_SPEED_CACHE = speedPath;
  process.env.PI_FAILOVER_ROUTER_PRICE_CACHE = pricePath;
  process.env.PI_FAILOVER_ROUTER_LOG = decisionLog;
  failoverRouter(pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  delete process.env.PI_FAILOVER_ROUTER_SPEED_CACHE;
  delete process.env.PI_FAILOVER_ROUTER_PRICE_CACHE;
  process.env.PI_FAILOVER_ROUTER_LOG = TEST_DECISION_LOG;
  return { registered, handlers, logs, ctx, speedPath, decisionLog };
}

/** Waits for an observable effect, so the test never depends on a fixed sleep. */
async function settle(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (predicate()) return true;
    } catch {
      // not ready yet
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  return false;
}

const speedConfig = {
  virtuals: [
    {
      provider: "router",
      id: "sol-rapido",
      name: "Sol rápido",
      order: "speed",
      thinkingLevels: ["high"],
      chain: [{ model: "subrouter-best/gpt-6.2-sol" }, { model: "subrouter-000/gpt-6.2-sol" }],
    },
    {
      provider: "router",
      id: "sol",
      name: "Sol barato",
      thinkingLevels: ["high"],
      chain: [{ model: "subrouter-best/gpt-6.2-sol" }, { model: "subrouter-000/gpt-6.2-sol" }],
    },
  ],
};

const FAST_CATALOG = [
  { provider: "subrouter-best", id: "gpt-6.2-sol" },
  { provider: "subrouter-000", id: "gpt-6.2-sol" },
];

/** subrouter-000 answers much faster than subrouter-best. */
const latency = (ref) => (ref.startsWith("subrouter-000/") ? 5 : 70);

test("without measurements a speed chain keeps the configured order", () => {
  const { registered, handlers, ctx } = probeHarness({ cfg: speedConfig, catalog: FAST_CATALOG });
  const fast = registered.find((r) => r.id === "sol-rapido");
  const out = fast.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  handlers.get("session_shutdown")?.();
  assert.equal(out.model.provider, "subrouter-best");
});

test("session_start measures, persists, and the fastest channel then wins", async () => {
  const { registered, handlers, ctx, speedPath } = probeHarness({
    cfg: speedConfig,
    catalog: FAST_CATALOG,
    latencyMs: latency,
  });
  const fast = registered.find((r) => r.id === "sol-rapido");
  handlers.get("session_start")({ reason: "startup" }, ctx);

  const routedFast = await settle(
    () => fast.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx).model.provider === "subrouter-000",
  );
  handlers.get("session_shutdown")?.();
  assert.equal(routedFast, true, "the measured fastest channel must be tried first");

  const persisted = JSON.parse(readFileSync(speedPath, "utf8"));
  assert.equal(Object.keys(persisted.channels).length, 2);
});

test("cost-only router startup prunes obsolete entries from the speed cache", () => {
  const h = probeHarness({
    cfg: { virtuals: [{ ...speedConfig.virtuals[1], order: "cost" }] },
    catalog: FAST_CATALOG,
    initialSpeedCache: {
      kind: "pi-failover-router.speed",
      version: 3,
      channels: {
        "subrouter-old/gpt-6.1-sol": { samples: [99], measuredAt: 5, attempts: [] },
        "subrouter-old/unconfigured": { samples: [88], measuredAt: 5, attempts: [] },
      },
    },
  });
  h.handlers.get("session_shutdown")?.();
  const persisted = JSON.parse(readFileSync(h.speedPath, "utf8"));
  assert.deepEqual(persisted.channels, {});
});

test("a chain with cost order ignores speed measurements", async () => {
  const { registered, handlers, ctx } = probeHarness({ cfg: speedConfig, catalog: FAST_CATALOG, latencyMs: latency });
  const cheap = registered.find((r) => r.id === "sol");
  handlers.get("session_start")({ reason: "startup" }, ctx);
  await settle(() => true);
  await new Promise((done) => setTimeout(done, 250));
  handlers.get("session_shutdown")?.();
  const out = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(out.model.provider, "subrouter-best");
});

test("a fresh measurement session is not repeated inside the window", async () => {
  const { handlers, ctx, logs } = probeHarness({ cfg: speedConfig, catalog: FAST_CATALOG, latencyMs: latency });
  handlers.get("session_start")({ reason: "startup" }, ctx);
  await settle(() => logs.filter((l) => l.includes("speed probe subrouter")).length === 2);
  const first = logs.filter((l) => l.includes("speed probe subrouter")).length;
  assert.equal(first, 2);

  handlers.get("session_start")({ reason: "resume" }, ctx);
  await new Promise((done) => setTimeout(done, 250));
  handlers.get("session_shutdown")?.();
  const total = logs.filter((l) => l.includes("speed probe subrouter")).length;
  assert.equal(total, 2, "a start inside the 15 minute window must not probe again");
});

test("the first request waits for the measurement session instead of guessing", async () => {
  const { registered, handlers, ctx } = probeHarness({ cfg: speedConfig, catalog: FAST_CATALOG, latencyMs: latency });
  const fast = registered.find((r) => r.id === "sol-rapido");
  handlers.get("session_start")({ reason: "startup" }, ctx);
  // No waiting: the probe is still running, so route() must return a promise.
  const pending = fast.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(typeof pending?.then, "function", "route must await the measurement in flight");
  const out = await pending;
  handlers.get("session_shutdown")?.();
  assert.equal(out.model.provider, "subrouter-000");
});

test("a chain without speed order never probes", async () => {
  const cfg = { virtuals: [speedConfig.virtuals[1]] };
  const { handlers, logs, ctx } = probeHarness({ cfg, catalog: FAST_CATALOG });
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await new Promise((done) => setTimeout(done, 150));
  handlers.get("session_shutdown")?.();
  assert.equal(logs.filter((l) => l.includes("speed probe")).length, 0);
});

/** Harness that also records event handlers, for the dead-end path. */
function deadEndHarness({ cfg = speedConfig, catalog: cat = FAST_CATALOG, canContinue = true } = {}) {
  const registered = [];
  const handlers = new Map();
  const logs = [];
  const pi = {
    log: (m) => logs.push(m),
    subrouterFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ model_name: "gpt-6.2-sol", input_price: 1, price_currency: "USD" }] }) }),
    registerVirtualModel: (def) => registered.push(def),
    on: (event, handler) => handlers.set(event, handler),
  };
  const ctx = {
    modelRegistry: { find: (provider, id) => cat.find((m) => m.provider === provider && m.id === id) },
    model: undefined,
  };
  const path = join(tmpdir(), `pi-failover-router-deadend-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  process.env.PI_FAILOVER_ROUTER_SPEED_CACHE = join(tmpdir(), `never-${process.pid}.json`);
  failoverRouter(pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  delete process.env.PI_FAILOVER_ROUTER_SPEED_CACHE;
  return { registered, handlers, logs, ctx, canContinue };
}

const STREAM_FAILED = {
  role: "assistant",
  provider: "subrouter-best",
  model: "gpt-6.2-sol",
  stopReason: "error",
  errorMessage: "upstream stream read failed before completion: http2: response body closed",
};

test("an unretryable stream failure moves the next request to the following channel", () => {
  const { registered, handlers, logs, ctx } = deadEndHarness();
  const cheap = registered.find((r) => r.id === "sol");

  // First request lands on the configured first channel.
  const first = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(first.model.provider, "subrouter-best");

  // Pi ends the run without a retry, and the extension takes over.
  ctx.model = { provider: "router", id: "sol" };
  handlers.get("agent_end")({ messages: [{ role: "user" }, STREAM_FAILED] }, ctx);
  assert.match(logs.join("\n"), /taking over subrouter-best\/gpt-6\.2-sol/);

  // The boundary asks for one more request, which must use the next channel.
  const settle = handlers.get("agent_before_settle")({
    outcome: "error",
    continue: false,
    entries: [],
    context: { canContinue: true },
  });
  assert.equal(settle?.continue, true);
  assert.equal(settle.entries[0].type, "custom_message");

  const second = cheap.route({ reason: "continuation", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(second.model.provider, "subrouter-000");
});

test("a request-shaped failure does not take over", () => {
  const { handlers, logs, ctx } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  handlers.get("agent_end")({
    messages: [{ ...STREAM_FAILED, errorMessage: "400 context_length_exceeded: maximum context length is 1050000" }],
  }, ctx);
  assert.equal(logs.filter((l) => l.includes("taking over")).length, 0);
  assert.equal(
    handlers.get("agent_before_settle")({ outcome: "error", entries: [], context: { canContinue: true } }),
    undefined,
  );
});

test("an unknown failure does not take over", () => {
  const { handlers, logs, ctx } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  handlers.get("agent_end")({ messages: [{ ...STREAM_FAILED, errorMessage: "weird sandbox thing" }] }, ctx);
  assert.equal(logs.filter((l) => l.includes("taking over")).length, 0);
});

test("takeover completes the initial chain and three repeats before stopping", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  // The fourth channel must be reached once per pass, even after slow failures.
  const fourChannel = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol barato",
        thinkingLevels: ["high"],
        chain: [
          { model: "subrouter-best/gpt-6.2-sol" },
          { model: "subrouter-000/gpt-6.2-sol" },
          { model: "subrouter-fxpayback/gpt-6.2-sol" },
          { model: "subrouter-xcgx/gpt-6.2-sol" },
        ],
      },
    ],
  };
  const { registered, handlers, logs, ctx } = deadEndHarness({
    cfg: fourChannel,
    catalog: [
      { provider: "subrouter-best", id: "gpt-6.2-sol" },
      { provider: "subrouter-000", id: "gpt-6.2-sol" },
      { provider: "subrouter-fxpayback", id: "gpt-6.2-sol" },
      { provider: "subrouter-xcgx", id: "gpt-6.2-sol" },
    ],
  });
  ctx.model = { provider: "router", id: "sol" };
  const cheap = registered.find((r) => r.id === "sol");
  const tried = [];
  for (let i = 0; i < 16; i += 1) {
    const pending = cheap.route({ reason: "continuation", thinkingLevel: "high", messages: [] }, ctx);
    if (pending?.then) t.mock.timers.tick(2 * 60 * 60_000);
    const out = await pending;
    tried.push(out.model.provider);
    handlers.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider: out.model.provider,
            model: "gpt-6.2-sol",
            stopReason: "error",
            errorMessage: "upstream stream read failed before completion: http2: response body closed",
          },
        ],
      },
      ctx,
    );
    const boundary = handlers.get("agent_before_settle")({ outcome: "error", entries: [], context: { canContinue: true } });
    assert.equal(boundary?.continue, i < 15 ? true : undefined);
  }
  assert.deepEqual(tried, [...Array(4)].flatMap(() => [
    "subrouter-best", "subrouter-000", "subrouter-fxpayback", "subrouter-xcgx",
  ]));
  assert.match(logs.join("\n"), /recovery exhausted/);
  assert.throws(() => cheap.route({ reason: "continuation", messages: [] }, ctx), /recovery exhausted/);
});

test("a channel that keeps failing is cooled down for longer each time", () => {
  const streaks = new Map();
  assert.equal(noteFailure(streaks, "a/one"), 0);
  assert.equal(noteFailure(streaks, "a/one"), 1);
  assert.equal(noteFailure(streaks, "a/one"), 2);
  assert.equal(streaks.get("a/one"), 3);
});

test("the takeover continues even when the error context reports it cannot", () => {
  const { registered, handlers, ctx } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  const cheap = registered.find((r) => r.id === "sol");
  handlers.get("agent_end")({ messages: [STREAM_FAILED] }, ctx);
  // Pi builds this context from the entries that exist BEFORE the handler runs, so
  // after an assistant error it always says false. The marker entry is what makes
  // the final context runnable, and Pi re-checks it after committing that entry.
  const settle = handlers.get("agent_before_settle")({
    outcome: "error",
    entries: [],
    context: { canContinue: false },
  });
  assert.equal(settle?.continue, true);
  assert.equal(settle.entries[0].type, "custom_message");
  // The continuation lands on the rotated channel.
  const next = cheap.route({ reason: "continuation", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(next.model.provider, "subrouter-000");
});

test("a pending rotation for another virtual does not force a continuation", () => {
  const { handlers, ctx } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  handlers.get("agent_end")({ messages: [STREAM_FAILED] }, ctx);
  // The session switched virtual after the failure, so its request cannot consume a
  // rotation that belongs to `sol`; asking for one would end on the same channel.
  const settle = handlers.get("agent_before_settle")(
    { outcome: "error", entries: [], context: { canContinue: false } },
    { model: { provider: "router", id: "other" }, modelRegistry: ctx.modelRegistry },
  );
  assert.equal(settle, undefined);
});

test("a user request never lands on a channel that is still cooling", () => {
  const { ctx, registered, fire } = boot();
  const cheap = registered.find((r) => r.id === "sol");
  const selected = { provider: "router", id: "sol" };

  const first = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(first.model.provider, "subrouter-best");

  // That channel answers with a channel-owned 400 the human has to read today.
  fire(
    "agent_end",
    { messages: [{ role: "user" }, { ...STREAM_FAILED, provider: "subrouter-best" }] },
    { model: selected },
  );

  // A manual resend is a new `user` request: it must not return to the channel
  // that just failed, or the human keeps reading the same error.
  const retry = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(retry.model.provider, "subrouter-000");
});

test("a user request still routes when every channel is cooling", () => {
  const { ctx, registered, fire } = boot();
  const cheap = registered.find((r) => r.id === "sol");
  const selected = { provider: "router", id: "sol" };

  for (const provider of ["subrouter-best", "subrouter-000", "subrouter-fxpayback"]) {
    fire(
      "agent_end",
      { messages: [{ role: "user" }, { ...STREAM_FAILED, provider }] },
      { model: selected },
    );
  }

  // A real new user prompt clears recovery but preserves cooldown history.
  fire("before_agent_start", {}, { model: selected });
  const fallback = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(fallback.model.provider, "subrouter-best");
});

test("the loaded build is announced so a stale process is visible", () => {
  const { logs } = boot();
  assert.match(logs.join("\n"), /failover-router: build [0-9a-f]{8} loaded \(pid \d+\)/);
});

test("a missing config file registers nothing and does not throw", () => {
  const h = harness({ config, catalog });
  process.env.PI_FAILOVER_ROUTER_CONFIG = "/tmp/definitely-not-here-9f2.json";
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  assert.equal(h.registered.length, 0);
});

test("invalid config is reported through pi.log and registers nothing", () => {
  const h = harness({ config, catalog });
  const path = join(tmpdir(), "pi-failover-router-bad.json");
  writeFileSync(path, JSON.stringify({ virtuals: [{ provider: "r", id: "x", chain: [] }] }));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  assert.equal(h.registered.length, 0);
  assert.match(h.logs.join("\n"), /config not loaded/);
});

test("a probe failure is persisted, not silently dropped", async () => {
  const { handlers, logs, ctx, speedPath } = probeHarness({
    cfg: speedConfig,
    catalog: FAST_CATALOG,
    latencyMs: () => 5,
  });
  // A registry that answers, but reports no usage: the probe must record a failure.
  ctx.modelRegistry.complete = async () => ({ usage: { output: 0 } });
  handlers.get("session_start")({ reason: "startup" }, ctx);
  await settle(() => logs.filter((l) => l.includes("probe reported no output tokens")).length >= 2);
  handlers.get("session_shutdown")?.();
  const persisted = JSON.parse(readFileSync(speedPath, "utf8"));
  const failed = Object.values(persisted.channels).filter((e) => e.attempts?.at(-1)?.ok === false);
  assert.equal(failed.length, 2, "both channels record why they could not be measured");
  assert.match(failed[0].attempts.at(-1).message, /no output tokens/);
});

test("a request does not wait forever for a measurement session", async () => {
  const { registered, handlers, ctx, logs } = probeHarness({
    cfg: speedConfig,
    catalog: FAST_CATALOG,
    // Far longer than the wait budget, so racing matters.
    latencyMs: () => MEASURE_WAIT_MS + 400,
  });
  const fast = registered.find((r) => r.id === "sol-rapido");
  handlers.get("session_start")({ reason: "startup" }, ctx);
  const startedAt = Date.now();
  const out = await fast.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  const elapsed = Date.now() - startedAt;
  handlers.get("session_shutdown")?.();
  assert.ok(elapsed < MEASURE_WAIT_MS + 1000, `routed after ${elapsed} ms`);
  assert.equal(out.model.provider, "subrouter-best", "falls back to the configured order");
  assert.match(logs.join("\n"), /routing without waiting further/);
});

test("a channel comes back by itself when its cooldown expires, without a new session", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { registered, handlers, ctx } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  const cheap = registered.find((r) => r.id === "sol");

  const fail = (provider) =>
    handlers.get("agent_end")(
      {
        messages: [
          {
            role: "assistant",
            provider,
            model: "gpt-6.2-sol",
            stopReason: "error",
            errorMessage: "upstream stream read failed before completion: http2: response body closed",
          },
        ],
      },
      ctx,
    );

  // Burn the whole two-channel chain.
  const first = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(first.model.provider, "subrouter-best");
  fail("subrouter-best");
  const second = cheap.route({ reason: "continuation", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(second.model.provider, "subrouter-000");
  fail("subrouter-000");

  // Both are cooling: recovery waits for the first channel of the next pass.
  const blocked = cheap.route({ reason: "continuation", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(typeof blocked?.then, "function");
  t.mock.timers.tick(3 * 60_000);
  assert.equal((await blocked).model.provider, "subrouter-best");
  const recovered = cheap.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
  assert.equal(recovered.model.provider, "subrouter-best");
});

test("a successful response clears the channel's failure streak", async () => {
  const { noteSuccess } = await import("../index.js");
  const streaks = new Map([["a/one", 4]]);
  noteSuccess(streaks, "a/one");
  assert.equal(streaks.has("a/one"), false);
});

test("a clean run clears the streak of the channel that answered", () => {
  const { handlers, ctx, logs } = deadEndHarness();
  ctx.model = { provider: "router", id: "sol" };
  // A successful end-of-run message from a physical channel.
  handlers.get("agent_end")({
    messages: [{ role: "assistant", provider: "subrouter-best", model: "gpt-6.2-sol", stopReason: "stop" }],
  }, ctx);
  // Nothing is rotated and nothing is logged for a clean run.
  assert.equal(logs.filter((l) => l.includes("taking over")).length, 0);
});

/** The unretryable failure that ends a run without Pi ever asking for a retry. */
const http2Failure = {
  role: "assistant",
  provider: "subrouter-fxpayback",
  model: "gpt-6.2-sol",
  stopReason: "error",
  errorMessage: "upstream stream read failed before completion: http2: response body closed",
  usage: { output: 0 },
};

test("a session pinned to a physical model says failover is not active", () => {
  const { fire, logs } = boot();
  // The session selected the channel itself, so no router/* route is ever asked.
  fire("agent_end", { messages: [http2Failure] }, { model: { provider: "subrouter-fxpayback", id: "gpt-6.2-sol" } });
  const reported = logs.find((l) => l.includes("bypasses failover"));
  assert.ok(reported, `expected a bypass report, got: ${logs.join(" | ")}`);
  assert.match(reported, /subrouter-fxpayback\/gpt-6\.2-sol/);
  assert.match(reported, /router\/sol/);
});

test("a virtual model that fails still takes over, as before", () => {
  const { fire, logs } = boot();
  fire("agent_end", { messages: [http2Failure] }, { model: { provider: "router", id: "sol" } });
  const takeover = logs.find((l) => l.includes("taking over"));
  assert.ok(takeover, `expected a takeover, got: ${logs.join(" | ")}`);
  assert.match(takeover, /next (subrouter-best|subrouter-000)\/gpt-6\.2-sol/);
});

test("session_start reports a physical selection that has a router equivalent", () => {
  const { fire, logs } = boot();
  fire("session_start", {}, { model: { provider: "subrouter-best", id: "gpt-6.2-sol" } });
  assert.ok(logs.some((l) => l.includes("bypasses failover")), logs.join(" | "));
});

test("session_start stays quiet on a virtual model", () => {
  const { fire, logs } = boot();
  fire("session_start", {}, { model: { provider: "router", id: "sol" } });
  assert.equal(logs.some((l) => l.includes("bypasses failover")), false, logs.join(" | "));
});

test("a channel-owned error Pi would abandon is made retryable", () => {
  const { fire } = boot();
  const [replacement] = fire("message_end", { message: http2Failure });
  assert.ok(replacement, "expected a replacement message");
  assert.ok(replacement.errorMessage.startsWith(http2Failure.errorMessage), replacement.errorMessage);
  assert.match(replacement.errorMessage, /upstream_stream_read_error/);
});

test("the provider's unclassified error is made retryable and taken over", () => {
  const message = {
    ...http2Failure,
    errorMessage: "当前请求未成功。 原因：请求处理过程中出现未归类错误。 解决方案：请稍后重试；如果问题持续，请带 request_id 联系客服排查。 request_id: 202611211239031829861288268d9d6npAmIEqM",
  };
  const { fire, logs } = boot();
  const [replacement] = fire("message_end", { message });
  assert.ok(replacement, "expected the error to be annotated for Pi's retry");
  assert.ok(replacement.errorMessage.startsWith(message.errorMessage));
  assert.match(replacement.errorMessage, /upstream_stream_read_error/);

  fire("agent_end", { messages: [message] }, { model: { provider: "router", id: "sol" } });
  const recorded = logs.find(l => l.includes("failure recorded") && l.includes("upstream_unclassified"));
  assert.ok(recorded, `expected classification to be recorded, got: ${logs.join(" | ")}`);
  const takeover = logs.find(l => l.includes("taking over"));
  assert.ok(takeover, `expected terminal takeover, got: ${logs.join(" | ")}`);
  assert.doesNotMatch(takeover, /next subrouter-fxpayback\/gpt-6\.2-sol/);
});

test("the upstream do-request failure is made retryable and taken over", () => {
  const message = {
    ...http2Failure,
    errorMessage: "Error: upstream error: do request failed (request id: 20261121143209442001439RP9kQHsq)",
  };
  const { fire, logs } = boot();
  const [replacement] = fire("message_end", { message });
  assert.ok(replacement, "expected the error to be annotated for Pi's retry");
  assert.ok(replacement.errorMessage.startsWith(message.errorMessage));
  assert.match(replacement.errorMessage, /upstream_stream_read_error/);

  fire("agent_end", { messages: [message] }, { model: { provider: "router", id: "sol" } });
  const recorded = logs.find(l => l.includes("failure recorded") && l.includes("upstream_request_failed"));
  assert.ok(recorded, `expected classification to be recorded, got: ${logs.join(" | ")}`);
  const takeover = logs.find(l => l.includes("taking over"));
  assert.ok(takeover, `expected terminal takeover, got: ${logs.join(" | ")}`);
  assert.doesNotMatch(takeover, /next subrouter-fxpayback\/gpt-6\.2-sol/);
});

test("a request-shaped error is never made retryable", () => {
  const { fire } = boot();
  const [replacement] = fire("message_end", {
    message: { ...http2Failure, errorMessage: "context window exceeded: 1050000 tokens" },
  });
  assert.equal(replacement, undefined);
});

test("a single-channel failure keeps provider text and enables a bounded repeat", () => {
  const single = {
    virtuals: [
      {
        provider: "router",
        id: "solo",
        name: "Solo",
        thinkingLevels: ["high"],
        chain: [{ model: "subrouter-fxpayback/gpt-6.2-sol" }],
      },
    ],
  };
  const { fire } = boot(single);
  const [replacement] = fire("message_end", { message: http2Failure });
  assert.ok(replacement.errorMessage.startsWith(http2Failure.errorMessage));
  assert.match(replacement.errorMessage, /upstream_stream_read_error/);
});

test("a message that did not fail is left alone", () => {
  const { fire } = boot();
  const [replacement] = fire("message_end", {
    message: { ...http2Failure, stopReason: "stop", errorMessage: undefined },
  });
  assert.equal(replacement, undefined);
});

test("a virtual never offers a level the router cannot send", () => {
  const cfg = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol failover",
        thinkingLevels: ["off", "minimal", "high"],
        chain: [{ model: "subrouter-best/gpt-6.2-sol" }],
      },
    ],
  };
  const { registered } = boot(cfg);
  assert.deepEqual(registered[0].thinkingLevels, ["high"]);
});

test("a selected off is replaced by a level the channel accepts", () => {
  const cat = [
    {
      provider: "subrouter-best",
      id: "gpt-6.2-sol",
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    },
  ];
  const cfg = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol failover",
        thinkingLevels: ["high"],
        chain: [{ model: "subrouter-best/gpt-6.2-sol" }],
      },
    ],
  };
  const { registered, ctx } = boot(cfg, cat);
  const out = registered[0].route({ reason: "user", thinkingLevel: "off", messages: [] }, ctx);
  assert.notEqual(out.thinkingLevel, "off");
  assert.equal(out.thinkingLevel, "low");
});

test("a virtual whose only levels are inadmissible still offers usable ones", () => {
  const cfg = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol failover",
        thinkingLevels: ["off", "minimal"],
        chain: [{ model: "subrouter-best/gpt-6.2-sol" }],
      },
    ],
  };
  const { registered } = boot(cfg);
  assert.deepEqual(registered[0].thinkingLevels, ["low", "medium", "high"]);
});

test("an inadmissible level in the config is reported, not dropped silently", () => {
  const cfg = {
    virtuals: [
      {
        provider: "router",
        id: "sol",
        name: "Sol failover",
        thinkingLevels: ["off", "high"],
        chain: [{ model: "subrouter-best/gpt-6.2-sol" }],
      },
    ],
  };
  const { registered, logs } = boot(cfg);
  assert.deepEqual(registered[0].thinkingLevels, ["high"]);
  assert.equal(
    logs.some((m) => /off/.test(m) && /ignor/i.test(m)),
    true,
    "the user must learn that off was dropped from the config",
  );
});

test("the probe writes its messages to the decision log, not only to pi.log", async () => {
  const { handlers, ctx, decisionLog } = probeHarness({
    cfg: speedConfig,
    catalog: FAST_CATALOG,
    latencyMs: () => 5,
  });
  handlers.get("session_start")({ reason: "startup" }, ctx);
  await settle(() => {
    try {
      return readFileSync(decisionLog, "utf8").includes("speed probe");
    } catch {
      return false;
    }
  });
  handlers.get("session_shutdown")?.();
  const written = readFileSync(decisionLog, "utf8");
  assert.match(
    written,
    /speed probe .*tok\/s/,
    "a measurement must leave a durable record of what it measured",
  );
});
