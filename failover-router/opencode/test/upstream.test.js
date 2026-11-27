import test from "node:test";
import assert from "node:assert/strict";
import { dispatchUpstream } from "../src/upstream.js";

const channel = { baseURL: "https://gateway.invalid/v1", apiKey: "must-not-leak" };
const respond = (body, { status = 200, contentType = "application/json" } = {}) => new Response(body, { status, headers: { "content-type": contentType } });

test("dispatches only the server-owned model request and strips redirects", async () => {
  let seen;
  const result = await dispatchUpstream({ channel, path: "/chat/completions", payload: { model: "model-a", messages: [] }, timeoutMs: 1000,
    fetchImpl: async (url, options) => { seen = { url, options }; return respond('{"id":"ok"}'); } });
  assert.equal(result.ok, true); assert.equal(seen.url, "https://gateway.invalid/v1/chat/completions");
  assert.equal(seen.options.headers.authorization, "Bearer must-not-leak");
  assert.equal(JSON.parse(seen.options.body).model, "model-a");
  assert.equal(seen.options.redirect, "manual");
});

test("requires Chat finish_reason before [DONE] and supports Responses completed events", async () => {
  const call = (path, body) => dispatchUpstream({ channel, path, payload: { model: "m", stream: true }, timeoutMs: 1000, fetchImpl: async () => respond(body, { contentType: "text/event-stream" }) });
  assert.equal((await call("/chat/completions", 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')).ok, true);
  assert.equal((await call("/chat/completions", 'data: {"choices":[{"finish_reason":null}]}\n\ndata: [DONE]\n\n')).detail, "incomplete_stream");
  assert.equal((await call("/responses", 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n')).ok, true);
});

test("does not publish an unterminated SSE frame or an upstream bearer echoed in an error", async () => {
  const call = (body, opts) => dispatchUpstream({ channel, path: "/chat/completions", payload: { stream: true }, timeoutMs: 1000, fetchImpl: async () => respond(body, opts) });
  const cut = await call('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]', { contentType: "text/event-stream" });
  assert.equal(cut.status, 502);
  assert.equal(cut.detail, "incomplete_stream");
  const echoed = await call(JSON.stringify({ error: { message: "401: invalid api key must-not-leak" } }), { status: 401 });
  assert.equal(echoed.status, 401);
  assert.doesNotMatch(echoed.body.toString(), /must-not-leak/);
  assert.match(JSON.parse(echoed.body).error.message, /invalid api key/);
});

test("preserves rotatable provider errors and bounds error body size", async () => {
  const result = await dispatchUpstream({ channel, path: "/chat/completions", payload: {}, timeoutMs: 1000,
    fetchImpl: async () => respond(JSON.stringify({ error: { message: "429 rate limit" } }), { status: 429 }) });
  assert.equal(result.status, 429); assert.equal(result.detail, '429: {"error":{"message":"429 rate limit"}}');
});


test("CR-only SSE framing preserves the complete response", async () => {
  const body = 'data: {"choices":[{"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r';
  const result = await dispatchUpstream({ channel, path: "/chat/completions", payload: { stream: true }, timeoutMs: 1000,
    fetchImpl: async () => respond(body, { contentType: "text/event-stream" }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), body);
});

test("oversized upstream errors retain their status for classification, not their raw fields", async () => {
  const result = await dispatchUpstream({ channel, path: "/chat/completions", payload: {}, timeoutMs: 1000,
    fetchImpl: async () => Response.json({ error: { message: "maintenance", headers: { authorization: channel.apiKey }, body: "x".repeat(70 * 1024) } }, { status: 503 }) });
  assert.equal(result.status, 503);
  assert.match(result.detail, /^503: .*maintenance/);
  assert.deepEqual(JSON.parse(result.body), { error: { message: "Upstream HTTP 503", type: "server_error" } });
});
