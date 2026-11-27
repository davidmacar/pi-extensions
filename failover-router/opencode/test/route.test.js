import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { candidateOrder, routeGatewayRequest } from "../src/route.js";

const config = {
  apiKey: "local-secret",
  channels: {
    first: { baseURL: "https://first.invalid/v1", apiKey: "first-secret" },
    second: { baseURL: "https://second.invalid/v1", apiKey: "second-secret" },
  },
  profiles: { "chat-local": { order: "configured", chain: [{ channel: "first", model: "upstream-one" }, { channel: "second", model: "upstream-two" }] } },
};
function harness({ payload = { model: "chat-local", stream: true, messages: [] }, authorization = "Bearer local-secret", path = "/v1/chat/completions" } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]); req.url = path; req.headers = { authorization };
  const res = { headers: null, status: null, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = Buffer.from(body ?? ""); } };
  return { request: req, response: res };
}
function sse(text) { return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }); }

test("candidate order uses a stable channel/model cache reference", () => {
  const order = candidateOrder(config.profiles["chat-local"], config.channels);
  assert.deepEqual(order.map(step => [step.channel, step.model]), [["first", "first/upstream-one"], ["second", "second/upstream-two"]]);
});

test("auth rejection has exact status, message and does not call upstream", async () => {
  const h = harness({ authorization: "Bearer wrong" }); let calls = 0;
  await routeGatewayRequest({ ...h, config, fetchImpl: async () => { calls++; } });
  assert.equal(h.response.status, 401); assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(h.response.body).error, { message: "Invalid local gateway key", type: "authentication_error" });
});

test("rotates on provider errors, strips local credentials and forwards a complete stream unchanged", async () => {
  const h = harness(); const calls = [];
  await routeGatewayRequest({ ...h, config, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.authorization, model: JSON.parse(options.body).model });
    return calls.length === 1 ? new Response(JSON.stringify({ error: { message: "429 rate limit" } }), { status: 429, headers: { "content-type": "application/json" } }) : sse(['data: {"choices":[{"finish_reason":"stop"}]}', '', 'data: [DONE]', '', ''].join("\n"));
  }, sleep: async () => {} });
  assert.equal(calls.length, 2); assert.equal(calls[0].url, "https://first.invalid/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer first-secret"); assert.equal(calls[0].model, "upstream-one");
  assert.equal(calls[1].auth, "Bearer second-secret"); assert.equal(h.response.status, 200);
  assert.equal(h.response.body.toString(), ['data: {"choices":[{"finish_reason":"stop"}]}', '', 'data: [DONE]', '', ''].join("\n"));
  assert.equal(h.response.headers["x-failover-channel"], "second"); assert.equal(h.response.headers["content-length"], h.response.body.length);
});

test("incomplete stream retries, but malformed request stays on the first provider", async () => {
  const incomplete = harness(); let calls = 0; let clock = 1;
  await routeGatewayRequest({ ...incomplete, config, fetchImpl: async () => { calls++; return sse(['data: {"choices":[]}', ''].join("\n")); }, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(calls, 8); assert.equal(incomplete.response.headers["x-failover-exhausted"], "true");

  const invalid = harness(); calls = 0;
  await routeGatewayRequest({ ...invalid, config, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: "malformed json" } }), { status: 400, headers: { "content-type": "application/json" } }); } });
  assert.equal(calls, 1); assert.equal(invalid.response.status, 400); assert.equal(invalid.response.body.toString(), JSON.stringify({ error: { message: "malformed json", type: "server_error" } }));
});

test("rejects oversized JSON without dispatch and does not expose tokens in upstream body", async () => {
  const h = harness({ payload: { model: "chat-local", text: "x".repeat(8 * 1024 * 1024) } }); let calls = 0;
  await routeGatewayRequest({ ...h, config, fetchImpl: async () => { calls++; } });
  assert.equal(h.response.status, 413); assert.equal(calls, 0);
  assert.doesNotMatch(h.response.body.toString(), /local-secret|first-secret|second-secret/);
});


test("physical recovery dispatches exactly nine attempts in three groups", async () => {
  const h = harness();
  const physical = { ...config, profiles: { "chat-local": { recovery: "physical", chain: config.profiles["chat-local"].chain.slice(0, 1) } } };
  const waits = []; let attempts = 0;
  await routeGatewayRequest({ ...h, config: physical, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    ++attempts;
    return new Response('{"error":{"message":"provider unavailable"}}', { status: 503, headers: { "content-type": "application/json" } });
  } });
  assert.equal(attempts, 9);
  assert.deepEqual(waits, [300_000, 300_000]);
  assert.equal(h.response.status, 503);
  assert.equal(h.response.headers["x-failover-exhausted"], "true");
});

test("cancel during recovery wait does not dispatch again", async () => {
  const h = harness(); const controller = new AbortController(); let attempts = 0;
  await assert.rejects(routeGatewayRequest({ ...h, config, signal: controller.signal, sleep: async () => controller.abort(), fetchImpl: async () => {
    ++attempts;
    return new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { "content-type": "application/json" } });
  } }), { name: "AbortError" });
  assert.equal(attempts, 2);
  assert.equal(h.response.status, null);
});


test("Responses rejects explicit upstream storage without any provider request", async () => {
  const h = harness({ path: "/v1/responses", payload: { model: "chat-local", store: true } });
  let attempts = 0;
  await routeGatewayRequest({ ...h, config, fetchImpl: async () => { ++attempts; return Response.json({ id: "unexpected" }); } });
  assert.equal(h.response.status, 400);
  assert.match(JSON.parse(h.response.body).error.message, /stor/i);
  assert.equal(attempts, 0);
});
