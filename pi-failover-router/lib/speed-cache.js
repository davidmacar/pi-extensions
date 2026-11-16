/**
 * Persisted tokens-per-second measurements.
 *
 * A measurement session costs real requests and real money, so the result is
 * cached on disk with a 15 minute window: starting several Pi sessions in a row
 * probes once, not once per session. The cache carries no credentials, only
 * timings keyed by `provider/id`.
 */
export const SPEED_TTL_MS = 15 * 60_000;
export const SPEED_CACHE_KIND = "pi-failover-router.speed";
export const SPEED_CACHE_VERSION = 1;
/** Samples kept per channel; the median is used so one hung probe cannot win. */
export const MAX_SAMPLES = 5;

/** @returns {{kind: string, version: number, channels: Record<string, {samples: number[], measuredAt: number}>}} */
export function emptyCache() {
  return { kind: SPEED_CACHE_KIND, version: SPEED_CACHE_VERSION, channels: {} };
}

/**
 * @param {unknown} doc
 * @returns {ReturnType<typeof emptyCache>|undefined} undefined when unreadable
 */
export function normalizeCache(doc) {
  if (!doc || typeof doc !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (doc);
  if (record.kind !== SPEED_CACHE_KIND || record.version !== SPEED_CACHE_VERSION) return undefined;
  if (!record.channels || typeof record.channels !== "object") return undefined;
  const cache = emptyCache();
  for (const [ref, raw] of Object.entries(/** @type {Record<string, unknown>} */ (record.channels))) {
    if (!raw || typeof raw !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const samples = Array.isArray(entry.samples)
      ? entry.samples.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-MAX_SAMPLES)
      : [];
    if (samples.length === 0) continue;
    const measuredAt = typeof entry.measuredAt === "number" ? entry.measuredAt : 0;
    cache.channels[ref] = { samples, measuredAt };
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
  const entry = cache?.channels?.[ref];
  if (!entry || entry.samples.length === 0) return undefined;
  const sorted = [...entry.samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Adds one sample and stamps the measurement time. Returns a new cache. */
export function recordSample(cache, ref, sample, now) {
  const base = cache ?? emptyCache();
  const previous = base.channels[ref]?.samples ?? [];
  const samples = [...previous, sample].slice(-MAX_SAMPLES);
  return { ...base, channels: { ...base.channels, [ref]: { samples, measuredAt: now } } };
}

/**
 * A measurement session is due when any channel has no sample or a sample older
 * than the 15 minute window.
 *
 * @param {ReturnType<typeof emptyCache>|undefined} cache
 * @param {string[]} refs channels the chains actually use
 * @param {number} now
 */
export function probeIsDue(cache, refs, now) {
  if (!cache || refs.length === 0) return true;
  return refs.some((ref) => {
    const entry = cache.channels[ref];
    if (!entry) return true;
    return now - entry.measuredAt >= SPEED_TTL_MS;
  });
}
