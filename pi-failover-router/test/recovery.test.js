import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import failoverRouter from "../index.js";

// Exercise the extension's public hooks and virtual route, not private maps.
function runtime(t, providers = ["a", "b", "c", "d"], extraChains = []) {
  const dir = mkdtempSync(join(tmpdir(), "router-recovery-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ virtuals: [providers, ...extraChains].map((chain, i) => ({
    provider: "router", id: i ? `other-${i}` : "test", name: "Test",
    chain: chain.map(p => ({ model: `${p}/model` })),
  })) }));
  const old = { ...process.env };
  process.env.PI_FAILOVER_ROUTER_CONFIG = config;
  process.env.PI_FAILOVER_ROUTER_LOG = join(dir, "decisions.log");
  process.env.PI_FAILOVER_ROUTER_NO_PATCHER = "1";
  const handlers = new Map();
  const logs = [];
  let route;
  const routes = new Map();
  const ctx = {
    model: { provider: "router", id: "test" },
    modelRegistry: { find: (provider, id) => providers.includes(provider) && id === "model" ? { provider, id } : undefined },
  };
  failoverRouter({
    registerVirtualModel: def => {
      routes.set(def.id, def.route);
      if (def.id === "test") route = def.route;
    },
    log: text => logs.push(text),
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  });
  process.env = old;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let state;
  let last;
  let serial = 0;
  const fire = (name, event) => (handlers.get(name) ?? []).map(fn => fn(event, ctx));
  const send = async (reason = "continuation", signal, persist = true) => {
    const request = { reason, state: persist ? state : undefined, messages: [], signal, thinkingLevel: "high" };
    if (reason === "retry") request.failed = { model: { provider: last.provider, id: "model" }, message: last };
    const pending = route(request, ctx);
    // All cooldowns used in this fixture are <= 2 hours. No real waiting.
    if (pending?.then) t.mock.timers.tick(2 * 60 * 60_000);
    const result = await pending;
    state = result.state ?? state;
    return result.model.provider;
  };
  const fail = (provider, errorMessage = "upstream stream read failed before completion: http2: response body closed") => {
    last = { role: "assistant", provider, model: "model", stopReason: "error", errorMessage, timestamp: ++serial };
    fire("message_end", { message: last });
    fire("agent_end", { messages: [last] });
    return last;
  };
  const boundary = (outcome = "error") => fire("agent_before_settle", { outcome, entries: [], context: { canContinue: false } }).find(Boolean);
  return { ctx, logs, fire, send, fail, boundary, route, routes, get state() { return state; } };
}

test("initial pass plus exactly three complete repeats, including slow failures", async t => {
  const r = runtime(t);
  const tried = [];
  for (let i = 0; i < 16; i++) {
    const provider = await r.send(i === 0 ? "user" : "continuation");
    tried.push(provider);
    // A slow error must not let an already-tried channel re-enter this pass.
    t.mock.timers.tick(3 * 60_000);
    r.fail(provider);
    const result = r.boundary();
    assert.equal(result?.continue, i < 15 ? true : undefined, `attempt ${i + 1}`);
  }
  assert.deepEqual(tried, [...Array(4)].flatMap(() => ["a", "b", "c", "d"]));
  assert.match(r.logs.join("\n"), /exhausted.*3.*repeat/i);
  assert.equal(r.boundary(), undefined);
  await assert.rejects(r.send("continuation"), /recovery exhausted/);
});

test("native retries and takeover share a budget and count each failure once", async t => {
  const r = runtime(t, ["a", "b"]);
  let provider = await r.send("user");
  const tried = [provider];
  for (let i = 0; i < 8; i++) {
    const failure = r.fail(provider, "503 service unavailable");
    r.fire("agent_end", { messages: [structuredClone(failure)] });
    if (i === 7) break;
    if (i % 2) assert.equal(r.boundary()?.continue, true);
    provider = await r.send(i % 2 ? "user" : "retry");
    tried.push(provider);
  }
  assert.deepEqual(tried, ["a", "b", "a", "b", "a", "b", "a", "b"]);
  assert.equal(r.boundary(), undefined);
  assert.equal(r.logs.filter(l => /failure recorded/.test(l)).length, 8);
  await assert.rejects(r.send("retry"), /recovery exhausted/);
});

test("a single-channel chain also has four attempts, waiting for cooldowns", async t => {
  const r = runtime(t, ["a"]);
  for (let i = 0; i < 4; i++) {
    assert.equal(await r.send(i ? "continuation" : "user"), "a");
    r.fail("a");
    assert.equal(r.boundary()?.continue, i < 3 ? true : undefined);
  }
});

test("cooldown wait rejects on cancellation without dispatching or continuing", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  assert.equal(r.boundary()?.continue, true);
  const controller = new AbortController();
  const pending = r.route({ reason: "user", messages: [], state: r.state, signal: controller.signal }, r.ctx);
  assert.equal(typeof pending?.then, "function");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  t.mock.timers.tick(2 * 60 * 60_000);
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 0);
  assert.equal(r.boundary(), undefined);
});

