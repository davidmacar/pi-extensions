import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dueRefs, pruneCache, readSpeedCache, recordFailure, recordSample,
  PROBE_TIMEOUT_TIERS_MS, SPEED_TTL_MS, startingTier,
} from "../../common/speed-cache.js";
import { PROBE_PROMPT, PROBE_MAX_TOKENS } from "../../common/speed-probe.js";
import { prunePriceCache, readPriceCache, recordPrices } from "../../common/price-cache.js";
import { fetchSubrouterPrices } from "../../common/subrouter-prices.js";
import { ADMISSIBLE_LEVELS } from "../../common/thinking-level.js";
import { dispatchUpstream } from "./upstream.js";

const PRICE_REFRESH_MS = 60 * 60_000;
const STARTUP_WAIT_MS = 8_000;
const SPEED_FILE = "failover-router-speed.json";
const PRICE_FILE = "failover-router-price.json";
const refFor = step => `${step.channel}/${step.model}`;

// Settle even if an injected fetch or body reader does not honor its signal.
function abortable(signal, work) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function probePayload(protocol, step) {
  const effort = step.reasoningEffort ?? ADMISSIBLE_LEVELS.find(level => step.reasoningLevels?.includes(level));
  if (protocol === "responses") {
    return { model: step.model, input: PROBE_PROMPT, max_output_tokens: PROBE_MAX_TOKENS, store: false,
      ...(effort ? { reasoning: { effort } } : {}) };
  }
  return { model: step.model, messages: [{ role: "user", content: PROBE_PROMPT }],
    ...(effort ? { max_completion_tokens: PROBE_MAX_TOKENS, reasoning_effort: effort } : { max_tokens: PROBE_MAX_TOKENS }) };
}

function waitBounded(jobs, request, shutdown) {
  if (!jobs.length || shutdown.aborted) return;
  request?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      request?.removeEventListener("abort", cancel);
      shutdown.removeEventListener("abort", finish);
    };
    const finish = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(request.reason); };
    const timer = setTimeout(finish, STARTUP_WAIT_MS);
    request?.addEventListener("abort", cancel, { once: true });
    shutdown.addEventListener("abort", finish, { once: true });
    void Promise.allSettled(jobs).then(finish);
  });
}

