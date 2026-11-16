/**
 * Persisted tokens-per-second measurements.
 *
 * A measurement session costs real requests and real money, so the result is
 * cached on disk with a 15 minute window: starting several Pi sessions in a row
 * probes once, not once per session. The cache carries no credentials, only
 * timings keyed by `provider/id`.
 *
 * The cache also remembers *failures*, so "this channel was never measured" is
 * distinguishable from "this channel could not be measured" — without that, a
 * channel that always times out looks exactly like one the router forgot about.
 */
export const SPEED_TTL_MS = 15 * 60_000;
export const SPEED_CACHE_KIND = "pi-failover-router.speed";
export const SPEED_CACHE_VERSION = 2;
/** Samples kept per channel; the median is used so one hung probe cannot win. */
export const MAX_SAMPLES = 5;
/**
 * Timeout tiers, in milliseconds. A short attempt keeps the common case fast; a
 * channel that cannot answer in time is retried with the wider budget, and the
 * tier that worked is remembered so a slow model stops paying for the short
 * attempt on every run.
 */
export const PROBE_TIMEOUT_TIERS_MS = [15_000, 45_000];

/** @returns {{kind: string, version: number, channels: Record<string, object>}} */
export function emptyCache() {
  return { kind: SPEED_CACHE_KIND, version: SPEED_CACHE_VERSION, channels: {} };
}

function normalizeTier(value) {
  return PROBE_TIMEOUT_TIERS_MS.includes(value) ? value : undefined;
}

function normalizeSamples(value) {
  return Array.isArray(value)
    ? value.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-MAX_SAMPLES)
    : [];
}

/**
 * @param {unknown} doc
 * @returns {ReturnType<typeof emptyCache>|undefined} undefined when unreadable
 */
export function normalizeCache(doc) {
  if (!doc || typeof doc !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (doc);
  if (record.kind !== SPEED_CACHE_KIND) return undefined;
  // Version 1 carried no failure or tier information; read it, upgrade it.
  if (record.version !== 1 && record.version !== SPEED_CACHE_VERSION) return undefined;
  if (!record.channels || typeof record.channels !== "object") return undefined;
  const cache = emptyCache();
  for (const [ref, raw] of Object.entries(/** @type {Record<string, unknown>} */ (record.channels))) {
    if (!raw || typeof raw !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const samples = normalizeSamples(entry.samples);
    const measuredAt = typeof entry.measuredAt === "number" ? entry.measuredAt : 0;
    const tier = normalizeTier(entry.timeoutTierMs);
    const lastError =
      entry.lastError && typeof entry.lastError === "object"
        ? /** @type {Record<string, unknown>} */ (entry.lastError)
        : undefined;
    const failureAt = typeof lastError?.at === "number" ? lastError.at : undefined;
    const failureMessage = typeof lastError?.message === "string" ? lastError.message : undefined;
    if (samples.length === 0 && failureAt === undefined) continue;
    const normalized = { samples, measuredAt };
    if (tier !== undefined) normalized.timeoutTierMs = tier;
    if (failureAt !== undefined) normalized.lastError = { at: failureAt, message: failureMessage ?? "" };
    cache.channels[ref] = normalized;
  }
  return cache;
}

/** Parses cache text; anything malformed yields no cache rather than throwing. */
export function parseCacheText(text) {
  try {
    return normalizeCache(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * @param {string} path
 * @param {{readFile?: (path: string, encoding: string) => string}} [deps]
 */
export function readSpeedCache(path, { readFile } = {}) {
  if (!readFile) return undefined;
  try {
    return parseCacheText(readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Median of the kept samples: resistant to one slow or one suspiciously fast probe. */
export function tokensPerSecond(cache, ref) {
  const samples = cache?.channels?.[ref]?.samples ?? [];
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The timeout that last worked for a channel, or the first tier when unknown. */
export function startingTier(cache, ref) {
  return cache?.channels?.[ref]?.timeoutTierMs ?? PROBE_TIMEOUT_TIERS_MS[0];
}

/** Adds one sample and stamps it. A success clears the remembered failure. */
export function recordSample(cache, ref, sample, now, tierMs) {
  const base = cache ?? emptyCache();
  const previous = base.channels[ref];
  const samples = [...(previous?.samples ?? []), sample].slice(-MAX_SAMPLES);
  const entry = { samples, measuredAt: now };
  const tier = normalizeTier(tierMs) ?? normalizeTier(previous?.timeoutTierMs);
  if (tier !== undefined) entry.timeoutTierMs = tier;
  return { ...base, channels: { ...base.channels, [ref]: entry } };
}

/**
 * Remembers that a channel could not be measured. Samples are kept: a known fast
 * channel that failed once is still a known fast channel. The failure is recorded
 * so the channel is retried on the next measurement session instead of being
 * silently skipped, and so the log has something to show.
 */
export function recordFailure(cache, ref, message, now) {
  const base = cache ?? emptyCache();
  const previous = base.channels[ref];
  const entry = { samples: previous?.samples ?? [], measuredAt: previous?.measuredAt ?? 0 };
  const tier = normalizeTier(previous?.timeoutTierMs);
  if (tier !== undefined) entry.timeoutTierMs = tier;
  entry.lastError = { at: now, message: typeof message === "string" ? message : String(message) };
  return { ...base, channels: { ...base.channels, [ref]: entry } };
}

/**
 * Which channels this measurement session must probe: the ones never measured,
 * the ones whose last sample is older than the window, and the ones whose last
 * attempt failed. Channels that are fresh and healthy are left alone, so a run
 * never re-measures the whole chain to repair one channel.
 *
 * @param {ReturnType<typeof emptyCache>|undefined} cache
 * @param {string[]} refs channels the chains actually use
 * @param {number} now
 */
export function dueRefs(cache, refs, now) {
  if (refs.length === 0) return [];
  if (!cache) return [...refs];
  return refs.filter((ref) => {
    const entry = cache.channels[ref];
    if (!entry) return true;
    if (entry.lastError && entry.lastError.at >= entry.measuredAt) return true;
    return now - entry.measuredAt >= SPEED_TTL_MS;
  });
}

/** True when at least one channel needs a measurement session. */
export function probeIsDue(cache, refs, now) {
  return dueRefs(cache, refs, now).length > 0;
}
