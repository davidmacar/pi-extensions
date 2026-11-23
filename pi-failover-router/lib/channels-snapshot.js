/**
 * The channel snapshot Gentle Shell paints in its Channels card.
 *
 * The router is the only component that knows how fast a channel is, which one
 * a model would use right now, and which ones are sitting out a cooldown. It
 * publishes that as one small, validated, read-only object; the shell never
 * reads this extension's files and never decides anything itself. Keeping the
 * builder pure is what lets the card's content be tested without a terminal, a
 * provider or a live session.
 */

import { orderBySpeed } from "./speed-order.js";
import { tokensPerSecond } from "./speed-cache.js";
import { orderByPrice, priceFor } from "./price-cache.js";

/** The shape a consumer validates before painting it. */
export const CHANNELS_SNAPSHOT_SCHEMA = "gentle-pi.channels-sidebar/v2";
/**
 * Event channel Gentle Shell listens on. The consumer lives in the installed
 * gentle-ai package; this module only names the contract.
 */
export const CHANNELS_SNAPSHOT_EVENT = "gentle-pi:channels-sidebar/v2";

/** Shared contract limit: each card section shows three channels. */
export const CHANNELS_SHOWN = 3;

const providerOf = (ref) => ref.slice(0, Math.max(0, ref.indexOf("/")));
const modelOf = (ref) => ref.slice(ref.indexOf("/") + 1);

/**
 * A channel name the rail can show in a narrow column: the provider without the
 * `subrouter-` prefix these catalogs share, so `subrouter-fxpayback` reads as
 * `fxpayback` and the tokens per second keep their room.
 */
function channelName(ref) {
  const provider = providerOf(ref);
  return provider.startsWith("subrouter-") ? provider.slice("subrouter-".length) : provider;
}

/** The last recorded attempt, or undefined when the channel was never probed. */
function lastAttempt(entry) {
  return Array.isArray(entry?.attempts) && entry.attempts.length > 0 ? entry.attempts[entry.attempts.length - 1] : undefined;
}

/**
 * One virtual model section, its channels ranked by the route's order, and
 * which channel is chosen. Fast and cheap virtuals are intentionally separate.
 */
function describeModel({ model, virtualId, order, refs, speedCache, priceCache, cooldowns, now, activeRef, top, speedOf, rank }) {
  const steps = refs.map((ref) => ({ model: ref }));
  const ranked = order === "speed"
    ? rank(steps, speedCache, speedOf).map((step) => step.model)
    : orderByPrice(steps, priceCache).map((step) => step.model);
  const described = ranked.map((ref) => {
    const entry = speedCache?.channels?.[ref];
    const speed = tokensPerSecond(speedCache, ref);
    const attempt = lastAttempt(entry);
    const until = cooldowns.get(ref);
    const cooling = typeof until === "number" && until > now;
    // `active` is decided below, once the chosen channel is known: a channel
    // that is cooling down or whose probe fails says so even if it was routed last.
    const state = cooling
      ? "cooldown"
      : attempt && attempt.ok === false
        ? "failed"
        : typeof speed === "number"
          ? "ready"
          : "unmeasured";
    return {
      ref,
      channel: channelName(ref),
      state,
      tokensPerSecond: typeof speed === "number" ? speed : null,
      measuredAt: typeof entry?.measuredAt === "number" ? entry.measuredAt : null,
      ...(order === "cost" ? { price: priceFor(priceCache, ref) ?? null } : {}),
      ...(cooling ? { cooldownMs: until - now } : {}),
      ...(state === "failed" && typeof attempt?.message === "string" ? { note: attempt.message } : {}),
    };
  });
  // The routed channel keeps the card honest only while it is usable; otherwise
  // the chosen one is the fastest available, and a chain where everything is
  // cooling or failing still names its first candidate.
  const usable = (channel) => channel.state !== "cooldown" && channel.state !== "failed";
  const routed = described.find((channel) => channel.ref === activeRef && usable(channel));
  const chosen = routed ?? described.find(usable) ?? described[0];
  if (chosen && usable(chosen)) chosen.state = "active";
  // Keep failed probes visible in the card even though speed routing places them
  // last; otherwise the fastest-three slice can hide the diagnostic state.
  const shown = described.slice(0, top);
  for (const failed of described.filter((channel) => channel.state === "failed")) {
    if (shown.includes(failed)) continue;
    if (shown.length < top) shown.push(failed);
    else if (top > 0) shown[shown.length - 1] = failed;
  }
  return {
    model,
    virtualId,
    order,
    active: chosen ? chosen.channel : null,
    total: described.length,
    hidden: Math.max(0, described.length - shown.length),
    channels: shown,
  };
}

