const MARKETPLACE_URL = "https://subrouter.ai/api/marketplace/models";
export const PRICE_FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const PRICE_FIELDS = ["input_price", "output_price", "effective_cache_read_price", "effective_cache_creation_price", "effective_cache_creation_price_1h"];

function modelId(ref) {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

function providerSlug(row) {
  return row.provider_slug ?? row.providerSlug;
}

/**
 * Fetch public marketplace rows for every configured physical model/channel.
 * `fetchImpl` is injected by tests; production callers must use the global fetch.
 * No credentials or conversion rates are involved.
 */
export async function fetchSubrouterPrices(refs, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log,
  timeoutMs = PRICE_FETCH_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
  const prices = {};
  const failures = [];
  await Promise.all([...new Set(refs ?? [])].map(async (ref) => {
    const model = modelId(ref);
    const url = `${MARKETPLACE_URL}?model=${encodeURIComponent(model)}&sort=price_asc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`price request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "error"}`);
      const envelope = await response.json();
      if (envelope?.success !== true || !Array.isArray(envelope.data)) {
        throw new Error("invalid marketplace response");
      }
      const rows = envelope.data.filter(row =>
        row && typeof row.model_name === "string" && modelId(ref) === row.model_name &&
        Number.isFinite(typeof row.input_price === "number" ? row.input_price :
          typeof row.input_price === "string" && row.input_price.trim() !== "" ? Number(row.input_price) : NaN) &&
        Number(row.input_price) >= 0 && typeof row.price_currency === "string" && row.price_currency.trim() !== "" &&
        typeof providerSlug(row) === "string" && providerSlug(row).trim() !== "",
      );
      const configuredProvider = ref.slice(0, ref.indexOf("/"));
      const providerNames = new Set([configuredProvider]);
      if (configuredProvider.startsWith("subrouter-")) providerNames.add(configuredProvider.slice("subrouter-".length));
      const matching = rows.filter(row => providerNames.has(providerSlug(row)));
      const row = matching[0];
      if (!row) throw new Error(`no marketplace row for ${ref}`);
      prices[ref] = {
        provider_slug: providerSlug(row),
        model_name: row.model_name ?? model,
        input_price: row.input_price,
        price_currency: row.price_currency,
        fetchedAt: now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ ref, message });
      log?.(`failover-router: price fetch failed for ${ref}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }));
  return { prices, failures };
}

/** Fetch every purchasable offer for a model using the user's SubRouter relay key. */
export async function fetchSubrouterOffers(model, {
  apiKey,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = PRICE_FETCH_TIMEOUT_MS,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("SubRouter API key is not configured");
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const rows = [];
  try {
    for (let page = 1; ; page++) {
      requestSignal.throwIfAborted();
      if (page > MAX_PAGES) throw new Error("SubRouter tariff pagination exceeded its limit");
      const url = `${MARKETPLACE_URL}?model=${encodeURIComponent(model)}&sort=price_asc&page=${page}&page_size=${PAGE_SIZE}`;
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: requestSignal,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
      if (!response?.ok) { void response?.body?.cancel?.().catch(() => {}); throw new Error("SubRouter tariff request failed"); }
      const envelope = await response.json();
      if (envelope?.success !== true || !Array.isArray(envelope.data)) throw new Error("SubRouter returned an invalid tariff response");
      const total = Number(envelope.total);
      for (const row of envelope.data) rows.push(row);
      if (Number.isSafeInteger(total) && total >= 0 && envelope.total != null) {
        if (rows.length >= total) break;
        if (!envelope.data.length) throw new Error("SubRouter returned an incomplete tariff response");
      } else if (envelope.data.length < PAGE_SIZE) break;
    }
    return rows.flatMap(row => {
      if (!row || row.model_name !== model) return [];
      const slug = providerSlug(row);
      if (typeof slug !== "string" || !slug.trim() || slug.includes(apiKey)) return [];
      if (row.is_per_call === true || (typeof row.is_per_call === "string" && row.is_per_call.toLowerCase() === "true")) return [];
      if (Number(row.fixed_price ?? 0) !== 0) return [];
      const currency = typeof row.price_currency === "string" ? row.price_currency.trim().toUpperCase() : "";
      if (!["CNY", "USD"].includes(currency)) return [];
      const input = typeof row.input_price === "number" ? row.input_price : typeof row.input_price === "string" && row.input_price.trim() ? Number(row.input_price) : NaN;
      if (!Number.isFinite(input) || input <= 0) return [];
      const prices = Object.fromEntries(PRICE_FIELDS.flatMap(field => {
        const value = row[field];
        if (value === undefined || value === null || value === "") return [];
        const price = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
        return Number.isFinite(price) && price > 0 ? [[field, price]] : [];
      }));
      if (prices.output_price === undefined && row.output_price !== undefined) return [];
      return [{ ...prices, provider_slug: slug, model_name: model, input_price: input, price_currency: currency }];
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("SubRouter tariff request timed out");
    if (error?.name === "AbortError") throw new Error("SubRouter tariff request cancelled");
    throw new Error("SubRouter tariff request failed");
  }
}

export { MARKETPLACE_URL };
