import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyPriceCache,
  orderByPrice,
  priceFor,
  priceSnapshot,
  prunePriceCache,
  USD_TO_CNY,
  recordPrices,
} from "../../common/price-cache.js";
import { fetchSubrouterPrices, MARKETPLACE_URL } from "../../common/subrouter-prices.js";

const refs = ["subrouter-expensive/gpt-6.2-sol", "subrouter-cheap/gpt-6.2-sol", "subrouter-tie/gpt-6.2-sol"];

function response(data) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

test("fetches the public marketplace endpoint per configured channel and keeps explicit currency", async () => {
  const calls = [];
  const result = await fetchSubrouterPrices(refs.slice(0, 2), {
    fetchImpl: async url => {
      calls.push(url);
      return response([
        { provider_slug: "subrouter-expensive", model_name: "gpt-6.2-sol", input_price: "0.20", price_currency: "USD" },
        { provider_slug: "subrouter-cheap", model_name: "gpt-6.2-sol", input_price: 0.05, price_currency: "EUR" },
      ]);
    },
    now: () => 123,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `${MARKETPLACE_URL}?model=gpt-6.2-sol&sort=price_asc`);
  assert.equal(result.prices[refs[0]].input_price, "0.20");
  assert.equal(result.prices[refs[0]].price_currency, "USD");
  assert.equal(result.prices[refs[1]].input_price, 0.05);
});

test("orders cost chains by lowest input price and keeps configured ties stable", () => {
  let cache = emptyPriceCache();
  cache = recordPrices(cache, {
    [refs[0]]: { input_price: 0.2, price_currency: "USD" },
    [refs[1]]: { input_price: 0.1, price_currency: "USD" },
    [refs[2]]: { input_price: 0.1, price_currency: "USD" },
  }, 123);
  assert.deepEqual(orderByPrice(refs.map(model => ({ model })), cache).map(step => step.model), [refs[1], refs[2], refs[0]]);
});

test("normalizes native USD prices to CNY before ordering and prunes obsolete channels", () => {
  let cache = recordPrices(emptyPriceCache(), {
    [refs[0]]: { input_price: 0.01, price_currency: "USD" },
    [refs[1]]: { input_price: 0.05, price_currency: "CNY" },
    "old/model": { input_price: 0, price_currency: "USD" },
  }, 123);
  cache = prunePriceCache(cache, refs.slice(0, 2));
  assert.equal(cache.prices["old/model"], undefined);
  assert.deepEqual(orderByPrice(refs.slice(0, 2).map(model => ({ model })), cache).map(step => step.model), [refs[1], refs[0]]);
  assert.deepEqual(priceFor(cache, refs[0]), { input_price: 0.01 * USD_TO_CNY, price_currency: "CNY" });
  assert.deepEqual(priceFor(cache, refs[1]), { input_price: 0.05, price_currency: "CNY" });
  assert.deepEqual(priceSnapshot(cache, refs.slice(0, 2)), [
    { ref: refs[0], input_price: 0.068, price_currency: "CNY" },
    { ref: refs[1], input_price: 0.05, price_currency: "CNY" },
  ]);
});

test("rejects marketplace rows with the wrong model or missing provider identity", async () => {
  const result = await fetchSubrouterPrices([refs[0]], {
    fetchImpl: async () => response([
      { provider_slug: "expensive", model_name: "other-model", input_price: 0, price_currency: "USD" },
      { model_name: "gpt-6.2-sol", input_price: 0, price_currency: "USD" },
    ]),
  });
  assert.deepEqual(result.prices, {});
  assert.deepEqual(result.failures.map(failure => failure.ref), [refs[0]]);
});

test("rejects unknown currencies instead of comparing them as CNY", () => {
  const cache = recordPrices(emptyPriceCache(), {
    [refs[0]]: { input_price: 0.01, price_currency: "EUR" },
  }, 123);
  assert.equal(priceFor(cache, refs[0]), undefined);
});

test("rejects null, empty and non-finite input prices instead of treating them as zero", () => {
  for (const input_price of [null, "", Infinity, NaN]) {
    const cache = recordPrices(emptyPriceCache(), {
      [refs[0]]: { input_price, price_currency: "USD" },
    }, 123);
    assert.equal(priceFor(cache, refs[0]), undefined);
  }
});

test("reports failed offline fetches without inventing a price", async () => {
  const result = await fetchSubrouterPrices([refs[0]], {
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(result.prices, {});
  assert.deepEqual(result.failures, [{ ref: refs[0], message: "offline" }]);
});

test("aborts a marketplace request that exceeds its timeout", async () => {
  let aborted = false;
  const result = await fetchSubrouterPrices([refs[0]], {
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  assert.equal(aborted, true);
  assert.deepEqual(result.prices, {});
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].ref, refs[0]);
});