/** Opt-in gateway metrics; only startup work is awaited, and only for a bounded time. */
export function createMetrics({ config, stateDir, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} }) {
  const speedPath = join(stateDir, SPEED_FILE);
  const pricePath = join(stateDir, PRICE_FILE);
  const profiles = Object.values(config.profiles);
  const speedProfiles = new Set(profiles.filter(profile => profile.order === "speed"));
  const speedRefs = [...new Set([...speedProfiles].flatMap(profile => profile.chain.map(refFor)))];
  const priceRefs = [...new Set(profiles.flatMap(profile => profile.chain)
    .filter(step => /^subrouter-.+/.test(step.channel)).map(refFor))];
  let speedCache = pruneCache(readSpeedCache(speedPath, { readFile: readFileSync }), speedRefs);
  let priceCache = prunePriceCache(readPriceCache(pricePath, { readFile: readFileSync }), priceRefs);
  let lastPriceAttempt = priceCache.updatedAt || (Object.keys(priceCache.prices).length ? 0 : undefined);
  let priceJob;
  let priceTimer;
  const shutdown = new AbortController();
  const { signal: stopped } = shutdown;
  const queued = new Map();
  let probeTail = Promise.resolve();

  function report(message) {
    try { log(`failover-router: ${message}`); } catch { /* Logging must not disrupt routing. */ }
  }

  function persist(path, cache, label) {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      report(`could not persist ${label} metrics cache`);
    }
  }

  async function probe(profile, step, ref) {
    if (stopped.aborted) return;
    const { protocol } = profile;
    const channel = config.channels[step.channel];
    const payload = probePayload(protocol, step);
    const firstTier = PROBE_TIMEOUT_TIERS_MS.indexOf(startingTier(speedCache, ref));
    let message = "probe failed";
    for (const tier of PROBE_TIMEOUT_TIERS_MS.slice(Math.max(0, firstTier))) {
      const deadline = AbortSignal.timeout(tier);
      const signal = AbortSignal.any([stopped, deadline]);
      const startedAt = now();
      try {
        const result = await abortable(signal, () => dispatchUpstream({ channel, path: `/${protocol}`, payload, fetchImpl, signal, timeoutMs: tier }));
        if (stopped.aborted) return;
        if (result.detail === "timeout") { message = "probe timed out"; continue; }
        if (!result.ok) { message = `HTTP ${result.status}`; break; }
        const body = JSON.parse(result.body);
        const count = protocol === "responses" ? body.usage?.output_tokens : body.usage?.completion_tokens;
        const measuredAt = now();
        const elapsed = measuredAt - startedAt;
        if (!Number.isFinite(count) || count <= 0) { message = "probe reported no output tokens"; break; }
        const speed = count / (elapsed / 1000);
        if (!Number.isFinite(speed) || speed <= 0) { message = "probe reported invalid elapsed time"; break; }
        message = `${speed.toFixed(1)} tok/s (${count} tokens in ${elapsed} ms)`;
        speedCache = recordSample(speedCache, ref, speed, measuredAt, tier, message);
        persist(speedPath, speedCache, "speed");
        report(`speed probe ${ref}: ${message}`);
        return;
      } catch {
        if (stopped.aborted) return;
        if (deadline.aborted) { message = "probe timed out"; continue; }
        message = "probe failed";
        break;
      }
    }
    speedCache = recordFailure(speedCache, ref, message, now());
    persist(speedPath, speedCache, "speed");
    report(`speed probe failed for ${ref}: ${message}`);
  }

  function prepareSpeed(profile) {
    if (config.probeSpeed !== true || !speedProfiles.has(profile)) return [];
    const at = now();
    const due = new Set(dueRefs(speedCache, profile.chain.map(refFor), at));
    const jobs = [];
    for (const step of profile.chain) {
      const ref = refFor(step);
      let job = queued.get(ref);
      if (!job && due.has(ref)) {
        // Share one measurement per physical ref, regardless of which profile
        // needs it. Failed probes retry at most once per TTL in this gateway.
        const last = speedCache.channels[ref]?.attempts.at(-1);
        if (last?.ok === false && at - last.at < SPEED_TTL_MS) continue;
        job = probeTail.then(() => probe(profile, step, ref))
          .catch(() => report("speed measurement failed"))
          .finally(() => queued.delete(ref));
        queued.set(ref, job);
        probeTail = job;
      }
      if (job) jobs.push(job);
    }
    return jobs;
  }

  // The shared fetcher owns marketplace matching and its deadline; guard both
  // fetch and body reads with that signal plus the gateway's lifetime signal.
  async function fetchMarketplace(url, options) {
    const signal = AbortSignal.any([options.signal, stopped]);
    const response = await abortable(signal, () => fetchImpl(url, { ...options, signal, redirect: "manual" }));
    if (!response.ok) void response.body?.cancel().catch(() => {});
    return { ok: response.ok, status: response.status, json: () => abortable(signal, () => response.json()) };
  }

  function refreshPrices() {
    if (stopped.aborted) return;
    if (priceJob) return priceJob;
    const startedAt = now();
    if (lastPriceAttempt !== undefined && startedAt - lastPriceAttempt < PRICE_REFRESH_MS) return;
    lastPriceAttempt = startedAt;
    priceJob = fetchSubrouterPrices(priceRefs, { fetchImpl: fetchMarketplace, now }).then(({ prices, failures }) => {
      if (stopped.aborted) return;
      // The shared fetcher matches the provider and model, but currency is
      // arbitrary provider text. Keep only currencies the shared order can use.
      const valid = Object.fromEntries(Object.entries(prices).filter(([, row]) => /^(CNY|USD)$/i.test(row.price_currency.trim())));
      if (Object.keys(valid).length) {
        priceCache = recordPrices(priceCache, valid, startedAt);
        persist(pricePath, priceCache, "marketplace");
      }
      if (failures.length) report(`${failures.length} marketplace price fetch(es) failed`);
    }).catch(() => {
      if (!stopped.aborted) report("marketplace price refresh failed");
    }).finally(() => { priceJob = undefined; });
    return priceJob;
  }

  async function prepare(profile, signal) {
    signal?.throwIfAborted();
    if (stopped.aborted) return;
    const jobs = prepareSpeed(profile);
    if (config.refreshMarketplace === true && priceRefs.length) {
      if (priceTimer === undefined) {
        priceTimer = setInterval(refreshPrices, PRICE_REFRESH_MS);
        priceTimer.unref();
      }
      const prices = refreshPrices();
      if (profile.order === "cost" && prices) jobs.push(prices);
    }
    await waitBounded(jobs, signal, stopped);
  }

  function close() {
    if (stopped.aborted) return;
    clearInterval(priceTimer);
    shutdown.abort();
  }

  return { prepare, getMetrics: () => ({ speedCache, priceCache }), close };
}
