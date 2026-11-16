import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, nextCandidate, cooldownMs } from "../lib/classify.js";

// --- The two real failures observed in the user's SubRouter account ---------

test("channel that rejects tool calls rotates", () => {
  const body =
    'status_code=400, bad response status code 400, body: {"error":{"message":' +
    '"gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions",' +
    '"type":"invalid_request_error"}}';
  const r = classifyFailure(body);
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "channel_capability");
});

test("mid-stream 499 with a closed http2 body rotates", () => {
  const body = "status_code=499, upstream stream read failed before completion: http2: response body closed";
  const r = classifyFailure(body);
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "incomplete_stream");
});

test("incomplete_stream marker alone rotates", () => {
  const r = classifyFailure('{"error_code":"incomplete_stream","status_code":499}');
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "incomplete_stream");
});

// --- Transient transport / provider trouble still rotates -------------------

test("provider outage rotates", () => {
  assert.equal(classifyFailure("503 service unavailable: server busy").rotate, true);
  assert.equal(classifyFailure("overloaded_error").rotate, true);
});

test("rate limit and quota rotate", () => {
  assert.equal(classifyFailure("429 Too Many Requests").kind, "rate_limit");
  assert.equal(classifyFailure("insufficient quota for this billing period").kind, "quota");
});

test("auth failure rotates", () => {
  assert.equal(classifyFailure("401 unauthorized: invalid api key").kind, "auth");
});

test("timeout rotates", () => {
  assert.equal(classifyFailure("504 gateway timeout").kind, "timeout");
});

// --- The cases that must NEVER rotate --------------------------------------

test("context length never rotates", () => {
  const r = classifyFailure("400 context_length_exceeded: maximum context length is 1050000 tokens");
  assert.equal(r.rotate, false);
  assert.equal(r.kind, "request_invalid");
});

test("genuinely malformed request never rotates", () => {
  const r = classifyFailure('400 {"error":{"message":"Invalid JSON in request body"}}');
  assert.equal(r.rotate, false);
});

test("missing required parameter never rotates", () => {
  const r = classifyFailure("400 missing required field: messages");
  assert.equal(r.rotate, false);
});

test("unknown failure never rotates", () => {
  const r = classifyFailure("something unexpected happened in the sandbox");
  assert.equal(r.rotate, false);
  assert.equal(r.kind, "unknown");
});

test("empty error never rotates", () => {
  assert.equal(classifyFailure(undefined).rotate, false);
  assert.equal(classifyFailure("").rotate, false);
});

test("non-string error never rotates", () => {
  assert.equal(classifyFailure({ message: "boom" }).rotate, false);
});

// --- Candidate selection ---------------------------------------------------

const CHAIN = [
  { model: "best/gpt-6.1-sol", thinkingLevel: "xhigh" },
  { model: "000/gpt-6.1-sol", thinkingLevel: "xhigh" },
  { model: "fxpayback/gpt-6.1-sol" },
];

test("picks the first candidate that is not the failed model and not cooling", () => {
  const next = nextCandidate({
    chain: CHAIN,
    failedModel: "best/gpt-6.1-sol",
    cooldowns: new Map(),
    now: 1000,
  });
  assert.equal(next.model, "000/gpt-6.1-sol");
  assert.equal(next.thinkingLevel, "xhigh");
});

test("skips models inside their cooldown", () => {
  const next = nextCandidate({
    chain: CHAIN,
    failedModel: "best/gpt-6.1-sol",
    cooldowns: new Map([["000/gpt-6.1-sol", 5000]]),
    now: 1000,
  });
  assert.equal(next.model, "fxpayback/gpt-6.1-sol");
});

test("returns undefined when every candidate is exhausted or failed", () => {
  const next = nextCandidate({
    chain: [{ model: "best/gpt-6.1-sol" }],
    failedModel: "best/gpt-6.1-sol",
    cooldowns: new Map(),
    now: 1000,
  });
  assert.equal(next, undefined);
});

test("a step without thinkingLevel returns only a model", () => {
  const next = nextCandidate({
    chain: [{ model: "a/x" }, { model: "b/y" }],
    failedModel: "a/x",
    cooldowns: new Map(),
    now: 0,
  });
  assert.deepEqual(next, { model: "b/y" });
});

test("quota and auth cool down far longer than transient kinds", () => {
  assert.ok(cooldownMs("quota") > cooldownMs("network"));
  assert.equal(cooldownMs("auth"), cooldownMs("quota"));
  assert.equal(cooldownMs("provider_unavailable"), 2 * 60_000);
});

test("backoff doubles the cooldown and stops at the ceiling", () => {
  assert.equal(cooldownMs("incomplete_stream", 0), 2 * 60_000);
  assert.equal(cooldownMs("incomplete_stream", 1), 4 * 60_000);
  assert.equal(cooldownMs("incomplete_stream", 2), 8 * 60_000);
  assert.equal(cooldownMs("incomplete_stream", 3), 16 * 60_000);
  assert.equal(cooldownMs("incomplete_stream", 4), 30 * 60_000, "capped");
  assert.equal(cooldownMs("incomplete_stream", 99), 30 * 60_000, "never above the ceiling");
});

test("backoff applies to quota and auth from their own base", () => {
  assert.equal(cooldownMs("quota", 0), 30 * 60_000);
  assert.equal(cooldownMs("quota", 1), 60 * 60_000);
  assert.equal(cooldownMs("quota", 5), 2 * 60 * 60_000);
});

test("nextCandidate skips channels that are cooling down", () => {
  const chain = [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }];
  const cooling = new Map([
    ["a/one", 100],
    ["b/two", 100],
  ]);
  assert.deepEqual(nextCandidate({ chain, failedModel: "a/one", cooldowns: cooling, now: 50 }), { model: "c/three" });
  // Once the cooldowns expire, a previously used channel is a candidate again:
  // nothing is remembered for longer than its cooldown.
  assert.deepEqual(nextCandidate({ chain, failedModel: "a/one", cooldowns: cooling, now: 200 }), { model: "b/two" });
});

