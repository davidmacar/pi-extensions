import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { routeGatewayRequest } from "../src/route.js";

const baseConfig = {
  apiKey: "local-fixture",
  channels: {
    first: { baseURL: "https://first.invalid/v1", apiKey: "first-fixture" },
    second: { baseURL: "https://second.invalid/v1", apiKey: "second-fixture" },
  },
  profiles: { cheap: { order: "configured", chain: [{ channel: "first", model: "m1" }, { channel: "second", model: "m2" }] } },
};

function harness(payload = { model: "cheap", stream: true }, protocol = "chat/completions") {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
  request.url = `/v1/${protocol}`;
  request.headers = { authorization: "Bearer local-fixture" };
  const response = { status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = Buffer.from(body ?? ""); } };
  return { request, response };
}

// Sanitized examples from Pi's classify/recovery suites and documented incidents.
// Send actual protocol envelopes through dispatchUpstream, not pre-classified results.
const ROTATING = [
  [400, "requires Responses for tool calls; this account only supports Chat Completions", "channel_capability"],
  [499, "upstream stream read failed before completion: http2: response body closed", "incomplete_stream"],
  [499, "incomplete_stream", "incomplete_stream"],
  [524, "responses stream ended before ***.completed", "incomplete_stream"],
  [400, "OpenAI Responses stream ended before a terminal response event", "incomplete_stream"],
  [524, "", "timeout"],
  [524, "context_length_exceeded", "request_invalid", false],
  [400, "当前请求未成功。 原因：请求处理过程中出现未归类错误。 request_id: fixture", "upstream_unclassified"],
  [400, "Error: upstream error: do request failed (request id: fixture)", "upstream_request_failed"],
  [400, "Invalid prompt: your prompt was flagged as potentially violating our usage policy", "content_policy"],
  [400, "Your request was rejected due to a violation of our content policy", "content_policy"],
  [400, "ResponsibleAIPolicyViolation: The response was filtered because the prompt triggered the content policy", "content_policy"],
  [400, "moderation_blocked: Prompt rejected for unsafe content", "content_policy"],
  [400, "safety_filter: Input content blocked by the safety filter", "content_policy"],
  [400, "Your prompt was rejected for violating the usage policies", "content_policy"],
  [400, "Request rejected: usage_policy_violation", "content_policy"],
  [500, "moderation_failed: moderation service encountered an internal error", "provider_unavailable"],
  [502, "Bad Gateway", "provider_unavailable"],
  [503, "Service Unavailable: content policy service unavailable", "provider_unavailable"],
  [504, "safety filter service timed out", "timeout"],
  [429, "rate limit exceeded for content policy checks", "rate_limit"],
  [401, "invalid API key for safety filter service", "auth"],
  [403, "Account suspended for violation of our usage policy", "auth"],
  [403, "Forbidden by organizational content policy: model access disabled", "auth"],
  [402, "insufficient quota for safety filter requests", "quota"],
  [499, "upstream stream read failed before completion in safety filter proxy", "incomplete_stream"],
  [400, "ECONNRESET connecting to safety filter service", "network"],
  [400, "overloaded_error", "provider_unavailable"],
];
const NON_ROTATING = [
  ["context_length_exceeded: maximum context length", "request_invalid"],
  ["Invalid JSON in request body", "request_invalid"],
  ["missing required field: messages", "request_invalid"],
  ["missing required field: messages [content policy]", "request_invalid"],
  ["当前请求未成功。 原因：请求处理过程中出现未归类错误；context_length_exceeded", "request_invalid"],
  ["upstream error: do request failed; context_length_exceeded", "request_invalid"],
  ["something unexpected happened in the sandbox", "unknown"],
  ["", "unknown"],
  ["请稍后重试", "unknown"],
  ["请求处理过程中出现错误", "unknown"],
  ["当前请求未成功。解决方案：请稍后重试", "unknown"],
  ["do request failed", "unknown"],
  ["upstream error: connection refused", "unknown"],
  ["Error: upstream error: request failed", "unknown"],
  ["invalid_prompt: messages[0] must be a string", "unknown"],
  ["invalid_request_error: Unknown parameter: 'content_policy'", "unknown"],
  ["Invalid safety_filter value 'disabled'; expected 'standard' or 'strict'", "unknown"],
  ["invalid_prompt: messages[0].content must be a string. See content policy documentation", "unknown"],
  ["invalid_request_error: Unsupported input type: content policy evaluation accepts text only", "unknown"],
  ["safety filter configuration must be an object, not a string", "unknown"],
  ["moderation failed to initialize: configuration missing", "unknown"],
  ["content policy service health check failed", "unknown"],
];
const fixtures = [...ROTATING.map(([status, message, kind, rotate = true]) => [status, message, kind, rotate]), ...NON_ROTATING.map(row => [400, ...row, false])];
fixtures.push([400, "context_length_exceeded with reported usage", "request_invalid", false]);
for (const protocol of ["chat/completions", "responses"]) for (const [status, message, kind, rotate] of fixtures) {
  test(`Pi fixture via OpenCode ${protocol}: ${status} ${message || "(empty message)"}`, async () => {
    const h = harness({ model: "cheap" }, protocol);
    const calls = [], records = [];
    const channelsState = new Map();
    await routeGatewayRequest({ ...h, config: baseConfig, now: () => 1_000_000, channelsState,
      sleep: async () => assert.fail("no cooldown wait before an available fallback"),
      ledger: { record: row => records.push(row) }, requestId: "matrix",
      fetchImpl: async (url, { body }) => {
        calls.push([new URL(url).hostname, JSON.parse(body).model]);
        assert.equal(new URL(url).pathname, `/v1/${protocol}`);
        const usage = message.includes("reported usage") || kind === "unknown" ? { input_tokens: 429, output_tokens: 500 } : undefined;
        return calls.length === 1 ? Response.json({ error: { message }, usage }, { status }) : Response.json({ id: "fallback" });
      } });
    assert.deepEqual(calls, rotate ? [["first.invalid", "m1"], ["second.invalid", "m2"]] : [["first.invalid", "m1"]]);
    assert.equal(h.response.status, rotate ? 200 : status);
    assert.equal(h.response.headers["x-failover-channel"], rotate ? "second" : undefined);
    assert.deepEqual(records.map(row => [row.attempt, row.failureKind]), rotate ? [[1, kind], [2, undefined]] : [[1, kind]]);
    assert.equal(channelsState.get("first/m1")?.until, !rotate ? undefined : ["quota", "auth"].includes(kind) ? 2_800_000 : 1_120_000);
  });
}

