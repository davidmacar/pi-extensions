import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRouterConfig } from "../lib/config.js";

const channels = ["fxpayback", "xcgx", "fate86api", "a6aa", "openai-pro", "lingai"];
const configPath = new URL("../failover-router.example.json", import.meta.url);
const expectedChain = channels.map((channel) => ({ model: `subrouter-${channel}/gpt-6.2-sol` }));

test("Sol examples retain the cost and speed routes with all six replacement channels", () => {
  const virtuals = loadRouterConfig(configPath);
  for (const [id, order, label] of [
    ["sol-barato", "cost", "barato"],
    ["sol-rapido", "speed", "rápido"],
  ]) {
    const route = virtuals.find((v) => v.id === id);
    assert.equal(route.provider, "router");
    assert.equal(route.name, `GPT 6.2 Sol — ${label}`);
    assert.equal(route.order, order);
    assert.deepEqual(route.chain, expectedChain);
    assert.deepEqual(route.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(route.contextWindow, 1050000);
    assert.equal(route.maxTokens, 128000);
    assert.deepEqual(route.input, ["text", "image"]);
  }
});

test("DeepSeek examples keep their previous routes and channel order", () => {
  const virtuals = loadRouterConfig(configPath);
  const chain = ["znu", "stableai", "relai", "lingai"].map((channel) => ({
    model: `subrouter-${channel}/deepseek-v4.1-flash-1017`,
  }));
  for (const [id, order] of [["deepseek-barato", "cost"], ["deepseek-rapido", "speed"]]) {
    const route = virtuals.find((v) => v.id === id);
    assert.equal(route.order, order);
    assert.deepEqual(route.chain, chain);
    assert.deepEqual(route.thinkingLevels, ["high", "max"]);
    assert.equal(route.contextWindow, 1000000);
    assert.equal(route.maxTokens, 384000);
  }
});

// Read only the repository's credential-free template, never the user's models.json.
test("each replacement channel has its own placeholder and physical model", () => {
  const { providers } = JSON.parse(readFileSync(new URL("../models-sol.example.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(providers), channels.map((channel) => `subrouter-${channel}`));
  for (const channel of channels) {
    const provider = providers[`subrouter-${channel}`];
    assert.equal(provider.apiKey, `REPLACE_WITH_SUBROUTER_${channel.replaceAll("-", "_").toUpperCase()}_KEY`);
    assert.equal(provider.baseUrl, "https://subrouter.ai/v1");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.models.length, 1);
    assert.equal(provider.models[0].id, "gpt-6.2-sol");
    assert.equal(provider.models[0].name, "GPT 6.2 Sol");
  }
});
