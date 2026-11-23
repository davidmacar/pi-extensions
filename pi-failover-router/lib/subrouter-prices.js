const MARKETPLACE_URL = "https://subrouter.ai/api/marketplace/models";
export const PRICE_FETCH_TIMEOUT_MS = 10_000;

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

export { MARKETPLACE_URL };