test("success starts a new recovery episode without resetting the session", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  r.boundary();
  await r.send();
  r.fire("message_end", { message: { role: "assistant", provider: "a", model: "model", stopReason: "toolUse" } });
  r.fire("agent_end", { messages: [{ role: "assistant", provider: "a", model: "model", stopReason: "stop" }] });
  for (let i = 0; i < 4; i++) {
    await r.send();
    r.fail("a");
    assert.equal(r.boundary()?.continue, i < 3 ? true : undefined);
  }
});

test("request errors, unknown errors and cancellation never start replay", async t => {
  const r = runtime(t, ["a"]);
  for (const text of ["400 context_length_exceeded: maximum context length", "malformed json", "weird sandbox thing", ""]) {
    r.fire("before_agent_start", { messageType: "user" });
    await r.send("user");
    r.fail("a", text);
    assert.equal(r.boundary(), undefined);
  }
  r.fire("agent_end", { messages: [{ role: "assistant", provider: "a", model: "model", stopReason: "aborted" }] });
  assert.equal(r.boundary("aborted"), undefined);
});

test("routes without persisted state have the same four-pass budget", async t => {
  const r = runtime(t, ["a"]);
  for (let i = 0; i < 4; i++) {
    await r.send(i ? "continuation" : "user", undefined, false);
    r.fail("a");
    assert.equal(r.boundary()?.continue, i < 3 ? true : undefined);
  }
  await assert.rejects(r.send("retry", undefined, false), /recovery exhausted/);
});

test("new prompt aborts a pending wait and ignores stale persisted episode state", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  const pending = r.route({ reason: "continuation", messages: [], state: r.state }, r.ctx);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  r.fire("before_agent_start", {});
  await rejected;
  const fresh = r.route({ reason: "user", messages: [], state: r.state }, r.ctx);
  assert.equal(fresh?.then, undefined, "new user request must not inherit the wait");
  assert.equal(fresh.model.provider, "a");
  r.fail("a");
  assert.equal(r.boundary()?.continue, true);
});

test("overlapping cooldown routes consume a single dispatch and settle marker", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  assert.equal(r.boundary()?.continue, true);
  assert.equal(r.boundary(), undefined);
  const request = { reason: "continuation", messages: [], state: r.state };
  const first = r.route(request, r.ctx);
  const second = r.route(request, r.ctx);
  t.mock.timers.tick(2 * 60 * 60_000);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 1);
});

test("late duplicate lifecycle errors cannot replace the next channel's plan", async t => {
  const r = runtime(t, ["a", "b"]);
  await r.send("user");
  const old = r.fail("a");
  await r.send("retry");
  r.fire("message_end", { message: structuredClone(old) });
  r.fire("agent_end", { messages: [structuredClone(old)] });
  assert.equal(r.boundary(), undefined);
  assert.equal(r.logs.filter(l => /failure recorded/.test(l)).length, 1);
  r.fail("b");
  assert.equal(r.boundary()?.continue, true);
});

test("native request-shaped retry retains its model and level after message_end", async t => {
  const r = runtime(t, ["a", "b"]);
  await r.send("user");
  const message = r.fail("a", "400 context_length_exceeded: maximum context length");
  const result = r.route({
    reason: "retry", messages: [], state: r.state,
    failed: { model: { provider: "a", id: "model" }, thinkingLevel: "high", message },
  }, r.ctx);
  assert.equal(result?.then, undefined);
  assert.equal(result.model.provider, "a");
  assert.equal(result.thinkingLevel, "high");
  assert.equal(r.boundary(), undefined);
});

test("direct routing remains synchronous and keeps the previous model and level", t => {
  const r = runtime(t, ["a", "b"]);
  const result = r.route({
    reason: "direct", messages: [], thinkingLevel: "xhigh",
    previous: { model: { provider: "b", id: "model" }, thinkingLevel: "high" },
  }, r.ctx);
  assert.equal(result?.then, undefined);
  assert.equal(result.model.provider, "b");
  assert.equal(result.thinkingLevel, "high");
});

test("B1: second overlapping waiter honors its own signal and returns no model", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  const first = new AbortController();
  const second = new AbortController();
  const p1 = r.route({ reason: "continuation", messages: [], signal: first.signal }, r.ctx);
  const p2 = r.route({ reason: "continuation", messages: [], signal: second.signal }, r.ctx);
  const rejected = assert.rejects(p2, { name: "AbortError", message: "Channel recovery cancelled" });
  second.abort();
  t.mock.timers.tick(2 * 60_000);
  await rejected;
  // The cancelled observer cannot receive a model; the remaining caller still
  // owns one dispatch of the shared recovery decision.
  assert.equal((await p1).model.provider, "a");
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 1);
});

