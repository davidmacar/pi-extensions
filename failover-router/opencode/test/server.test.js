import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.js";

const env = { LOCAL: "fixture-local", REMOTE: "fixture-upstream" };
const config = { apiKeyEnv: "LOCAL", channels: { a: { baseURL: "https://provider.invalid/v1", apiKeyEnv: "REMOTE" } }, profiles: { cheap: { chain: [{ channel: "a", model: "m" }] } } };
const headers = { authorization: `Bearer ${env.LOCAL}`, "content-type": "application/json" };

test("HTTP boundary enforces auth, exact paths and method before dispatch", async t => {
  let calls = 0;
  const gw = await startGateway({ config, env, port: 0, fetchImpl: async (target, options) => {
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

test("closing the gateway aborts active provider work without retrying", { timeout: 3000 }, async t => {
  const started = Promise.withResolvers(); const aborted = Promise.withResolvers();
  let attempts = 0;
  const gw = await startGateway({ config, env, port: 0, fetchImpl: async (_target, { signal }) => {
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
});
