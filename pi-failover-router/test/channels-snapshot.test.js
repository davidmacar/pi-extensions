import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChannelsSnapshot, isChannelsSnapshot, CHANNELS_SNAPSHOT_SCHEMA, CHANNELS_SNAPSHOT_EVENT } from "../lib/channels-snapshot.js";
import { emptyCache, recordFailure, recordSample, tokensPerSecond } from "../lib/speed-cache.js";
import { orderBySpeed } from "../lib/speed-order.js";
import { emptyPriceCache, recordPrices } from "../lib/price-cache.js";

const SOL = "gpt-6.2-sol";
const DEEPSEEK = "deepseek-v4.1-flash-1017";
const ref = (channel, model) => `subrouter-${channel}/${model}`;

const virtuals = [
  { provider: "router", id: "sol-barato", chain: [{ model: ref("fxpayback", SOL) }, { model: ref("best", SOL) }] },
  { provider: "router", id: "sol-rapido", order: "speed", chain: [{ model: ref("fxpayback", SOL) }, { model: ref("best", SOL) }] },
  {
    provider: "router",
    id: "deepseek-rapido",
    order: "speed",
    chain: [
      { model: ref("znu", DEEPSEEK) },
      { model: ref("stableai", DEEPSEEK) },
      { model: ref("relai", DEEPSEEK) },
      { model: ref("lingai", DEEPSEEK) },
    ],
  },
  {
    provider: "router",
    id: "deepseek-barato",
    chain: [
      { model: ref("znu", DEEPSEEK) },
      { model: ref("stableai", DEEPSEEK) },
      { model: ref("relai", DEEPSEEK) },
      { model: ref("lingai", DEEPSEEK) },
    ],
  },
];

const build = (overrides = {}) =>
  buildChannelsSnapshot({
    virtuals,
    speedCache: emptyCache(),
    priceCache: emptyPriceCache(),
    cooldowns: new Map(),
    lastRouted: new Map(),
    now: 1_000_000,
    tokensPerSecond,
    orderBySpeed,
    ...overrides,
  });

test("the snapshot names its own schema so a consumer can validate it", () => {
  const snapshot = build();
  assert.equal(snapshot.schema, CHANNELS_SNAPSHOT_SCHEMA);
  assert.equal(CHANNELS_SNAPSHOT_SCHEMA, "gentle-pi.channels-sidebar/v2");
  assert.equal(CHANNELS_SNAPSHOT_EVENT, "gentle-pi:channels-sidebar/v2");
});

test("the snapshot distinguishes fast and cheap virtual models for each family", () => {
  const snapshot = build();
  assert.deepEqual(snapshot.models.map((model) => `${model.model}:${model.virtualId}:${model.order}`).sort(), [
    `${DEEPSEEK}:deepseek-barato:cost`,
    `${DEEPSEEK}:deepseek-rapido:speed`,
    `${SOL}:sol-barato:cost`,
    `${SOL}:sol-rapido:speed`,
  ]);
});

test("channels are ranked by the newest measured tokens per second, fastest first", () => {
  let cache = emptyCache();
  cache = recordSample(cache, ref("znu", DEEPSEEK), 2, 1_000);
  cache = recordSample(cache, ref("relai", DEEPSEEK), 7, 1_000);
  cache = recordSample(cache, ref("stableai", DEEPSEEK), 4, 1_000);
  const deepseek = build({ speedCache: cache }).models.find((model) => model.model === DEEPSEEK && model.order === "speed");
  assert.deepEqual(deepseek.channels.map((channel) => channel.channel), ["relai", "stableai", "znu"]);
  assert.deepEqual(deepseek.channels.map((channel) => channel.tokensPerSecond), [7, 4, 2]);
});

test("only the three fastest channels of a model survive, and the rest is counted", () => {
  let cache = emptyCache();
  for (const [channel, speed] of [["znu", 1], ["stableai", 2], ["relai", 3], ["lingai", 4]]) {
    cache = recordSample(cache, ref(channel, DEEPSEEK), speed, 1_000);
  }
  const deepseek = build({ speedCache: cache }).models.find((model) => model.model === DEEPSEEK && model.order === "speed");
  assert.deepEqual(deepseek.channels.map((channel) => channel.channel), ["lingai", "relai", "stableai"]);
  assert.equal(deepseek.total, 4);
  assert.equal(deepseek.hidden, 1);
});

test("an unmeasured channel keeps its configured position instead of disappearing", () => {
  let cache = emptyCache();
  cache = recordSample(cache, ref("relai", DEEPSEEK), 9, 1_000);
  const deepseek = build({ speedCache: cache }).models.find((model) => model.model === DEEPSEEK && model.order === "speed");
  assert.deepEqual(deepseek.channels.map((channel) => channel.channel), ["relai", "znu", "stableai"]);
  assert.equal(deepseek.channels[1].state, "unmeasured");
  assert.equal(deepseek.channels[1].tokensPerSecond, null);
});