test("B2: extended shared cooldown is rechecked at wake before dispatch", async t => {
  const r = runtime(t, ["a"], [["a"]]);
  await r.send("user");
  r.fail("a", "503 service unavailable");
  let dispatched = false;
  const pending = r.route({ reason: "continuation", messages: [] }, r.ctx).then(result => {
    dispatched = true;
    return result;
  });
  t.mock.timers.tick(60_000);
  r.ctx.model.id = "other-1";
  r.routes.get("other-1")({ reason: "user", messages: [] }, r.ctx);
  r.fail("a", "503 service unavailable");
  r.ctx.model.id = "test";
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(dispatched, false, "old deadline is no longer eligible");
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 0);
  t.mock.timers.tick(179_999);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(dispatched, false, "extended deadline minus one millisecond");
  t.mock.timers.tick(1);
  assert.equal((await pending).model.provider, "a");
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 1);
});

test("B2: extended cooldown wait remains abortable", async t => {
  const r = runtime(t, ["a"], [["a"]]);
  await r.send("user");
  r.fail("a", "503 service unavailable");
  const controller = new AbortController();
  const pending = r.route({ reason: "continuation", messages: [], signal: controller.signal }, r.ctx);
  const rejected = assert.rejects(pending, { name: "AbortError", message: "Channel recovery cancelled" });
  t.mock.timers.tick(60_000);
  r.ctx.model.id = "other-1";
  r.routes.get("other-1")({ reason: "user", messages: [] }, r.ctx);
  r.fail("a", "503 service unavailable");
  r.ctx.model.id = "test";
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  controller.abort();
  await rejected;
  t.mock.timers.tick(2 * 60 * 60_000);
  assert.equal(r.logs.filter(l => /continuing on/.test(l)).length, 0);
  assert.equal(r.boundary(), undefined);
});

for (const reason of ["direct", "continuation", "retry"]) {
  test(`B3: ${reason} preserves the supplied physical model object and overrides`, t => {
    const r = runtime(t, ["a", "b"]);
    const model = {
      provider: "a", id: "model", name: "Runtime override", api: "openai-responses",
      baseUrl: "https://override.invalid/v1", contextWindow: 12345,
      thinkingLevelMap: { high: "runtime-high", xhigh: null },
    };
    const request = reason === "retry" ? {
      reason, messages: [], failed: { model, thinkingLevel: "high", message: {
        role: "assistant", provider: "a", model: "model", stopReason: "error",
        errorMessage: "400 context_length_exceeded", timestamp: 1,
      } },
    } : { reason, messages: [], previous: { model, thinkingLevel: "high" } };
    const result = r.route(request, r.ctx);
    assert.equal(result?.then, undefined);
    assert.strictEqual(result.model, model, "not the catalog copy");
    const { state, ...dispatch } = result;
    assert.deepEqual(dispatch, { model, thinkingLevel: "high" });
    assert.equal(r.boundary(), undefined);
  });
}

test("B4: a selected physical session is neither annotated nor taken over", t => {
  const r = runtime(t, ["a", "b"]);
  r.ctx.model = { provider: "a", id: "model" };
  const message = {
    role: "assistant", provider: "a", model: "model", stopReason: "error",
    errorMessage: "upstream stream read failed before completion: http2: response body closed",
  };
  const before = structuredClone(message);
  assert.deepEqual(r.fire("message_end", { message }), [undefined]);
  r.fire("agent_end", { messages: [message] });
  assert.deepEqual(message, before);
  assert.equal(r.boundary(), undefined);
  assert.equal(r.logs.filter(l => /failure recorded/.test(l)).length, 0);
  assert.match(r.logs.join("\n"), /bypasses failover/);
});

test("custom continuation keeps its recovery pass until a real new prompt", async t => {
  const r = runtime(t, ["a"]);
  await r.send("user");
  r.fail("a");
  const marker = r.boundary();
  assert.equal(marker.entries[0].customType, "failover-router.continue");
  const pending = r.route({ reason: "user", messages: marker.entries, state: r.state }, r.ctx);
  assert.equal(typeof pending?.then, "function");
  t.mock.timers.tick(2 * 60_000);
  const continuation = await pending;
  assert.equal(continuation.state.pass, 1);
  r.fire("before_agent_start", {});
  const fresh = r.route({ reason: "user", messages: [], state: continuation.state }, r.ctx);
  assert.equal(fresh?.then, undefined);
  assert.equal(fresh.state.pass, 0);
});

test("non-rotatable errors clear a previously planned takeover", async t => {
  const r = runtime(t, ["a", "b"]);
  await r.send("user");
  r.fail("a");
  r.fire("message_end", { message: { role: "assistant", provider: "a", model: "model", stopReason: "error", errorMessage: "malformed json" } });
  assert.equal(r.boundary(), undefined);
});
