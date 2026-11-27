import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { USD_TO_CNY } from "../../common/price-cache.js";

const MAX_COUNTER = 1_000_000_000;
const RATE_FIELDS = {
  input: "input_price",
  output: "output_price",
  cachedRead: "effective_cache_read_price",
  cacheWrite: "effective_cache_creation_price",
  cacheWrite1h: "effective_cache_creation_price_1h",
};
const MAX_AMOUNT = 1_000_000_000;
const validCount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
const safeName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;
const counter = value => validCount(value) ? value : null;
const failureKinds = new Set(["aborted", "unknown", "empty", "request_invalid", "channel_capability", "content_policy", "incomplete_stream", "network", "provider_unavailable", "rate_limit", "auth", "quota", "timeout", "upstream_unclassified", "upstream_request_failed"]);

export function normalizeUsage(protocol, usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: null, outputTokens: null, cachedReadTokens: null, cacheWriteTokens: null };
  }
  const details = protocol === "responses" ? usage.input_tokens_details : usage.prompt_tokens_details;
  const cached = details?.cached_tokens ?? usage.cached_tokens;
  const written = details?.cache_write_tokens ?? details?.cache_creation_input_tokens ?? usage.cache_write_tokens;
  return {
    inputTokens: counter(protocol === "responses" ? usage.input_tokens : usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: counter(protocol === "responses" ? usage.output_tokens : usage.completion_tokens ?? usage.output_tokens),
    cachedReadTokens: counter(cached),
    cacheWriteTokens: counter(written),
  };
}

function ratesInCny(tariff) {
  if (!tariff || typeof tariff !== "object" || !["CNY", "USD"].includes(String(tariff.price_currency).toUpperCase())) return undefined;
  const factor = String(tariff.price_currency).toUpperCase() === "USD" ? USD_TO_CNY : 1;
  const rates = {};
  for (const [key, field] of Object.entries(RATE_FIELDS)) {
    const raw = tariff[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) return undefined;
    rates[key] = value * factor;
    if (!Number.isFinite(rates[key])) return undefined;
  }
  return Object.keys(rates).length ? rates : undefined;
}

const roundCost = value => Number.isFinite(value) && value <= MAX_AMOUNT ? Math.round((value + Number.EPSILON) * 1e12) / 1e12 : null;

/** CNY per million tokens. Incomplete usage is recorded as partial/unknown, never zero-filled. */
export function estimateAttemptCost(usage, tariff) {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) {
    return { status: "unknown", currency: "CNY", amount: null, reason: "usage_missing", components: null };
  }
  const rates = ratesInCny(tariff);
  if (!rates) return { status: "unknown", currency: "CNY", amount: null, reason: "tariff_missing", components: null };
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) {
    return { status: "unknown", currency: "CNY", amount: null, reason: "usage_inconsistent", components: null };
  }
  const unknown = [];
  let regularInput;
  if (usage.cachedReadTokens === null) {
    if (rates.cachedRead !== undefined && usage.inputTokens > 0) unknown.push("cached_read_tokens_missing");
    regularInput = rates.cachedRead === undefined ? usage.inputTokens : null;
  } else if (!validCount(usage.cachedReadTokens) || usage.cachedReadTokens > usage.inputTokens) {
    return { status: "unknown", currency: "CNY", amount: null, reason: "usage_inconsistent", components: null };
  } else {
    regularInput = usage.inputTokens - usage.cachedReadTokens;
    if (usage.cachedReadTokens > 0 && rates.cachedRead === undefined) unknown.push("cache_read_rate_missing");
  }
  if (usage.cacheWriteTokens === null) {
    if ((rates.cacheWrite !== undefined || rates.cacheWrite1h !== undefined) && usage.inputTokens > 0) {
      unknown.push("cache_write_tokens_missing");
      regularInput = null;
    }
  } else if (!validCount(usage.cacheWriteTokens)) {
    return { status: "unknown", currency: "CNY", amount: null, reason: "usage_inconsistent", components: null };
  } else if (usage.cacheWriteTokens > 0) {
    if (rates.cacheWrite !== undefined && rates.cacheWrite1h !== undefined && rates.cacheWrite !== rates.cacheWrite1h) {
      // This usage field does not report the write duration. Never guess a tier.
      unknown.push("cache_write_tier_unknown");
      rates.cacheWrite = undefined;
    } else if (rates.cacheWrite === undefined) unknown.push("cache_write_rate_missing");
  }
  if (usage.cacheWriteTokens > 0 && regularInput !== null) {
    if (usage.cacheWriteTokens > regularInput) return { status: "unknown", currency: "CNY", amount: null, reason: "usage_inconsistent", components: null };
    regularInput -= usage.cacheWriteTokens;
  }
  if (regularInput > 0 && rates.input === undefined) unknown.push("input_rate_missing");
  if (usage.outputTokens > 0 && rates.output === undefined) unknown.push("output_rate_missing");
  const components = {
    input: regularInput === null || rates.input === undefined ? null : roundCost(regularInput * rates.input / 1_000_000),
    cachedRead: usage.cachedReadTokens === null ? null : usage.cachedReadTokens === 0 ? 0 : rates.cachedRead === undefined ? null : roundCost(usage.cachedReadTokens * rates.cachedRead / 1_000_000),
    cacheWrite: usage.cacheWriteTokens === null ? rates.cacheWrite === undefined && rates.cacheWrite1h === undefined ? 0 : null : usage.cacheWriteTokens === 0 ? 0 : rates.cacheWrite === undefined ? null : roundCost(usage.cacheWriteTokens * rates.cacheWrite / 1_000_000),
    output: rates.output === undefined ? usage.outputTokens === 0 ? 0 : null : roundCost(usage.outputTokens * rates.output / 1_000_000),
  };
  if ((regularInput > 0 && rates.input !== undefined && components.input === null) ||
      (usage.outputTokens > 0 && rates.output !== undefined && components.output === null) ||
      (usage.cachedReadTokens > 0 && rates.cachedRead !== undefined && components.cachedRead === null) ||
      (usage.cacheWriteTokens > 0 && rates.cacheWrite !== undefined && components.cacheWrite === null)) {
    return { status: "unknown", currency: "CNY", amount: null, reason: "amount_out_of_bounds", components: null };
  }
  const known = Object.values(components).filter(Number.isFinite);
  const subtotal = roundCost(known.reduce((sum, value) => sum + value, 0));
  if (subtotal === null) return { status: "unknown", currency: "CNY", amount: null, reason: "amount_out_of_bounds", components: null };
  if (unknown.length) return { status: "partial", currency: "CNY", amount: null, knownSubtotal: subtotal, reason: unknown.join(","), components };
  return { status: "estimated", currency: "CNY", amount: subtotal, components };
}

