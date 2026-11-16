import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVirtual, parseConfig, loadRouterConfig, ConfigError } from "../lib/config.js";

const PLAUSIBLE = {
  provider: "router",
  id: "sol",
  name: "Sol (failover)",
  thinkingLevels: ["high", "xhigh"],
  chain: [
    { model: "subrouter-best/gpt-6.1-sol", thinkingLevel: "xhigh" },
    { model: "subrouter-000/gpt-6.1-sol", thinkingLevel: "xhigh" },
    "subrouter-fxpayback/gpt-6.1-sol",
  ],
};

test("normalizes a valid virtual model", () => {
  const v = normalizeVirtual(PLAUSIBLE);
  assert.equal(v.provider, "router");
  assert.equal(v.id, "sol");
  assert.deepEqual(v.chain, [
    { model: "subrouter-best/gpt-6.1-sol", thinkingLevel: "xhigh" },
    { model: "subrouter-000/gpt-6.1-sol", thinkingLevel: "xhigh" },
    { model: "subrouter-fxpayback/gpt-6.1-sol" },
  ]);
});

test("name defaults to the id", () => {
  const v = normalizeVirtual({ ...PLAUSIBLE, name: undefined });
  assert.equal(v.name, "sol");
});

test("rejects an empty chain", () => {
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, chain: [] }), ConfigError);
});

test("rejects a model without provider prefix", () => {
  assert.throws(
    () => normalizeVirtual({ ...PLAUSIBLE, chain: ["gpt-6.1-sol"] }),
    /provider\/id/,
  );
});

test("rejects duplicate models in one chain", () => {
  assert.throws(
    () => normalizeVirtual({ ...PLAUSIBLE, chain: ["a/x", "a/x"] }),
    /duplicate model/,
  );
});

test("rejects an unknown thinking level", () => {
  assert.throws(
    () => normalizeVirtual({ ...PLAUSIBLE, chain: [{ model: "a/x", thinkingLevel: "ultra" }] }),
    /unknown thinking level/,
  );
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, thinkingLevels: ["ultra"] }), /unknown thinking level/);
});

test("rejects missing provider or id", () => {
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, provider: "" }), ConfigError);
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, id: undefined }), ConfigError);
});

test("parseConfig accepts an object document and a bare array", () => {
  const fromObject = parseConfig({ virtuals: [PLAUSIBLE] });
  const fromArray = parseConfig([PLAUSIBLE]);
  assert.equal(fromObject.length, 1);
  assert.equal(fromArray.length, 1);
});

test("parseConfig rejects duplicate provider/id pairs", () => {
  assert.throws(() => parseConfig({ virtuals: [PLAUSIBLE, PLAUSIBLE] }), /duplicate virtual model/);
});

test("carries the physical limits and input types through", () => {
  const v = normalizeVirtual({
    ...PLAUSIBLE,
    contextWindow: 1050000,
    maxTokens: 128000,
    input: ["text", "image"],
  });
  assert.equal(v.contextWindow, 1050000);
  assert.equal(v.maxTokens, 128000);
  assert.deepEqual(v.input, ["text", "image"]);
});

test("rejects limits that are not positive integers", () => {
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, contextWindow: 0 }), /contextWindow/);
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, maxTokens: -1 }), /maxTokens/);
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, contextWindow: 1.5 }), /contextWindow/);
});

test("rejects unknown or empty input types", () => {
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, input: ["audio"] }), /input/);
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, input: [] }), /input/);
});

test("order accepts cost and speed and defaults to the configured chain order", () => {
  assert.equal(normalizeVirtual({ ...PLAUSIBLE, order: "speed" }).order, "speed");
  assert.equal(normalizeVirtual({ ...PLAUSIBLE, order: "cost" }).order, "cost");
  assert.equal(normalizeVirtual(PLAUSIBLE).order, undefined);
});

test("order rejects anything else", () => {
  assert.throws(() => normalizeVirtual({ ...PLAUSIBLE, order: "fastest" }), /order must be/);
});

test("parseConfig rejects a document without virtuals", () => {
  assert.throws(() => parseConfig({}), ConfigError);
  assert.throws(() => parseConfig({ virtuals: [] }), /must not be empty/);
});

test("loadRouterConfig returns no virtuals when the file is missing", () => {
  const readFile = () => {
    const error = new Error("nope");
    error.code = "ENOENT";
    throw error;
  };
  assert.deepEqual(loadRouterConfig("/nope.json", { readFile }), []);
});

test("loadRouterConfig surfaces invalid JSON as ConfigError", () => {
  assert.throws(
    () => loadRouterConfig("/x.json", { readFile: () => "{not json" }),
    /invalid JSON/,
  );
});
