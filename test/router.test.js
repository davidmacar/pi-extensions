import { test } from "node:test";
import assert from "node:assert/strict";

import { writeFileSync } from "node:fs";
import failoverRouter from "../index.js";

/** Minimal fake ExtensionAPI + model registry that records routing decisions. */
function harness({ config, catalog }) {
  const registered = [];
  const logs = [];
  const pi = {
    log: (m) => logs.push(m),
    registerVirtualModel: (def) => registered.push(def),
  };
  const ctx = {
    modelRegistry: {
      find: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id),
    },
  };
  return { pi, ctx, registered, logs };
}

const catalog = [
  { provider: "subrouter-best", id: "gpt-6.1-sol" },
  { provider: "subrouter-000", id: "gpt-6.1-sol" },
  { provider: "subrouter-fxpayback", id: "gpt-6.1-sol" },
];

const config = {
  virtuals: [
    {
      provider: "router",
      id: "sol",
      name: "Sol failover",
      thinkingLevels: ["high", "xhigh"],
      chain: [
        { model: "subrouter-best/gpt-6.1-sol", thinkingLevel: "xhigh" },
        { model: "subrouter-000/gpt-6.1-sol", thinkingLevel: "xhigh" },
        { model: "subrouter-fxpayback/gpt-6.1-sol", thinkingLevel: "xhigh" },
      ],
    },
  ],
};

function boot(cfg = config) {
  const h = harness({ config: cfg, catalog });
  const path = "/tmp/pi-failover-router-test.json";
  writeFileSync(path, JSON.stringify(cfg));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  return h;
}

test("registers one virtual model per configured entry", () => {
  const { registered } = boot();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].provider, "router");
  assert.equal(registered[0].id, "sol");
  assert.deepEqual(registered[0].thinkingLevels, ["high", "xhigh"]);
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
        model: { provider: "subrouter-best", id: "gpt-6.1-sol" },
        thinkingLevel: "xhigh",
        message: {
          stopReason: "error",
          errorMessage:
            'status_code=400, bad response status code 400, body: {"error":{"message":"gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions","type":"invalid_request_error"}}',
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
        model: { provider: "subrouter-best", id: "gpt-6.1-sol" },
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
        model: { provider: "subrouter-best", id: "gpt-6.1-sol" },
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
        model: { provider: "subrouter-best", id: "gpt-6.1-sol" },
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
      previous: { model: { provider: "subrouter-000", id: "gpt-6.1-sol" }, thinkingLevel: "high" },
    },
    ctx,
  );
  assert.equal(out.model.provider, "subrouter-000");
  assert.equal(out.thinkingLevel, "high");
});

test("the failing model enters cooldown so the next rotation skips it", () => {
  const { registered, ctx } = boot();
  const failed = (provider) => ({
    reason: "retry",
    messages: [],
    failed: {
      model: { provider, id: "gpt-6.1-sol" },
      thinkingLevel: "xhigh",
      message: { stopReason: "error", errorMessage: "503 service unavailable" },
    },
  });
  const first = registered[0].route(failed("subrouter-best"), ctx);
  assert.equal(first.model.provider, "subrouter-000");
  const second = registered[0].route(failed("subrouter-000"), ctx);
  assert.equal(second.model.provider, "subrouter-fxpayback");
  const third = registered[0].route(failed("subrouter-fxpayback"), ctx);
  // nothing left: it stays on the model that just failed
  assert.equal(third.model.provider, "subrouter-fxpayback");
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
  const path = "/tmp/pi-failover-router-bad.json";
  writeFileSync(path, JSON.stringify({ virtuals: [{ provider: "r", id: "x", chain: [] }] }));
  process.env.PI_FAILOVER_ROUTER_CONFIG = path;
  failoverRouter(h.pi);
  delete process.env.PI_FAILOVER_ROUTER_CONFIG;
  assert.equal(h.registered.length, 0);
  assert.match(h.logs.join("\n"), /config not loaded/);
});
