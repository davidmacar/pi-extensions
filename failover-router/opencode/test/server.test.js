import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.js";

const env = { LOCAL: "fixture-local", REMOTE: "fixture-upstream" };
const config = { apiKeyEnv: "LOCAL", channels: { a: { baseURL: "https://provider.invalid/v1", apiKeyEnv: "REMOTE" } }, profiles: { cheap: { chain: [{ channel: "a", model: "m" }] } } };
const headers = { authorization: `Bearer ${env.LOCAL}`, "content-type": "application/json" };

test("HTTP boundary enforces auth, exact paths and method before dispatch", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "ai-extensions-http-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0;
  const gw = await startGateway({ config, env, stateDir, port: 0, fetchImpl: async (target, options) => {
    ++calls;
    assert.equal(target, "https://provider.invalid/v1/chat/completions");
    assert.equal(options.headers.authorization, "Bearer fixture-upstream");
    assert.equal(options.headers.cookie, undefined);
    return Response.json({ id: "success" });
  } });
  t.after(() => gw.close());
  const body = '{"model":"cheap"}';
  for (const [path, method, requestHeaders, status] of [
    ["/v1/chat/completions?extra=1", "POST", headers, 404],
    ["/v1/chat/completions", "GET", headers, 405],
    ["/v1/chat/completions", "POST", {}, 401],
    ["/v1/models", "GET", {}, 401],
  ]) {
    const result = await fetch(gw.url + path, { method, headers: requestHeaders, body: method === "POST" ? body : undefined });
    assert.equal(result.status, status);
    await result.json();
    assert.equal(calls, 0);
  }
  const models = await fetch(`${gw.url}/v1/models`, { headers });
  assert.deepEqual((await models.json()).data.map(item => item.id), ["cheap"]);
  const success = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { ...headers, cookie: "client=fixture" }, body });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { id: "success" });
  assert.equal(calls, 1);
});

test("gateway applies marketplace order and reuses fresh prices after restart", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "ai-extensions-metrics-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const pricedConfig = { ...config, refreshMarketplace: true, channels: {
    "subrouter-first": { ...config.channels.a, baseURL: "https://first.invalid/v1" },
    "subrouter-second": { ...config.channels.a, baseURL: "https://second.invalid/v1" },
  }, profiles: { cheap: { order: "cost", chain: [
    { channel: "subrouter-first", model: "m" }, { channel: "subrouter-second", model: "m" },
  ] } } };
  const marketplace = [];
  const dispatched = [];
  const fetchImpl = async target => {
    const url = new URL(target);
    if (url.hostname === "subrouter.ai") {
      marketplace.push(url.searchParams.get("model"));
      return Response.json({ success: true, data: [
        { provider_slug: "first", model_name: "m", input_price: 2, price_currency: "CNY" },
        { provider_slug: "second", model_name: "m", input_price: 1, price_currency: "CNY" },
      ] });
    }
    dispatched.push(url.hostname);
    return Response.json({ id: "priced" });
  };
  for (let restart = 0; restart < 2; restart++) {
    const gw = await startGateway({ config: pricedConfig, env, port: 0, stateDir, fetchImpl });
    try {
      const res = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers, body: '{"model":"cheap"}' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-failover-channel"), "subrouter-second");
      assert.deepEqual(await res.json(), { id: "priced" });
    } finally { await gw.close(); }
  }
  assert.deepEqual(marketplace, ["m", "m"]); // Once per ref, only on the first start.
  assert.deepEqual(dispatched, ["second.invalid", "second.invalid"]);
});

test("ledger records the responding channel, usage and tariff without persisting prompts", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "ai-extensions-ledger-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0;
  const priced = { ...config, channels: { a: { ...config.channels.a, baseURL: "https://provider.invalid/v1" } }, profiles: { cheap: { order: "cost", chain: [{ channel: "a", model: "m" }] } } };
  const gw = await startGateway({ config: priced, env, stateDir, port: 0, fetchImpl: async () => {
    ++calls;
    return Response.json({ id: "priced", usage: { prompt_tokens: 100, completion_tokens: 50 } });
  } });
  t.after(() => gw.close());
  const result = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "cheap", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }) });
  assert.equal(result.status, 200); assert.equal(calls, 1);
  await gw.close();
  const ledger = JSON.parse((await readFile(join(stateDir, "cost-ledger.ndjson"), "utf8")).trim());
  assert.deepEqual({ channel: ledger.channel, model: ledger.model, status: ledger.cost.status, usage: ledger.usage }, { channel: "a", model: "m", status: "unknown", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cacheWriteTokens: null } });
  assert.doesNotMatch(JSON.stringify(ledger), /PRIVATE_PROMPT/);
});