function safeUsage(usage) {
  return Object.fromEntries(["inputTokens", "outputTokens", "cachedReadTokens", "cacheWriteTokens"].map(key => [key, counter(usage?.[key])]));
}

/** Append-only private per-attempt estimates; never persists payloads or provider error text. */
export function createCostLedger({ stateDir, now = Date.now, requestId = randomUUID, log = () => {} }) {
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("cost ledger stateDir is required");
  const root = resolve(stateDir);
  const path = join(root, "cost-ledger.ndjson");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error("invalid ledger file");
    fchmodSync(fd, 0o600);
  } catch {
    closeSync(fd);
    throw new Error("cannot securely open cost ledger");
  }
  let writeWarning = false;
  let closed = false;
  function record(attempt) {
    if (closed || !attempt || typeof attempt !== "object") return;
    const requestedModel = safeName(attempt.requestedModel);
    const channel = safeName(attempt.channel);
    const model = typeof attempt.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/.test(attempt.model) ? attempt.model : null;
    const protocol = attempt.protocol === "responses" ? "responses" : attempt.protocol === "chat/completions" ? "chat/completions" : null;
    if (!requestedModel || !channel || !protocol) return;
    const usage = safeUsage(attempt.usage);
    const tariffSource = attempt.tariff ?? attempt.tariffs?.[`${channel}/${attempt.model}`];
    const rates = ratesInCny(tariffSource);
    const tariff = rates ? { currency: "CNY", ...rates, ...(Number.isFinite(tariffSource.fetchedAt) ? { fetchedAt: tariffSource.fetchedAt } : {}) } : null;
    const cost = estimateAttemptCost(usage, tariffSource);
    let id;
    try { id = safeName(attempt.requestId ?? (typeof requestId === "function" ? requestId() : requestId)); } catch { id = null; }
    const at = now();
    const row = { schema: 1, timestamp: Number.isSafeInteger(at) && at >= 0 ? at : Date.now(), requestId: id,
      attempt: Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0 ? Math.min(attempt.attempt, 1_000_000) : 1,
      protocol, requestedModel, channel, model, statusCode: Number.isSafeInteger(attempt.statusCode) && attempt.statusCode >= 100 && attempt.statusCode <= 599 ? attempt.statusCode : null,
      outcome: ["succeeded", "aborted"].includes(attempt.outcome) ? attempt.outcome : "failed", failureKind: failureKinds.has(attempt.failureKind) ? attempt.failureKind : null, usage, tariff, cost };
    try { appendFileSync(fd, `${JSON.stringify(row)}\n`); }
    catch {
      if (!writeWarning) {
        writeWarning = true;
        try { log("failover-router: cost ledger append failed"); } catch { /* do not fail an upstream result */ }
      }
    }
  }
  function close() { if (closed) return; closed = true; closeSync(fd); }
  return { path, record, close };
}
