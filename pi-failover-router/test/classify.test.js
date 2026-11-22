import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, nextCandidate, cooldownMs } from "../lib/classify.js";

// --- The two real failures observed in the user's SubRouter account ---------

test("channel that rejects tool calls rotates", () => {
  const body =
    'status_code=400, bad response status code 400, body: {"error":{"message":' +
    '"gpt-6.2-sol requires Responses for tool calls; this account only supports Chat Completions",' +
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

test("the provider's unclassified-request envelope rotates without depending on request_id", () => {
  const body = "Error: 当前请求未成功。 原因：请求处理过程中出现未归类错误。 解决方案：请稍后重试；如果问题持续，请带 request_id 联系客服排查。 request_id: 202611211239031829861288268d9d6npAmIEqM";
  const r = classifyFailure(body);
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "upstream_unclassified");
  assert.equal(r.annotate, true);
  assert.equal(cooldownMs(r.kind), 2 * 60_000);
});

test("unclassified envelope does not override a request-shaped error", () => {
  const r = classifyFailure("当前请求未成功。 原因：请求处理过程中出现未归类错误；context_length_exceeded");
  assert.equal(r.rotate, false);
  assert.equal(r.kind, "request_invalid");
});

test("generic Chinese retry wording without the unclassified envelope stays unknown", () => {
  for (const body of [
    "请稍后重试",
    "请求处理过程中出现错误",
    "当前请求未成功。解决方案：请稍后重试",
  ]) {
    const r = classifyFailure(body);
    assert.equal(r.rotate, false, body);
    assert.equal(r.kind, "unknown", body);
  }
});

test("incomplete_stream marker alone rotates", () => {
  const r = classifyFailure('{"error_code":"incomplete_stream","status_code":499}');
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "incomplete_stream");
});

test("the upstream do-request failure rotates without depending on request_id", () => {
  const body = "Error: upstream error: do request failed (request id: 20261121143209442001439RP9kQHsq)";
  const r = classifyFailure(body);
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "upstream_request_failed");
  assert.equal(r.annotate, true);
  assert.equal(cooldownMs(r.kind), 2 * 60_000);
  assert.equal(
    classifyFailure("upstream error: do request failed (request id: another-id)").kind,
    "upstream_request_failed",
  );
});

test("the upstream do-request rule stays narrow", () => {
  for (const body of [
    "do request failed",
    "upstream error: connection refused",
    "Error: upstream error: request failed",
  ]) {
    const r = classifyFailure(body);
    assert.equal(r.rotate, false, body);
    assert.equal(r.kind, "unknown", body);
  }
});

test("the upstream do-request envelope does not override a request-shaped error", () => {
  const r = classifyFailure("upstream error: do request failed; context_length_exceeded");
  assert.equal(r.rotate, false);
  assert.equal(r.kind, "request_invalid");
});

// --- Provider moderation is channel-owned, but deterministic per channel ----

const MODERATION =
  "Error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. " +
  "Please try again with a different prompt: https://platform.openai.com/docs/guides/error-codes/api-errors";

test("a prompt flagged by provider moderation rotates to another channel", () => {
  const r = classifyFailure(MODERATION);
  assert.equal(r.rotate, true);
  assert.equal(r.kind, "content_policy");
});

test("moderation is not annotated for a same-channel retry", () => {
  // The identical prompt fails identically on the channel that just refused it,
  // so the annotation that buys Pi's native retry would only spend three
  // identical requests. The takeover path advances the chain instead.
  assert.equal(classifyFailure(MODERATION).annotate, false);
});

test("an invalid prompt without a policy signal is not moderated content", () => {
  assert.equal(classifyFailure("400 invalid_prompt: messages[0] must be a string").rotate, false);
});

