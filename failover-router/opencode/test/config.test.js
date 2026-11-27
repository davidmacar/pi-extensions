import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGatewayConfig } from "../src/config.js";

const input = {
  listen: { host: "127.0.0.1", port: 43128 },
  apiKeyEnv: "ROUTER_KEY",
  channels: { alpha: { baseURL: "https://gateway.invalid/v1", apiKeyEnv: "ALPHA_KEY" } },
  profiles: { cheap: { order: "cost", chain: [{ channel: "alpha", model: "model-a" }] } },
};

test("normalizes a loopback gateway and channels without reading secret values", () => {
  const config = normalizeGatewayConfig(input, { env: { ROUTER_KEY: "local", ALPHA_KEY: "upstream" } });
  assert.equal(config.listen.host, "127.0.0.1");
  assert.equal(config.channels.alpha.baseURL, "https://gateway.invalid/v1");
  assert.deepEqual(config.profiles.cheap.chain[0], { channel: "alpha", model: "model-a" });
});

test("rejects non-loopback listeners, missing key env, duplicate candidates and unknown channels", () => {
  for (const changed of [
    { ...input, listen: { host: "0.0.0.0", port: 43128 } },
    { ...input, apiKeyEnv: "MISSING" },
    { ...input, profiles: { cheap: { chain: [{ channel: "alpha", model: "a" }, { channel: "alpha", model: "a" }] } } },
    { ...input, profiles: { cheap: { chain: [{ channel: "missing", model: "a" }] } } },
  ]) assert.throws(() => normalizeGatewayConfig(changed, { env: { ROUTER_KEY: "local", ALPHA_KEY: "upstream" } }));
});

test("permits plain HTTP upstream only for loopback test services", () => {
  assert.doesNotThrow(() => normalizeGatewayConfig({ ...input, channels: { alpha: { ...input.channels.alpha, baseURL: "http://127.0.0.1:9999/v1" } } }, { env: { ROUTER_KEY: "local", ALPHA_KEY: "upstream" } }));
  assert.throws(() => normalizeGatewayConfig({ ...input, channels: { alpha: { ...input.channels.alpha, baseURL: "http://provider.invalid/v1" } } }, { env: { ROUTER_KEY: "local", ALPHA_KEY: "upstream" } }));
});
