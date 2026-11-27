/** Durable SubRouter marketplace input-price cache. */

export const PRICE_CACHE_KIND = "pi-failover-router.price";
export const PRICE_CACHE_VERSION = 1;
/** SubRouter's established marketplace conversion for native USD offers. */
export const USD_TO_CNY = 6.8;
const ADDITIONAL_RATES = ["output_price", "effective_cache_read_price", "effective_cache_creation_price", "effective_cache_creation_price_1h"];

export function emptyPriceCache() {
  return { kind: PRICE_CACHE_KIND, version: PRICE_CACHE_VERSION, updatedAt: 0, prices: {} };
}

function validPrice(value) {
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const price = typeof value === "number" ? value : Number(value);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function validCurrency(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const input_price = validPrice(entry.input_price ?? entry.inputPrice);
  const price_currency = validCurrency(entry.price_currency ?? entry.priceCurrency);
  if (input_price === undefined || !price_currency) return undefined;
  return {
    provider_slug: typeof entry.provider_slug === "string" ? entry.provider_slug : undefined,
    model_name: typeof entry.model_name === "string" ? entry.model_name : undefined,
    input_price,
    price_currency,
    ...Object.fromEntries(ADDITIONAL_RATES.flatMap(name => {
      const price = validPrice(entry[name]);
      return price === undefined ? [] : [[name, price]];
    })),
    fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0,
  };
}

export function readPriceCache(path, { readFile } = {}) {
  if (!path || typeof readFile !== "function") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    return undefined;
  }
  if (!parsed || parsed.kind !== PRICE_CACHE_KIND || parsed.version !== PRICE_CACHE_VERSION) return undefined;
  const prices = {};
  for (const [ref, entry] of Object.entries(parsed.prices ?? {})) {
    const normalized = normalizeEntry(entry);
    if (normalized) prices[ref] = normalized;
  }
  return {
    kind: PRICE_CACHE_KIND,
    version: PRICE_CACHE_VERSION,
    updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
    prices,
  };
}

/** Remove prices for channels no longer present in the active router config. */
export function prunePriceCache(cache, refs) {
  const allowed = new Set(refs ?? []);
  const prices = {};
  for (const [ref, entry] of Object.entries(cache?.prices ?? {})) {
    if (allowed.has(ref)) prices[ref] = entry;
  }
  return {
    kind: PRICE_CACHE_KIND,
    version: PRICE_CACHE_VERSION,
    updatedAt: Number.isFinite(cache?.updatedAt) ? cache.updatedAt : 0,
    prices,
  };
}

/** Store successful rows while retaining prior prices for channels whose request failed. */
export function recordPrices(cache, entries, now = Date.now()) {
  const next = prunePriceCache(cache ?? emptyPriceCache(), Object.keys(cache?.prices ?? {}));
  for (const [ref, entry] of Object.entries(entries ?? {})) {
    const normalized = normalizeEntry(entry);
    if (normalized) next.prices[ref] = { ...normalized, fetchedAt: now };
  }
  next.updatedAt = now;
  return next;
}

export function priceFor(cache, ref) {
  const entry = cache?.prices?.[ref];
  if (!entry) return undefined;
  const input_price = validPrice(entry.input_price ?? entry.inputPrice);
  const currency = validCurrency(entry.price_currency ?? entry.priceCurrency)?.toUpperCase();
  if (input_price === undefined || !currency) return undefined;
  if (currency === "CNY") return { input_price, price_currency: "CNY" };
  if (currency === "USD") return { input_price: input_price * USD_TO_CNY, price_currency: "CNY" };
  return undefined;
}

/** Canonical SubRouter tariffs in CNY per million tokens; absent rates stay absent. */
export function tariffFor(cache, ref) {
  const entry = cache?.prices?.[ref];
  const input = priceFor(cache, ref);
  if (!input) return undefined;
  const factor = entry.price_currency.trim().toUpperCase() === "USD" ? USD_TO_CNY : 1;
  return { price_currency: "CNY", input_price: input.input_price,
    ...Object.fromEntries(ADDITIONAL_RATES.flatMap(name => {
      const price = validPrice(entry[name]);
      return price === undefined ? [] : [[name, price * factor]];
    })) };
}

/**
 * Orders a cost chain by input price normalized to CNY. SubRouter returns
 * provider-native prices; known USD offers use the platform's 6.8 conversion.
 */
export function orderByPrice(chain, cache) {
  const rows = chain.map((step, index) => ({ step, index, price: priceFor(cache, step.model) }));
  const priced = rows.filter(row => row.price);
  if (priced.length === 0) return chain;
  return [...rows].sort((a, b) => {
    if (a.price && !b.price) return -1;
    if (!a.price && b.price) return 1;
    if (a.price && b.price && a.price.input_price !== b.price.input_price) {
      return a.price.input_price - b.price.input_price;
    }
    return a.index - b.index;
  }).map(row => row.step);
}

export function priceSnapshot(cache, refs) {
  return (refs ?? []).map(ref => ({ ref, ...(priceFor(cache, ref) ?? { input_price: null, price_currency: null }) }));
}