test("moderation cools like a transient channel, never like exhausted credentials", () => {
  assert.equal(cooldownMs("content_policy"), 2 * 60_000);
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

test("a policy mention inside a malformed request still never rotates", () => {
  const r = classifyFailure("400 missing required field: messages [content policy]").rotate;
  assert.equal(r, false);
});

// --- A policy noun is not a content rejection -------------------------------
// These were all reported by independent verification as unintended rotations
// when the moderation rule matched bare policy nouns.

for (const text of [
  "400 invalid_request_error: Unknown parameter: 'content_policy'",
  "400 Bad Request: Invalid safety_filter value 'disabled'; expected 'standard' or 'strict'.",
  "400 invalid_prompt: messages[0].content must be a string. See content policy documentation.",
  "400 invalid_request_error: Unsupported input type: content policy evaluation accepts text only.",
  "400 safety filter configuration must be an object, not a string.",
  "Error: moderation failed to initialize: configuration missing.",
  "Error: content policy service health check failed",
]) {
  test(`a policy noun is not a rejection: ${text.slice(0, 46)}`, () => {
    assert.equal(classifyFailure(text).rotate, false);
  });
}

// --- A broken moderation service is that failure, not a rejection -----------
// Each of these rotated before the moderation rule existed and must keep its
// own kind and its own cooldown; only the kind controls how long a channel cools.

for (const [text, kind] of [
  ["500 moderation_failed: moderation service encountered an internal error", "provider_unavailable"],
  ["503 Service Unavailable: content policy service unavailable", "provider_unavailable"],
  ["504 Gateway Timeout: safety filter service timed out", "timeout"],
  ["429 rate limit exceeded for content policy checks", "rate_limit"],
  ["401 Unauthorized: invalid API key for safety filter service", "auth"],
  ["403 Account suspended for violation of our usage policy", "auth"],
  ["403 Forbidden by organizational content policy: model access disabled", "auth"],
  ["402 insufficient quota for safety filter requests", "quota"],
  ["ECONNRESET connecting to safety filter service", "network"],
  ["499 upstream stream read failed before completion in safety filter proxy", "incomplete_stream"],
]) {
  test(`a failing moderation service keeps kind ${kind}: ${text.slice(0, 42)}`, () => {
    const r = classifyFailure(text);
    assert.equal(r.kind, kind);
    assert.equal(r.annotate, true, "these kinds still buy Pi's native retry");
  });
}

// --- Real rejection wording still rotates as moderation ---------------------

for (const text of [
  "400 invalid_request_error: Your request was rejected due to a violation of our content policy.",
  "400 ResponsibleAIPolicyViolation: The response was filtered because the prompt triggered the content policy.",
  "400 moderation_blocked: Prompt rejected for unsafe content.",
  "400 safety_filter: Input content blocked by the safety filter.",
  "400 Your prompt was rejected for violating the usage policies.",
  "400 Request rejected: usage_policy_violation",
]) {
  test(`real rejection wording rotates: ${text.slice(0, 46)}`, () => {
    const r = classifyFailure(text);
    assert.equal(r.rotate, true);
    assert.equal(r.kind, "content_policy");
    assert.equal(r.annotate, false);
  });
}

// --- Candidate selection ---------------------------------------------------

const CHAIN = [
  { model: "best/gpt-6.2-sol", thinkingLevel: "xhigh" },
  { model: "000/gpt-6.2-sol", thinkingLevel: "xhigh" },
  { model: "fxpayback/gpt-6.2-sol" },
];

test("picks the first candidate that is not the failed model and not cooling", () => {
  const next = nextCandidate({
    chain: CHAIN,
    failedModel: "best/gpt-6.2-sol",
    cooldowns: new Map(),
    now: 1000,
  });
  assert.equal(next.model, "000/gpt-6.2-sol");
  assert.equal(next.thinkingLevel, "xhigh");
});

test("skips models inside their cooldown", () => {
  const next = nextCandidate({
    chain: CHAIN,
    failedModel: "best/gpt-6.2-sol",
    cooldowns: new Map([["000/gpt-6.2-sol", 5000]]),
    now: 1000,
  });
  assert.equal(next.model, "fxpayback/gpt-6.2-sol");
});

test("returns undefined when every candidate is exhausted or failed", () => {
  const next = nextCandidate({
    chain: [{ model: "best/gpt-6.2-sol" }],
    failedModel: "best/gpt-6.2-sol",
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