test("closing the gateway aborts active provider work without retrying", { timeout: 3000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "ai-extensions-abort-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const started = Promise.withResolvers(); const aborted = Promise.withResolvers();
  let attempts = 0;
  const gw = await startGateway({ config, env, stateDir, port: 0, fetchImpl: async (_target, { signal }) => {
    ++attempts; started.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => {
      aborted.resolve(); reject(signal.reason);
    }, { once: true }));
  } });
  t.after(() => gw.close());
  const client = fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers, body: '{"model":"cheap"}' }).catch(error => error);
  await started.promise;
  await gw.close();
  await aborted.promise;
  assert.ok(await client instanceof Error);
  assert.equal(attempts, 1);
  const row = JSON.parse(await readFile(join(stateDir, "cost-ledger.ndjson"), "utf8"));
  assert.equal(row.outcome, "aborted");
  assert.equal(row.failureKind, "aborted");
  assert.equal(row.cost.amount, null);
});


for (const protocol of ["chat/completions", "responses"]) {
  test(`priced failover accounts for both physical attempts over ${protocol}`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), "ai-extensions-priced-fallback-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const model = "vendor/model:variant";
    const routes = { ...config, channels: Object.fromEntries(["a", "b"].map(name => [
      `subrouter-${name}`, { baseURL: `https://${name}.invalid/v1`, apiKeyEnv: "REMOTE" },
    ])), profiles: { cheap: { order: "cost", protocol, chain: ["b", "a"].map(name => ({ channel: `subrouter-${name}`, model })) } } };
    const chat = protocol === "chat/completions";
    const usage = (input, output) => chat ? { prompt_tokens: input, completion_tokens: output }
      : { input_tokens: input, output_tokens: output };
    const calls = [];
    const gw = await startGateway({ config: routes, env: { ...env, SUBROUTER_API_KEY: "fixture-relay-key", SUBROUTER_PRICE_CACHE_DIR: join(stateDir, "prices") },
      stateDir, port: 0, now: () => 1234, fetchImpl: async url => {
        const host = new URL(url).hostname;
        calls.push(host);
        if (host === "subrouter.ai") return Response.json({ success: true, data: [
          { provider_slug: "a", model_name: model, input_price: 1, output_price: 2, price_currency: "CNY" },
          { provider_slug: "b", model_name: model, input_price: 3, output_price: 4, price_currency: "CNY" },
        ] });
        if (host === "a.invalid") return Response.json({ error: { message: "retry later", secret: "PRIVATE_UPSTREAM" }, usage: usage(10, 5) }, { status: 429 });
        const frames = chat
          ? [{ choices: [{ finish_reason: "stop" }] }, { choices: [], usage: usage(100, 50) }]
          : [{ type: "response.completed", response: { usage: usage(100, 50) } }];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + (chat ? "data: [DONE]\n\n" : ""),
          { headers: { "content-type": "text/event-stream" } });
      } });
    t.after(() => gw.close());
    const res = await fetch(`${gw.url}/v1/${protocol}`, { method: "POST", headers, body: '{"model":"cheap","stream":true}' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-failover-channel"), "subrouter-b");
    await res.text();
    assert.deepEqual(calls, ["subrouter.ai", "a.invalid", "b.invalid"]);
    const raw = await readFile(join(stateDir, "cost-ledger.ndjson"), "utf8");
    const rows = raw.trimEnd().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => [row.attempt, row.channel, row.model, row.outcome, row.cost.amount, row.tariff.fetchedAt]), [
      [1, "subrouter-a", model, "failed", 0.00002, 1234], [2, "subrouter-b", model, "succeeded", 0.0005, 1234],
    ]);
    assert.equal(rows[0].requestId, rows[1].requestId);
    assert.doesNotMatch(raw, /PRIVATE_UPSTREAM|fixture-relay-key|fixture-upstream/);
  });
}
