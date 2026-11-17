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
export const SPEED_CACHE_VERSION = 3;
/** Samples kept per channel as history. Only the newest one decides the order. */
export const MAX_SAMPLES = 5;
/**
 * Attempts kept per channel. Each one carries the message that explains it, so a
 * channel with no measurement can be diagnosed from the cache alone instead of
 * from a session transcript that is already gone.
 */
export const MAX_ATTEMPTS = 5;
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
 * @param {unknown} value
 * @returns {Array<{at: number, ok: boolean, message: string}>}
 */
function normalizeAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((attempt) => attempt && typeof attempt === "object" && typeof attempt.at === "number")
    .map((attempt) => ({
      at: attempt.at,
      ok: attempt.ok === true,
      message: typeof attempt.message === "string" ? attempt.message : "",
    }))
    .slice(-MAX_ATTEMPTS);
}

/**
 * @param {Array<object>|undefined} attempts
 * @param {{at: number, ok: boolean, message: string}} attempt
 */
function withAttempt(attempts, attempt) {
  return [...(attempts ?? []), attempt].slice(-MAX_ATTEMPTS);
}

/**
 * @param {unknown} doc
 * @returns {ReturnType<typeof emptyCache>|undefined} undefined when unreadable
 */
export function normalizeCache(doc) {
  if (!doc || typeof doc !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (doc);
  if (record.kind !== SPEED_CACHE_KIND) return undefined;
  // Version 1 carried no failure or tier information and version 2 stored a
  // single error instead of a log of attempts; both are read and upgraded.
  if (![1, 2, SPEED_CACHE_VERSION].includes(record.version)) return undefined;
  if (!record.channels || typeof record.channels !== "object") return undefined;
  const cache = emptyCache();
  for (const [ref, raw] of Object.entries(/** @type {Record<string, unknown>} */ (record.channels))) {
    if (!raw || typeof raw !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const samples = normalizeSamples(entry.samples);
    const measuredAt = typeof entry.measuredAt === "number" ? entry.measuredAt : 0;
    const tier = normalizeTier(entry.timeoutTierMs);
    const attempts = normalizeAttempts(entry.attempts);
    const lastError =
      entry.lastError && typeof entry.lastError === "object"
        ? /** @type {Record<string, unknown>} */ (entry.lastError)
        : undefined;
    const failureAt = typeof lastError?.at === "number" ? lastError.at : undefined;
    const failureMessage = typeof lastError?.message === "string" ? lastError.message : undefined;
    // Version 2 kept only the last error; it becomes the newest attempt.
    if (failureAt !== undefined) {
      attempts.push({ at: failureAt, ok: false, message: failureMessage ?? "" });
    }
    const kept = attempts.slice(-MAX_ATTEMPTS);
    if (samples.length === 0 && kept.length === 0) continue;
    const normalized = { samples, measuredAt, attempts: kept };
    if (tier !== undefined) normalized.timeoutTierMs = tier;
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

/**
 * Throughput of the newest measurement.
 *
 * The order has to follow the channel as it is now: a channel that starts to
 * degrade must lose its place on the next measurement, and an average over the
 * history would keep it in front for several sessions. The earlier samples stay
 * in the cache for inspection only.
 *
 * @param {object|undefined} cache
 * @param {string} ref
 * @returns {number|undefined}
 */
export function tokensPerSecond(cache, ref) {
  const samples = cache?.channels?.[ref]?.samples ?? [];
  if (samples.length === 0) return undefined;
  return samples[samples.length - 1];
}

/** The timeout that last worked for a channel, or the first tier when unknown. */
export function startingTier(cache, ref) {
  return cache?.channels?.[ref]?.timeoutTierMs ?? PROBE_TIMEOUT_TIERS_MS[0];
}

/** Adds one sample and stamps it. A success clears the remembered failure. */
export function recordSample(cache, ref, sample, now, tierMs, message) {
  const base = cache ?? emptyCache();
  const previous = base.channels[ref];
  const samples = [...(previous?.samples ?? []), sample].slice(-MAX_SAMPLES);
  const entry = {
    samples,
    measuredAt: now,
    attempts: withAttempt(previous?.attempts, {
      at: now,
      ok: true,
      message: typeof message === "string" && message !== "" ? message : `${sample.toFixed(1)} tok/s`,
    }),
  };
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
  const entry = {
    samples: previous?.samples ?? [],
    measuredAt: previous?.measuredAt ?? 0,
    attempts: withAttempt(previous?.attempts, {
      at: now,
      ok: false,
      message: typeof message === "string" ? message : String(message),
    }),
  };
  const tier = normalizeTier(previous?.timeoutTierMs);
  if (tier !== undefined) entry.timeoutTierMs = tier;
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
    const newest = entry.attempts?.[entry.attempts.length - 1];
    if (newest && !newest.ok) return true;
    return now - entry.measuredAt >= SPEED_TTL_MS;
  });
}

/** True when at least one channel needs a measurement session. */
export function probeIsDue(cache, refs, now) {
  return dueRefs(cache, refs, now).length > 0;
}
