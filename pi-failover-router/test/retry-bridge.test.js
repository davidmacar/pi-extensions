import { test } from "node:test";
import assert from "node:assert/strict";

import { retryableErrorText, RETRYABLE_MARKER } from "../lib/retry-bridge.js";

test("the provider text stays first and the marker is appended", () => {
  const original = "upstream stream read failed before completion: http2: response body closed";
  const text = retryableErrorText(original);
  assert.ok(text.startsWith(original), text);
  assert.ok(text.includes(RETRYABLE_MARKER), text);
});

test("an already annotated error is left alone", () => {
  const once = retryableErrorText("boom");
  assert.equal(retryableErrorText(once), undefined);
});

test("nothing to annotate yields nothing", () => {
  assert.equal(retryableErrorText(undefined), undefined);
  assert.equal(retryableErrorText(""), undefined);
  assert.equal(retryableErrorText("   "), undefined);
});
