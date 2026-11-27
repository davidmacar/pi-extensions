import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedPrices, PRICE_REFRESH_MS } from "./shared-prices.js";
import { orderByPrice, tariffFor } from "./price-cache.js";
import { fetchSubrouterOffers } from "./subrouter-prices.js";

const a = "subrouter-a/model";
const b = "subrouter-b/model";
const c = "subrouter-c/other";
const key = "sk-fixture-prices-secret";
const offer = (provider_slug, input_price, price_currency, extra = {}) => ({ provider_slug, model_name: "model", input_price, price_currency, ...extra });
const success = data => Response.json({ success: true, data });

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "shared-prices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("publishes one authenticated response per model; another consumer orders the same snapshot", async t => {
  const dir = setup(t);
  const calls = [];
  const reader = createSharedPrices({ dir, refs: [a, b], now: () => 100 });
  const writer = createSharedPrices({ dir, refs: [a], apiKey: key, now: () => 100,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return success([
        offer("a", 0.1, "USD", { output_price: 1, effective_cache_read_price: 0.01 }),
        offer("b", 0.5, "CNY", { output_price: 2, effective_cache_creation_price: 0.7 }),
      ]);
    },
  });
  t.after(() => { reader.stop(); writer.stop(); });
  const changed = Promise.withResolvers();
  reader.start(cache => { if (cache.prices[b]) changed.resolve(cache); });
  await writer.refresh();
  const timeout = setTimeout(() => changed.reject(new Error("reader did not observe publication")), 2000);
  const cache = await changed.promise.finally(() => clearTimeout(timeout));
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0][0]).origin, "https://subrouter.ai");
  assert.equal(new URL(calls[0][0]).searchParams.get("model"), "model");
  assert.equal(new Headers(calls[0][1].headers).get("authorization"), `Bearer ${key}`);
  assert.equal(calls[0][1].redirect, "error");
  assert.deepEqual(orderByPrice([{ model: a }, { model: b }], cache).map(step => step.model), [b, a]);
  assert.deepEqual(tariffFor(cache, a), { price_currency: "CNY", input_price: 0.68, output_price: 6.8, effective_cache_read_price: 0.068 });
  assert.deepEqual(tariffFor(cache, b), { price_currency: "CNY", input_price: 0.5, output_price: 2, effective_cache_creation_price: 0.7 });
  assert.ok(readdirSync(dir).every(file => !readFileSync(join(dir, file), "utf8").includes(key)));
});

test("fetches later pages with the same key rather than silently dropping a configured offer", async () => {
  const calls = [];
  const rows = await fetchSubrouterOffers("model", {
    apiKey: key,
    fetchImpl: async (url, options) => {
      const page = new URL(url).searchParams.get("page");
      calls.push([page, options.headers.authorization, options.redirect]);
      return Response.json({ success: true, total: 51, data: page === "1"
        ? Array.from({ length: 50 }, (_, i) => offer(`provider-${i}`, 1, "USD"))
        : [offer("a", 0.5, "CNY")] });
    },
  });
  assert.deepEqual(calls, [["1", `Bearer ${key}`, "error"], ["2", `Bearer ${key}`, "error"]]);
  assert.equal(rows.length, 51);
  assert.equal(rows.at(-1).provider_slug, "a");
});

test("the active feed refreshes automatically when the hourly timer fires", async t => {
  const dir = setup(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100 });
  let calls = 0;
  const refreshed = Promise.withResolvers();
  const feed = createSharedPrices({ dir, refs: [a], apiKey: key, fetchImpl: async () => success([offer("a", ++calls, "CNY")]) });
  t.after(() => feed.stop());
  await feed.start(cache => { if (cache.prices[a]?.input_price === 2) refreshed.resolve(); });
  t.mock.timers.tick(PRICE_REFRESH_MS);
  await refreshed.promise;
  assert.equal(calls, 2);
});

test("refreshes hourly, retains prior tariffs after failure, and does not clobber a different channel's update", async t => {
  const dir = setup(t);
  let clock = 100;
  let calls = 0;
  const logs = [];
  const opts = { dir, now: () => clock, apiKey: key, log: message => logs.push(message) };
  const writer = createSharedPrices({ ...opts, refs: [a], fetchImpl: async () => {
    ++calls;
    if (calls === 2) throw new Error(key);
    return success([offer("a", calls, "CNY")]);
  } });
  const other = createSharedPrices({ ...opts, refs: [c], fetchImpl: async () => success([offer("c", 9, "USD", { model_name: "other" })]) });
  t.after(() => { writer.stop(); other.stop(); });
  await Promise.all([writer.refresh(), other.refresh()]);
  await writer.refresh();
  assert.equal(calls, 1);
  clock += PRICE_REFRESH_MS;
  await writer.refresh();
  let view = createSharedPrices({ dir, refs: [a, c] });
  assert.equal(view.snapshot().prices[a].input_price, 1);
  assert.equal(view.snapshot().prices[c].input_price, 9);
  assert.ok(!logs.join("\n").includes(key));
  clock += PRICE_REFRESH_MS;
  await writer.refresh();
  view = createSharedPrices({ dir, refs: [a, c] });
  assert.equal(view.snapshot().prices[a].input_price, 3);
  assert.equal(view.snapshot().prices[c].input_price, 9);
});
