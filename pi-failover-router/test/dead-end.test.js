import { test } from "node:test";
import assert from "node:assert/strict";

import { lastAssistantMessage, resolveDeadEnd } from "../lib/dead-end.js";

const STREAM_FAILURE = {
  role: "assistant",
  provider: "subrouter-fxpayback",
  model: "gpt-6.1-sol",
  stopReason: "error",
  errorMessage: "upstream stream read failed before completion: http2: response body closed",
};

test("the real stream failure is a rotation the router should take over", () => {
  const verdict = resolveDeadEnd(STREAM_FAILURE);
  assert.equal(verdict.rotate, true);
  assert.equal(verdict.kind, "incomplete_stream");
  assert.equal(verdict.provider, "subrouter-fxpayback");
  assert.equal(verdict.id, "gpt-6.1-sol");
});

test("a request-shaped failure at the dead end is not rotated", () => {
  const verdict = resolveDeadEnd({
    ...STREAM_FAILURE,
    errorMessage: "400 context_length_exceeded: maximum context length is 1050000",
  });
  assert.equal(verdict.rotate, false);
  assert.equal(verdict.kind, "request_invalid");
});

test("an unknown failure at the dead end is not rotated", () => {
  const verdict = resolveDeadEnd({ ...STREAM_FAILURE, errorMessage: "weird sandbox thing" });
  assert.equal(verdict.rotate, false);
  assert.equal(verdict.kind, "unknown");
});

test("a completed or aborted response is not a dead end", () => {
  assert.equal(resolveDeadEnd({ ...STREAM_FAILURE, stopReason: "stop" }), undefined);
  assert.equal(resolveDeadEnd({ ...STREAM_FAILURE, stopReason: "aborted" }), undefined);
  assert.equal(resolveDeadEnd({ ...STREAM_FAILURE, role: "user" }), undefined);
});

test("a failure without a physical model identity is ignored", () => {
  assert.equal(resolveDeadEnd({ ...STREAM_FAILURE, model: undefined }), undefined);
  assert.equal(resolveDeadEnd({ ...STREAM_FAILURE, provider: "" }), undefined);
  assert.equal(resolveDeadEnd(null), undefined);
  assert.equal(resolveDeadEnd(undefined), undefined);
});

test("the last assistant message is the one that ended the run", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", stopReason: "toolUse" },
    { role: "toolResult" },
    STREAM_FAILURE,
  ];
  assert.equal(lastAssistantMessage(messages), STREAM_FAILURE);
  assert.equal(lastAssistantMessage([{ role: "user" }]), undefined);
  assert.equal(lastAssistantMessage(undefined), undefined);
});
