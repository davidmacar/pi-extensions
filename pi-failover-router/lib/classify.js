/**
 * Failure classification for the failover router.
 *
 * Pi classifies a terminal error into exactly one category and only lets six of
 * them drive a fallback (quota, auth, rate_limit, provider_unavailable, timeout,
 * network). Everything else — notably `invalid_request` and the generic
 * `unavailable` bucket — never moves on. Real channel defects land in those dead
 * ends:
 *
 *   - a channel that rejects tool calls answers 400 "invalid_request_error", so
 *     it is classified as a request problem and the chain stays put;
 *   - a stream cut mid-response (`status_code=499, ... http2: response body
 *     closed`) matches no keyword and falls into the generic bucket.
 *
 * This module decides, from the raw error text, whether the failure is worth
 * retrying on a different model. It is deliberately conservative: a genuinely
 * malformed request must NOT rotate, because every model would fail the same way.
 */

/** Ordered most-specific-first; the first match wins. */
const RULES = [
  {
    // Provider said the account/channel lacks a capability the request needs.
    // This is channel-owned, not request-owned: another channel can serve it.
    kind: "channel_capability",
    pattern:
      /requires responses|only supports chat completions|does not support|not supported by this (?:account|channel)|无可用渠道|bad_response_status_code/i,
  },
  {
    // Stream died after the response started.
    kind: "incomplete_stream",
    pattern:
      /incomplete_stream|stream read failed|response body closed|other side closed|socket hang up|premature (?:close|eof)|unexpected end of stream/i,
  },
  {
    kind: "network",
    pattern: /ECONN(?:RESET|REFUSED|ABORTED|CLOSED)|ENOTFOUND|EAI_AGAIN|fetch failed|network|connection (?:reset|closed)/i,
  },
  {
    kind: "rate_limit",
    pattern: /rate.?limit|too many requests|429/i,
  },
  {
    kind: "quota",
    pattern: /quota|billing|out of budget|usage.?limit|credit balance|insufficient/i,
  },
  {
    kind: "auth",
    pattern: /unauthori[sz]ed|forbidden|authenticat|invalid api.?key|permission.?denied|401|403/i,
  },
  {
    kind: "timeout",
    pattern: /time.?out|timed out|deadline exceeded|504|408/i,
  },
  {
    kind: "provider_unavailable",
    pattern: /overloaded|unavailable|server.?error|internal.?error|server_busy|capacity|high demand|50[023]/i,
  },
];

/**
 * Genuinely request-shaped problems. Checked BEFORE the rules above so that a
 * body which merely mentions a 400 does not rotate a request that is malformed.
 * A payload-too-large / context problem is also excluded: switching model with
 * the same oversized conversation would fail again.
 */
const NEVER_ROTATE = [
  /context.?length|context.?window|maximum context|prompt is too long|too many tokens/i,
  /\bmax_tokens\b.*(?:exceed|invalid|too large)/i,
  /malformed (?:request|json)|invalid (?:json|schema)|missing required (?:field|parameter)|unexpected (?:field|parameter)/i,
  /tool_choice|parallel_tool_calls.*invalid/i,
];

/** Kinds that justify spending another call on a different model. */
const ROTATABLE = new Set([
  "channel_capability",
  "incomplete_stream",
  "network",
  "rate_limit",
  "quota",
  "auth",
  "timeout",
  "provider_unavailable",
]);

/**
 * @param {unknown} errorMessage raw provider/Pi error text
 * @returns {{rotate: boolean, kind: string, reason: string}}
 */
export function classifyFailure(errorMessage) {
  const text = typeof errorMessage === "string" ? errorMessage.slice(0, 8192) : "";
  if (!text) return { rotate: false, kind: "empty", reason: "no error text to classify" };

  for (const pattern of NEVER_ROTATE) {
    if (pattern.test(text)) {
      return { rotate: false, kind: "request_invalid", reason: `request-shaped failure: ${pattern.source}` };
    }
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { rotate: ROTATABLE.has(rule.kind), kind: rule.kind, reason: `matched ${rule.kind}` };
    }
  }
  return { rotate: false, kind: "unknown", reason: "no rule matched; refusing to rotate on an unknown failure" };
}

/**
 * Picks the next model for a failed request.
 *
 * @param {object} args
 * @param {Array<{model: string, thinkingLevel?: string}>} args.chain ordered candidates
 * @param {string|undefined} args.failedModel the model that just failed
 * @param {Map<string, number>|{get: Function, has?: Function}} args.cooldowns model -> expiry epoch ms
 * @param {number} args.now epoch ms
 * @returns {{model: string, thinkingLevel?: string}|undefined}
 */
export function nextCandidate({ chain, failedModel, cooldowns, now }) {
  for (const step of chain) {
    if (step.model === failedModel) continue;
    const until = cooldowns.get(step.model) ?? 0;
    if (until > now) continue;
    return step.thinkingLevel ? step : { model: step.model };
  }
  return undefined;
}

/**
 * Cooldown window for a kind. Exhausted credentials stay out much longer than
 * transient transport trouble.
 */
export function cooldownMs(kind) {
  if (kind === "quota" || kind === "auth") return 30 * 60_000;
  return 2 * 60_000;
}