test("OpenCode chain uses four passes, then stops without a fifth pass", async () => {
  const h = harness(); const calls = []; let clock = 1_000_000; const ledger = { rows: [], record(row) { this.rows.push(row); } };
  await routeGatewayRequest({ ...h, config: baseConfig, ledger, requestId: "matrix", now: () => clock, sleep: async ms => { clock += ms; },
    dispatch: async ({ channel }) => {
      calls.push(channel.baseURL);
      return { ok: false, status: 503, contentType: "application/json", body: Buffer.from("{}"), detail: "503 provider unavailable" };
    } });
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ["https://first.invalid/v1", "https://second.invalid/v1"]).flat());
  assert.equal(h.response.headers["x-failover-exhausted"], "true");
  assert.equal(ledger.rows.length, 8);
  assert.deepEqual(ledger.rows.map(row => row.attempt), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("OpenCode physical recovery uses nine attempts and two bounded group waits", async () => {
  const h = harness({ model: "physical", stream: true });
  const waits = []; let calls = 0;
  await routeGatewayRequest({ ...h, config: { ...baseConfig, profiles: { physical: { recovery: "physical", chain: [{ channel: "first", model: "m1" }] } } }, now: () => 1_000_000, sleep: async ms => waits.push(ms),
    dispatch: async () => { calls++; return { ok: false, status: 503, contentType: "application/json", body: Buffer.from("{}"), detail: "upstream stream read failed before completion" }; } });
  assert.equal(calls, 9);
  assert.deepEqual(waits, [300_000, 300_000]);
  assert.equal(h.response.headers["x-failover-exhausted"], "true");
});

test("cancellation during a historical failure cooldown aborts without another dispatch", async () => {
  const h = harness(); const controller = new AbortController(); let calls = 0;
  await assert.rejects(routeGatewayRequest({ ...h, config: baseConfig, signal: controller.signal,
    sleep: async () => controller.abort(), dispatch: async () => {
      calls++;
      return { ok: false, status: 429, contentType: "application/json", body: Buffer.from("{}"), detail: "429 rate limit" };
    } }), { name: "AbortError" });
  assert.equal(calls, 2);
  assert.equal(h.response.status, null);
});


test("new requests skip cooling channels, reuse expired channels, and success resets backoff", async () => {
  const channelsState = new Map();
  let clock = 1_000_000;
  async function run(failFirst = false) {
    const h = harness({ model: "cheap" });
    const calls = [];
    await routeGatewayRequest({ ...h, config: baseConfig, channelsState, now: () => clock,
      sleep: async () => assert.fail("unexpected wait on a new request"),
      fetchImpl: async url => {
        const host = new URL(url).hostname;
        calls.push(host);
        return failFirst && host === "first.invalid" ? Response.json({ error: { message: "limit" } }, { status: 429 }) : Response.json({ id: "ok" });
      } });
    assert.equal(h.response.status, 200);
    return calls;
  }
  assert.deepEqual(await run(true), ["first.invalid", "second.invalid"]);
  assert.deepEqual(await run(), ["second.invalid"]);
  clock += 120_000;
  assert.deepEqual(await run(true), ["first.invalid", "second.invalid"]);
  assert.equal(channelsState.get("first/m1").until, clock + 240_000);
  clock += 240_000;
  assert.deepEqual(await run(), ["first.invalid"]);
  assert.equal(channelsState.has("first/m1"), false);
  assert.deepEqual(await run(true), ["first.invalid", "second.invalid"]);
  assert.equal(channelsState.get("first/m1").until, clock + 120_000);
});

test("rechecks a cooldown extended during sleep without dispatching early", async () => {
  const h = harness({ model: "cheap" });
  const config = { ...baseConfig, profiles: { cheap: { chain: baseConfig.profiles.cheap.chain.slice(0, 1) } } };
  const channelsState = new Map();
  let clock = 1_000_000, calls = 0;
  const waits = [];
  await routeGatewayRequest({ ...h, config, channelsState, now: () => clock,
    sleep: async ms => {
      waits.push(ms);
      clock += ms;
      if (waits.length === 1) channelsState.set("first/m1", { streak: 2, until: clock + 60000 });
    },
    fetchImpl: async () => ++calls === 1 ? Response.json({}, { status: 429 }) : Response.json({ id: "ok" }),
  });
  assert.deepEqual(waits, [120_000, 60_000]);
  assert.equal(calls, 2);
  assert.equal(h.response.status, 200);
});