/**
 * Builds the snapshot the Channels card paints.
 *
 * @param {object} input
 * @param {Array<{provider: string, id: string, chain: Array<{model: string}>}>} input.virtuals
 * @param {object} input.speedCache
 * @param {object} input.priceCache
 * @param {Map<string, number>} input.cooldowns channel ref -> epoch ms it becomes usable
 * @param {Map<string, string>} input.lastRouted virtual key -> channel ref routed last
 * @param {number} input.now
 * @param {number} [input.top]
 * @param {Function} [input.tokensPerSecond] injected for tests
 * @param {Function} [input.orderBySpeed] injected for tests
 */
export function buildChannelsSnapshot({
  virtuals,
  speedCache,
  priceCache,
  cooldowns = new Map(),
  lastRouted = new Map(),
  now,
  top = CHANNELS_SHOWN,
  tokensPerSecond: speedOf = tokensPerSecond,
  orderBySpeed: rank = orderBySpeed,
}) {
  // Family order follows the configuration, so the card is stable between
  // measurements instead of reshuffling by whichever probe finished last.
  const families = new Map();
  for (const def of virtuals) {
    const key = `${def.provider}/${def.id}`;
    const grouped = new Map();
    for (const step of def.chain) {
      const model = modelOf(step.model);
      const family = grouped.get(model) ?? { model, virtualId: def.id, virtualKey: key, order: def.order === "speed" ? "speed" : "cost", refs: [] };
      if (!family.refs.includes(step.model)) family.refs.push(step.model);
      grouped.set(model, family);
    }
    for (const [model, family] of grouped) families.set(`${key}:${model}`, family);
  }

  const models = [];
  for (const family of families.values()) {
    // Only a real route is handed over; which channel falls back to being
    // chosen depends on cooldowns, and that decision belongs to describeModel.
    const routed = lastRouted.get(family.virtualKey);
    const activeRef = routed && family.refs.includes(routed) ? routed : undefined;
    models.push(
      describeModel({
        model: family.model,
        virtualId: family.virtualId,
        order: family.order,
        refs: family.refs,
        speedCache,
        priceCache,
        cooldowns,
        now,
        speedOf,
        rank,
        activeRef,
        top,
      }),
    );
  }

  const measuredAt = models
    .flatMap((model) => model.channels.map((channel) => channel.measuredAt))
    .filter((at) => typeof at === "number")
    .reduce((newest, at) => (newest === null || at > newest ? at : newest), null);

  return { schema: CHANNELS_SNAPSHOT_SCHEMA, measuredAt, models };
}

/**
 * True when the payload is a snapshot this consumer may paint: bounded, typed,
 * and free of the properties a rail row would have to trust blindly.
 */
export function isChannelsSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schema !== CHANNELS_SNAPSHOT_SCHEMA) return false;
  if (!Array.isArray(value.models) || value.models.length > 16) return false;
  return value.models.every((model) => {
    if (!model || typeof model !== "object") return false;
    if (typeof model.model !== "string" || model.model.length === 0) return false;
    if (typeof model.virtualId !== "string" || !["speed", "cost"].includes(model.order)) return false;
    if (!Array.isArray(model.channels) || model.channels.length === 0 || model.channels.length > CHANNELS_SHOWN) return false;
    return model.channels.every(
      (channel) =>
        channel &&
        typeof channel === "object" &&
        typeof channel.channel === "string" &&
        channel.channel.length > 0 &&
        (channel.tokensPerSecond === null || typeof channel.tokensPerSecond === "number") &&
        (channel.price === undefined || channel.price === null ||
          (typeof channel.price.input_price === "number" && typeof channel.price.price_currency === "string")) &&
        ["active", "ready", "cooldown", "failed", "unmeasured"].includes(channel.state),
    );
  });
}
