/**
 * Last-resort rotation for failures Pi refuses to retry.
 *
 * Pi decides whether a failed response is retryable with an allow-list
 * (`isRetryableAssistantError` in `@earendil-works/pi-ai`). A message outside
 * that list — for example `upstream stream read failed before completion:
 * http2: response body closed`, which matches neither `upstream_stream_read_error`
 * nor `http/?2 stream failed` — ends the run immediately: no `_prepareRetry`, no
 * `failedResponse`, and therefore no `route()` call with `reason: "retry"`. The
 * router's classifier never gets a chance to act, even though it recognises the
 * text.
 *
 * This module decides what the router should do at that dead end, from the
 * assistant message alone.
 */
import { classifyFailure } from "../../common/classify.js";

/**
 * @param {unknown} message an AssistantMessage that ended the run
 * @returns {{rotate: boolean, kind: string, reason: string, provider: string, id: string}|undefined}
 *   undefined when the message is not a terminal failure the router should act on
 */
export function resolveDeadEnd(message) {
  if (!message || typeof message !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (message);
  if (record.role !== "assistant") return undefined;
  if (record.stopReason !== "error") return undefined;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const id = typeof record.model === "string" ? record.model : "";
  if (!provider || !id) return undefined;
  const verdict = classifyFailure(record.errorMessage);
  return {
    rotate: verdict.rotate,
    kind: verdict.kind,
    reason: verdict.reason,
    provider,
    id,
  };
}

/**
 * The last assistant message of a run, which is the one that ended it.
 * @param {readonly unknown[]} messages
 */
export function lastAssistantMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = /** @type {Record<string, unknown>} */ (messages[index]);
    if (message && message.role === "assistant") return message;
  }
  return undefined;
}
