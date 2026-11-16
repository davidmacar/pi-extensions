/**
 * Measuring one channel's output throughput.
 *
 * The probe asks for a deliberately short completion and divides the output
 * tokens the provider reports by the wall time it took. Requests are injected
 * so the measurement can be tested without network access.
 *
 * Two timeouts, not one: a stalled channel is abandoned when its first token
 * does not arrive (latency), while a channel that is merely slow at generating
 * keeps its full budget (throughput). One fixed deadline punishes exactly the
 * reasoning models whose throughput is worth measuring.
 */
import { PROBE_TIMEOUT_TIERS_MS } from "./speed-cache.js";

export { PROBE_TIMEOUT_TIERS_MS };

export const PROBE_PROMPT = "Reply with the single word: ok";
export const PROBE_MAX_TOKENS = 100;
/**
 * Silence budget for a channel no tier has been recorded for. The tiers
 * themselves are the budgets; this is only the baseline used to decide.
 */
export const PROBE_FIRST_TOKEN_MS = 20_000;
/** Silence budget for the widest tier. Only a channel that is truly gone waits this long. */
export const PROBE_FIRST_TOKEN_WIDE_MS = 99_000;

/**
 * Creates a budget that aborts on first-token latency or on total generation
 * time, whichever is exceeded first.
 *
 * @param {() => number} [now]
 */
export function createProbeBudget({ firstTokenMs = PROBE_FIRST_TOKEN_MS, now = Date.now } = {}) {
  const controller = new AbortController();
  const startedAt = now();
  // One deadline: how long the channel may stay silent. Generation time is not
  // capped separately because `complete()` returns only when the reply is done,
  // so a separate generation cap would cut a healthy slow model.
  const deadline = startedAt + firstTokenMs;

  const timer = setInterval(() => {
    if (now() < deadline) return;
    clearInterval(timer);
    controller.abort(new Error(`no answer within ${firstTokenMs / 1000}s`));
  }, 250);
  // Deliberately not unref'd: while a probe is awaited, the deadline must be able
  // to fire even if nothing else keeps the event loop alive.

  return {
    signal: controller.signal,
    stop() {
      clearInterval(timer);
    },
  };
}


/**
 * Describes a response well enough to diagnose a probe that produced nothing.
 * A bare "no output tokens" hides whether the channel answered with an error, came
 * back empty, or simply does not report usage — three very different problems.
 *
 * @param {unknown} message
 */
export function describeResponse(message) {
  if (!message || typeof message !== "object") return "no response object";
  const record = /** @type {Record<string, unknown>} */ (message);
  const parts = [`stopReason=${typeof record.stopReason === "string" ? record.stopReason : "missing"}`];
  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
  if (errorMessage) parts.push(`errorMessage=${errorMessage.slice(0, 300)}`);
  const usage = record.usage;
  if (!usage || typeof usage !== "object") {
    parts.push("no usage");
  } else {
    const counters = /** @type {Record<string, unknown>} */ (usage);
    const shown = ["input", "output", "totalTokens"]
      .filter((key) => typeof counters[key] === "number")
      .map((key) => `${key}:${counters[key]}`);
    parts.push(shown.length > 0 ? `usage={${shown.join(",")}}` : "usage without counters");
  }
  return parts.join("; ");
}

/**
 * @param {object} args
 * @param {{provider: string, id: string}} args.model
 * @param {(model: object, context: object, options: object) => Promise<object>} args.complete
 * @param {object} args.requestModel the model object Pi resolves from the registry
 * @param {() => number} [args.now]
 * @param {object} [args.budget] a created budget; one is made when omitted
 * @returns {Promise<{tokensPerSecond: number, outputTokens: number, elapsedMs: number}>}
 */
