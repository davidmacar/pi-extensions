import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installPiRouter, { PRICES_EVENT } from "../../pi/index.js";
import { startGateway } from "../src/server.js";

const first = "subrouter-a";
const second = "subrouter-b";
const channels = [first, second];
const model = "tariff-fixture-model";
const tariffKey = "sk-shared-tariff-fixture";

for (const writer of ["gateway", "Pi"]) {
  test(`${writer} publishes authenticated tariffs and both adapters choose the same channel`, { timeout: 5000 }, t => checkSharedPricing(t, writer));
}

async function checkSharedPricing(t, writer) {
  const dir = mkdtempSync(join(tmpdir(), "shared-adapters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const priceDir = join(dir, "shared");
  const piConfig = join(dir, "pi.json");
  writeFileSync(piConfig, JSON.stringify({ virtuals: [{ provider: "router", id: "cheap", chain: channels.map(channel => `${channel}/${model}`) }] }));
  for (const [name, value] of Object.entries({ SUBROUTER_API_KEY: writer === "Pi" ? tariffKey : undefined, SUBROUTER_PRICE_CACHE_DIR: priceDir,
    PI_FAILOVER_ROUTER_CONFIG: piConfig, PI_FAILOVER_ROUTER_PRICE_CACHE: join(dir, "legacy.json"),
    PI_FAILOVER_ROUTER_SPEED_CACHE: join(dir, "speed.json"), PI_FAILOVER_ROUTER_LOG: join(dir, "pi.log"), PI_FAILOVER_ROUTER_NO_PATCHER: "1" })) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const handlers = new Map();
  const changed = Promise.withResolvers();
  const virtuals = [];
  const calls = [];
  async function upstream(url, options) {
    const origin = new URL(url).hostname;
    calls.push([origin, new Headers(options.headers).get("authorization")]);
    if (origin === "subrouter.ai") return Response.json({ success: true, data: [
      { provider_slug: "a", model_name: model, input_price: 0.1, output_price: 1, price_currency: "USD" },
      { provider_slug: "b", model_name: model, input_price: 0.5, output_price: 2, price_currency: "CNY" },
    ] });
    return Response.json({ id: "chosen" });
  }
  installPiRouter({ registerVirtualModel: definition => virtuals.push(definition),
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    events: { emit(name, payload) { if (name === PRICES_EVENT && payload.some(row => row.input_price === 0.5)) changed.resolve(payload); } },
    subrouterFetch: upstream,
  });
  const ctx = { modelRegistry: { find: (provider, id) => ({ provider, id }) } };
  const fire = name => handlers.get(name)?.forEach(handler => handler({}, ctx));
  t.after(() => fire("session_shutdown"));
  if (writer === "gateway") fire("session_start");
  const gw = await startGateway({ port: 0, stateDir: join(dir, "gateway"),
    env: { SUBROUTER_API_KEY: writer === "gateway" ? tariffKey : undefined, SUBROUTER_PRICE_CACHE_DIR: priceDir, LOCAL: "private-local", REMOTE: "private-remote" },
    config: { apiKeyEnv: "LOCAL", channels: Object.fromEntries(channels.map(channel => [channel, { baseURL: `https://${channel}.invalid/v1`, apiKeyEnv: "REMOTE" }])),
      profiles: { cheap: { order: "cost", chain: channels.map(channel => ({ channel, model })) } } },
    fetchImpl: upstream,
  });
  t.after(() => gw.close());
  if (writer === "Pi") { fire("session_start"); await changed.promise; }
  const result = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", body: '{"model":"cheap"}',
    headers: { authorization: "Bearer private-local", "content-type": "application/json" } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-failover-channel"), second);
  assert.deepEqual(await result.json(), { id: "chosen" });
  const prices = await changed.promise;
  assert.deepEqual(prices.map(row => row.input_price), [0.68, 0.5]);
  const routed = await virtuals[0].route({ reason: "user", messages: [] }, ctx);
  assert.equal(routed.model.provider, second);
  assert.deepEqual(calls, [["subrouter.ai", `Bearer ${tariffKey}`], [`${second}.invalid`, "Bearer private-remote"]]);
}
