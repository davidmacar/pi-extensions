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
  const measured = chain
    .map((step, index) => ({ step, index, speed: cache ? tps(cache, step.model) : undefined }))
    .filter((row) => row.speed !== undefined)
    .sort((a, b) => b.speed - a.speed || a.index - b.index);
  const unmeasured = chain
    .map((step, index) => ({ step, index, speed: cache ? tps(cache, step.model) : undefined }))
    .filter((row) => row.speed === undefined)
    .sort((a, b) => a.index - b.index);
  return [...measured, ...unmeasured].map((row) => row.step);
}