export async function measureChannel({ model, complete, requestModel, now = Date.now, budget }) {
  const active = budget ?? createProbeBudget({ now });
  const startedAt = now();
  let message;
  try {
    message = await complete(
      requestModel,
      { messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }] },
      { maxTokens: PROBE_MAX_TOKENS, thinkingLevel: "off", signal: active.signal },
    );
  } finally {
    active.stop();
  }
  const elapsedMs = now() - startedAt;
  const failureText = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";

  // A channel that answers with an error is the interesting case: it is exactly the
  // channel-owned defect the router exists for, and it must not be reported as an
  // empty measurement.
  if (message?.stopReason === "error" || failureText) {
    throw new Error(
      `${model.provider}/${model.id}: channel error (${describeResponse(message)})`,
    );
  }

  const outputTokens = message?.usage?.output;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens <= 0) {
    throw new Error(
      `${model.provider}/${model.id}: probe reported no output tokens (${describeResponse(message)})`,
    );
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error(`${model.provider}/${model.id}: probe reported no elapsed time`);
  }
  return { tokensPerSecond: outputTokens / (elapsedMs / 1000), outputTokens, elapsedMs };
}

/**
 * Probes the given channels once, in sequence, so the measurement is not
 * distorted by channels competing for bandwidth. Every channel produces an
 * outcome: a measurement, or a recorded failure with its reason.
 *
 * @param {object} args
 * @param {string[]} args.refs `provider/id` entries to measure
 * @param {(ref: string) => object|undefined} args.find
 * @param {(model: object, context: object, options: object) => Promise<object>} args.complete
 * @param {(message: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {number} [args.timeoutMs] total budget per channel
 * @returns {Promise<{measured: Array<{ref: string, tokensPerSecond: number}>, failed: Array<{ref: string, message: string}>}>}
 */
export async function probeChannels({
  refs,
  find,
  complete,
  log,
  now = Date.now,
  tiers = PROBE_TIMEOUT_TIERS_MS,
  startingTierFor = () => tiers[0],
}) {
  const measured = [];
  const failed = [];
  for (const ref of refs) {
    const requestModel = find(ref);
    if (!requestModel) {
      failed.push({ ref, message: "not in the catalog" });
      log?.(`failover-router: speed probe skipped ${ref}: not in the catalog`);
      continue;
    }
    const slash = ref.indexOf("/");
    const model = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };

    // Start at the tier that worked last time for this channel, then widen. A
    // slow reasoning model stops paying for the short attempt on every run,
    // and a channel that got faster is not stuck on the long one.
    const startTier = startingTierFor(ref);
    let startIndex = Math.max(0, tiers.indexOf(startTier));
    let result;
    let lastMessage = "";
    for (let attempt = startIndex; attempt < tiers.length; attempt += 1) {
      try {
        const lastTier = attempt === tiers.length - 1;
        result = await measureChannel({
          model,
          complete,
          requestModel,
          now,
          budget: createProbeBudget({
            // The tier *is* the silence budget: a channel that answers inside its
            // tier passes, one that stays silent moves up.
            firstTokenMs: lastTier ? Math.max(PROBE_FIRST_TOKEN_WIDE_MS, tiers[attempt]) : tiers[attempt],
            now,
          }),
        });
        result.timeoutTierMs = tiers[attempt];
        if (attempt > startIndex) {
          log?.(`failover-router: ${ref} needed the ${tiers[attempt] / 1000}s tier`);
        }
        break;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
        if (attempt === tiers.length - 1) break;
        log?.(`failover-router: ${ref} timed out at ${tiers[attempt] / 1000}s; retrying with the next tier`);
      }
    }

    if (result) {
      measured.push({ ref, tokensPerSecond: result.tokensPerSecond, timeoutTierMs: result.timeoutTierMs });
      log?.(
        `failover-router: speed probe ${ref} ${result.tokensPerSecond.toFixed(1)} tok/s ` +
          `(${result.outputTokens} tokens in ${result.elapsedMs} ms, ${result.timeoutTierMs / 1000}s tier)`,
      );
    } else {
      failed.push({ ref, message: lastMessage });
      log?.(`failover-router: speed probe failed for ${ref}: ${lastMessage}`);
    }
  }
  return { measured, failed };
}
