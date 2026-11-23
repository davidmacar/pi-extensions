/**
 * Ordering a chain by measured throughput.
 *
 * Only measured channels are reordered; a channel that has never been probed
 * keeps its original (cost) position. That makes the first run of a fresh
 * install behave exactly like the cheaper list, and only an observation can
 * promote a channel.
 */

/**
 * @param {Array<{model: string, thinkingLevel?: string}>} chain
 * @param {{channels: Record<string, {samples: number[], measuredAt: number}>}|undefined} cache
 * @param {(cache: object, ref: string) => number|undefined} tps
 * @returns {Array<{model: string, thinkingLevel?: string}>}
 */
export function orderBySpeed(chain, cache, tps) {
  const rows = chain.map((step, index) => ({
    step,
    index,
    speed: cache ? tps(cache, step.model) : undefined,
    failed: cache?.channels?.[step.model]?.attempts?.at?.(-1)?.ok === false,
  }));
  const measured = rows
    .filter((row) => row.speed !== undefined && !row.failed)
    .sort((a, b) => b.speed - a.speed || a.index - b.index);
  const unmeasured = rows
    .filter((row) => row.speed === undefined && !row.failed)
    .sort((a, b) => a.index - b.index);
  const failed = rows
    .filter((row) => row.failed)
    .sort((a, b) => a.index - b.index);
  return [...measured, ...unmeasured, ...failed].map((row) => row.step);
}