test("cheap virtuals show the three lowest cached prices and their selected channel", () => {
  const priceCache = recordPrices(emptyPriceCache(), {
    [ref("znu", DEEPSEEK)]: { input_price: 0.09, price_currency: "USD" },
    [ref("stableai", DEEPSEEK)]: { input_price: 0.03, price_currency: "USD" },
    [ref("relai", DEEPSEEK)]: { input_price: 0.07, price_currency: "USD" },
    [ref("lingai", DEEPSEEK)]: { input_price: 0.01, price_currency: "USD" },
  }, 2_000);
  const snapshot = build({
    priceCache,
    lastRouted: new Map([["router/deepseek-barato", ref("relai", DEEPSEEK)]]),
  });
  const cheap = snapshot.models.find((model) => model.virtualId === "deepseek-barato");
  assert.deepEqual(cheap.channels.map((channel) => channel.channel), ["lingai", "stableai", "relai"]);
  assert.deepEqual(cheap.channels.map((channel) => channel.price.input_price), [0.01 * 6.8, 0.03 * 6.8, 0.07 * 6.8]);
  assert.deepEqual(cheap.channels.map((channel) => channel.price.price_currency), ["CNY", "CNY", "CNY"]);
  assert.equal(cheap.active, "relai");
  assert.equal(cheap.channels.find((channel) => channel.channel === "relai").state, "active");
  assert.equal(cheap.hidden, 1);
});

test("the chosen channel is the one the router routed last, and it is what the card marks", () => {
  const snapshot = build({ lastRouted: new Map([["router/sol-rapido", ref("best", SOL)]]) });
  const sol = snapshot.models.find((model) => model.model === SOL && model.order === "speed");
  assert.equal(sol.active, "best");
  assert.equal(sol.channels.find((channel) => channel.channel === "best").state, "active");
  assert.equal(sol.channels.find((channel) => channel.channel === "fxpayback").state, "unmeasured");
});

test("without a routed channel the chosen one is the fastest that is not cooling down", () => {
  let cache = emptyCache();
  cache = recordSample(cache, ref("znu", DEEPSEEK), 9, 1_000);
  cache = recordSample(cache, ref("stableai", DEEPSEEK), 5, 1_000);
  const cooldowns = new Map([[ref("znu", DEEPSEEK), 1_000_000 + 240_000]]);
  const deepseek = build({ speedCache: cache, cooldowns }).models.find((model) => model.model === DEEPSEEK);
  assert.equal(deepseek.active, "stableai");
});

test("a cooling channel reports its remaining time and is never the chosen one", () => {
  const cooldowns = new Map([[ref("znu", DEEPSEEK), 1_000_000 + 240_000]]);
  const deepseek = build({ cooldowns }).models.find((model) => model.model === DEEPSEEK);
  const znu = deepseek.channels.find((channel) => channel.channel === "znu");
  assert.equal(znu.state, "cooldown");
  assert.equal(znu.cooldownMs, 240_000);
  assert.equal(deepseek.active, "stableai");
});

test("a channel whose last measurement failed is reported as failing, not as never measured", () => {
  let cache = emptyCache();
  cache = recordFailure(cache, ref("relai", DEEPSEEK), "probe timed out after 45000 ms", 1_000);
  const deepseek = build({ speedCache: cache }).models.find((model) => model.model === DEEPSEEK);
  const relai = deepseek.channels.find((channel) => channel.channel === "relai");
  assert.equal(relai.state, "failed");
  assert.match(relai.note, /timed out/);
});

test("the card carries the last measurement instant, and null before the first one", () => {
  assert.equal(build().measuredAt, null);
  const cache = recordSample(emptyCache(), ref("znu", DEEPSEEK), 3, 1_234);
  assert.equal(build({ speedCache: cache }).measuredAt, 1_234);
});

test("a channel id is shortened to the name a rail column can show", () => {
  const deepseek = build().models.find((model) => model.model === DEEPSEEK);
  assert.equal(deepseek.channels[0].channel, "znu");
  assert.equal(deepseek.channels[0].ref, ref("znu", DEEPSEEK));
});

test("an empty chain list produces an empty snapshot instead of throwing", () => {
  assert.deepEqual(build({ virtuals: [] }).models, []);
});

test("the published snapshot validates, so a consumer can paint it without trusting it", () => {
  let cache = emptyCache();
  cache = recordSample(cache, ref("znu", DEEPSEEK), 3, 1_000);
  assert.equal(isChannelsSnapshot(build({ speedCache: cache })), true);
});

test("a foreign or unbounded payload is refused instead of painted", () => {
  const snapshot = build();
  assert.equal(isChannelsSnapshot({ ...snapshot, schema: "other/v1" }), false);
  assert.equal(isChannelsSnapshot(null), false);
  const [model] = snapshot.models;
  assert.equal(
    isChannelsSnapshot({ ...snapshot, models: [{ ...model, channels: [...model.channels, ...model.channels, model.channels[0]] }] }),
    false,
  );
});
