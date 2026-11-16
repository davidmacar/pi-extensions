/**
 * Measuring one channel's output throughput.
 *
 * The probe asks for a deliberately short completion and divides the output
 * tokens the provider reports by the wall time it took. Requests are injected
 * so the measurement can be tested without network access.
 */
export const PROBE_PROMPT = "Reply with the single word: ok";
export const PROBE_MAX_TOKENS = 100;
/** A probe that cannot answer in this window is abandoned; it never blocks a request. */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * @param {object} args
 * @param {{provider: string, id: string}} args.model
 * @param {(model: object, context: object, options: object) => Promise<object>} args.complete
 * @param {object} args.requestModel the model object Pi resolves from the registry
 * @param {() => number} [args.now]
 * @returns {Promise<{tokensPerSecond: number, outputTokens: number, elapsedMs: number}>}
 */
export async function measureChannel({ model, complete, requestModel, now = Date.now }) {
  const startedAt = now();
  const message = await complete(
    requestModel,
    { messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }] },
    { maxTokens: PROBE_MAX_TOKENS, thinkingLevel: "off", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
  );
  const elapsedMs = now() - startedAt;
  const outputTokens = message?.usage?.output;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens <= 0) {
    throw new Error(`${model.provider}/${model.id}: probe reported no output tokens`);
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error(`${model.provider}/${model.id}: probe reported no elapsed time`);
  }
  return { tokensPerSecond: outputTokens / (elapsedMs / 1000), outputTokens, elapsedMs };
}

/**
 * Probes every channel once, in sequence, so the measurement is not distorted by
 * channels competing for bandwidth. Failures are reported and skipped: a channel
 * that cannot answer keeps its previous sample.
 *
 * @param {object} args
 * @param {string[]} args.refs `provider/id` entries to measure
 * @param {(ref: string) => object|undefined} args.find
 * @param {(model: object, context: object, options: object) => Promise<object>} args.complete
 * @param {(message: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @returns {Promise<Array<{ref: string, tokensPerSecond: number}>>}
 */
export async function probeChannels({ refs, find, complete, log, now = Date.now }) {
  const measured = [];
  for (const ref of refs) {
    const requestModel = find(ref);
    if (!requestModel) {
      log?.(`failover-router: speed probe skipped ${ref}: not in the catalog`);
      continue;
    }
    const slash = ref.indexOf("/");
    const model = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
    try {
      const result = await measureChannel({ model, complete, requestModel, now });
      measured.push({ ref, tokensPerSecond: result.tokensPerSecond });
      log?.(
        `failover-router: speed probe ${ref} ${result.tokensPerSecond.toFixed(1)} tok/s ` +
          `(${result.outputTokens} tokens in ${result.elapsedMs} ms)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.(`failover-router: speed probe failed for ${ref}: ${message}`);
    }
  }
  return measured;
}
