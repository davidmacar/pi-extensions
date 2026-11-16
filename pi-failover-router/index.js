/**
 * Failover router: a Pi extension that registers virtual models whose physical
 * target changes when a request fails for a reason another channel could fix.
 *
 * Why it exists: Pi classifies terminal error into categories and only lets
 * quota/auth/rate_limit/provider_unavailable/timeout/network move a fallback
 * chain. Real channel defects land outside that set — a channel that rejects
 * tool calls answers 400 "invalid_request_error", and a cut stream reports
 * `499 ... response body closed`, which matches no keyword at all. Both stop the
 * run with no failover. This router reads the raw message and rotates anyway,
 * while refusing to rotate request-shaped failures that every model would share.
 *
 * A chain is either cost ordered (the configured order) or speed ordered (the
 * fastest measured channel first). Speed is measured once per session start and
 * refreshed every 15 minutes while a session is active; consecutive sessions
 * share the measurement through a cache file.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { classifyFailure, cooldownMs, nextCandidate } from "./lib/classify.js";
import { ConfigError, loadRouterConfig } from "./lib/config.js";
import {
  dueRefs,
  emptyCache,
  readSpeedCache,
  recordFailure,
  recordSample,
  startingTier,
  tokensPerSecond,
} from "./lib/speed-cache.js";
import { orderBySpeed } from "./lib/speed-order.js";
import { probeChannels } from "./lib/speed-probe.js";
import { lastAssistantMessage, resolveDeadEnd } from "./lib/dead-end.js";

export const DEFAULT_CONFIG_FILE = "failover-router.json";
export const DEFAULT_SPEED_FILE = "failover-router-speed.json";
/** How often an active session refreshes its measurements. */
export const SPEED_REFRESH_MS = 15 * 60_000;
/** How many times one virtual may force a continuation for unretryable failures. */
export const MAX_FORCED_CONTINUATIONS = 3;
/**
 * How long a request may wait for the measurement session before routing with
 * whatever measurements already exist. A probe must never turn into a hang.
 */
export const MEASURE_WAIT_MS = 8_000;

/** @param {string} path */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * A chain step may pin its own thinking level; when it does not, the level the
 * caller selected carries through unchanged, so a profile can choose `max` for
 * one role and `high` for another over the same channel chain.
 *
 * @param {object} model
 * @param {string|undefined} thinkingLevel
 */
function withLevel(model, thinkingLevel) {
  return thinkingLevel ? { model, thinkingLevel } : { model };
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function failoverRouter(pi) {
  const configPath = resolve(expandHome(process.env.PI_FAILOVER_ROUTER_CONFIG || join("~/.pi/agent", DEFAULT_CONFIG_FILE)));
  const speedPath = resolve(
    expandHome(process.env.PI_FAILOVER_ROUTER_SPEED_CACHE || join("~/.pi/agent", DEFAULT_SPEED_FILE)),
  );

  /** model id -> epoch ms until which it is skipped */
  const cooldowns = new Map();
  /** `${provider}/${id}` -> last routed model, so a retry knows what failed */
  const lastRouted = new Map();
  /** Latest measurements, shared by every virtual that orders by speed. */
  let speedCache = emptyCache();
  /** The measurement session in flight, if any. */
  let measurement = null;
  /**
   * `${provider}/${id}` -> channel to use on the next request, set when a failure
   * Pi refuses to retry ends the run. Cleared as soon as it is used.
   */
  const forcedNext = new Map();
  /** Forced continuations this session, so a dead end can never loop forever. */
  let forcedCount = 0;

  let virtuals = [];
  try {
    virtuals = loadRouterConfig(configPath);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error?.message ?? error);
    pi.log?.(`failover-router: config not loaded: ${message}`);
    return;
  }
  if (virtuals.length === 0) return;

  speedCache = readSpeedCache(speedPath, { readFile: readFileSync }) ?? emptyCache();

  /**
   * Orders one chain for this request. `speed` chains put measured channels first,
   * fastest winning; a chain with no measurement at all keeps its configured order.
   */
  const chainFor = (def) =>
    def.order === "speed" ? orderBySpeed(def.chain, speedCache, tokensPerSecond) : def.chain;

  /** Pure decision for one request; returns synchronously. */
  const decideRoute = (def, key, request, ctx) => {
    const find = (ref) => {
      const slash = ref.indexOf("/");
      return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    };

    // `retry` means Pi already tried and failed. This is the only moment we
    // know which physical model broke, and the only moment worth rotating.
    if (request.reason === "retry" && request.failed) {
      const failedModel = `${request.failed.model?.provider}/${request.failed.model?.id}`;
      const errorMessage = request.failed.message?.errorMessage;
      const verdict = classifyFailure(errorMessage);
      pi.log?.(
        `failover-router: ${key} retry after ${failedModel} — ${verdict.kind}: ${verdict.reason}` +
          (verdict.rotate ? "" : " (not rotating)"),
      );
      if (verdict.rotate) {
        const now = Date.now();
        cooldowns.set(failedModel, now + cooldownMs(verdict.kind));
        const next = nextCandidate({ chain: chainFor(def), failedModel, cooldowns, now });
        if (next) {
          const model = find(next.model);
          if (model) {
            lastRouted.set(key, next.model);
            return withLevel(model, next.thinkingLevel ?? request.thinkingLevel);
          }
          pi.log?.(`failover-router: ${next.model} is not in the catalog; falling through`);
        } else {
          pi.log?.(`failover-router: ${key} chain exhausted`);
        }
      }
      // Not rotating, or nowhere to go: keep the model that failed so the
      // human sees the real error rather than a silently different channel.
      const same = request.failed.model;
      if (same) return { model: same, thinkingLevel: request.failed.thinkingLevel };
    }

    // A dead end that Pi would not retry leaves a channel to use next. It wins
    // over the sticky model, which is the channel that just failed.
    const forced = forcedNext.get(key);
    if (forced) {
      forcedNext.delete(key);
      const model = find(forced.model);
      if (model) {
        lastRouted.set(key, forced.model);
        pi.log?.(`failover-router: ${key} continuing on ${forced.model} after an unretryable failure`);
        return withLevel(model, forced.thinkingLevel ?? request.thinkingLevel);
      }
      pi.log?.(`failover-router: ${forced.model} is not in the catalog; ignoring the rotation`);
    }

    // Everything else sticks to the model that last answered successfully,
    // which keeps the prompt cache warm across tool follow-ups.
    const sticky = request.previous?.model ?? (lastRouted.get(key) ? find(lastRouted.get(key)) : undefined);
    if (request.reason !== "user" && sticky) {
      return withLevel(sticky, request.previous?.thinkingLevel ?? request.thinkingLevel);
    }

    const ordered = chainFor(def);
    const first = find(ordered[0].model);
    if (!first) return undefined; // let Pi report the broken config
    lastRouted.set(key, ordered[0].model);
    return withLevel(first, ordered[0].thinkingLevel ?? request.thinkingLevel);
  };

  for (const def of virtuals) {
    const key = `${def.provider}/${def.id}`;

    pi.registerVirtualModel({
      provider: def.provider,
      id: def.id,
      name: def.name,
      thinkingLevels: def.thinkingLevels,
      description: def.description,
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
      input: def.input,
      route(request, ctx) {
        // The measurement session starts with the session and runs before the
        // first request. Waiting for it here is what makes that first request
        // already use measured throughput — but only up to a budget, because a
        // slow channel must never turn into a hung request.
        if (!measurement) return decideRoute(def, key, request, ctx);
        const inFlight = measurement;
        const ready = Promise.race([
          inFlight.then(
            () => true,
            () => true,
          ),
          new Promise((done) => {
            const timer = setTimeout(() => done(false), MEASURE_WAIT_MS);
            timer.unref?.();
          }),
        ]);
        return ready.then((settled) => {
          if (!settled) {
            pi.log?.(`failover-router: ${key} routing without waiting further for measurements`);
          }
          return decideRoute(def, key, request, ctx);
        });
      },
    });

    pi.log?.(`failover-router: registered ${key} (${def.chain.length} candidates)`);
  }

  // ---- failures Pi refuses to retry -------------------------------------------
  // Pi ends the run without a retry when `isRetryableAssistantError` does not
  // recognise the message, so `route()` is never asked with `reason: "retry"`.
  // Those failures are exactly the ones this extension exists for, so take them
  // over here: pick the next channel on `agent_end`, then ask the boundary for one
  // more provider request. The timeout is short because it only schedules work.
  pi.on?.("agent_end", (event, ctx) => {
    const failure = resolveDeadEnd(lastAssistantMessage(event?.messages));
    if (!failure || !failure.rotate) return;
    const failedModel = `${failure.provider}/${failure.id}`;

    // One failure decides one virtual: the one this session selected. Rotating
    // every virtual that happens to contain the channel would spend the budget
    // twice and log a decision that nobody uses.
    const selected = ctx?.model;
    const selectedKey = selected?.provider && selected?.id ? `${selected.provider}/${selected.id}` : undefined;
    const target = selectedKey
      ? virtuals.find((def) => `${def.provider}/${def.id}` === selectedKey)
      : virtuals.find((def) => def.chain.some((step) => step.model === failedModel));
    if (!target) return;
    const key = `${target.provider}/${target.id}`;

    const ordered = chainFor(target);
    if (!ordered.some((step) => step.model === failedModel)) return;
    if (forcedCount >= MAX_FORCED_CONTINUATIONS) {
      pi.log?.(`failover-router: ${key} already forced ${forcedCount} continuations; letting the failure stand`);
      return;
    }

    const now = Date.now();
    cooldowns.set(failedModel, now + cooldownMs(failure.kind));
    const next = nextCandidate({ chain: ordered, failedModel, cooldowns, now });
    if (!next) {
      pi.log?.(`failover-router: ${key} chain exhausted after ${failedModel}`);
      return;
    }
    forcedNext.set(key, next);
    forcedCount += 1;
    pi.log?.(
      `failover-router: ${key} taking over ${failedModel} — ${failure.kind}: ${failure.reason}; next ${next.model}`,
    );
  });

  pi.on?.("agent_before_settle", (event) => {
    if (forcedNext.size === 0) return undefined;
    if (!event?.context?.canContinue) {
      // The boundary refuses a bare continuation after an error; the marker keeps
      // the decision visible and the next user message still benefits from the
      // rotation, because route() consumes it.
      pi.log?.("failover-router: rotation recorded; Pi will not continue automatically");
      return undefined;
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: "failover-router.continue",
          content: "Retrying on another channel after a channel-owned failure.",
          display: false,
        },
      ],
      continue: true,
    };
  });

  pi.on?.("session_start", () => {
    // A new or reloaded session starts a fresh continuation budget.
    forcedCount = 0;
    forcedNext.clear();
  });

  // ---- throughput measurement -------------------------------------------------
  const refs = [
    ...new Set(virtuals.filter((def) => def.order === "speed").flatMap((def) => def.chain.map((s) => s.model))),
  ];
  if (refs.length === 0) return;

  let refreshTimer = undefined;

  const persist = () => {
    try {
      const temporary = `${speedPath}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(speedCache, null, 2)}\n`);
      renameSync(temporary, speedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pi.log?.(`failover-router: could not persist speed measurements: ${message}`);
    }
  };

  const runProbe = (ctx, pending) => {
    if (measurement) return measurement;
    const registry = ctx?.modelRegistry;
    if (!registry || typeof registry.complete !== "function") return undefined;
    if (pending.length === 0) return undefined;
    const find = (ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 ? registry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
    };
    measurement = probeChannels({
      refs: pending,
      find,
      complete: registry.complete.bind(registry),
      log: pi.log,
      startingTierFor: (ref) => startingTier(speedCache, ref),
    })
      .then(({ measured, failed }) => {
        const now = Date.now();
        for (const { ref, tokensPerSecond: speed, timeoutTierMs } of measured) {
          speedCache = recordSample(speedCache, ref, speed, now, timeoutTierMs);
        }
        for (const { ref, message } of failed) {
          // Kept in the cache so the channel is retried next time and the log has
          // a durable record; without it a permanently failing channel vanishes.
          speedCache = recordFailure(speedCache, ref, message, now);
        }
        if (measured.length > 0 || failed.length > 0) persist();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        pi.log?.(`failover-router: speed measurement failed: ${message}`);
      })
      .finally(() => {
        measurement = null;
      });
    return measurement;
  };

  const measureIfDue = (ctx) => {
    // Only the channels that are stale, never measured, or last failed.
    const pending = dueRefs(speedCache, refs, Date.now());
    if (pending.length === 0) return;
    void runProbe(ctx, pending);
  };

  pi.on?.("session_start", (_event, ctx) => {
    measureIfDue(ctx);
    // While a session stays active, refresh on the same window. A session that
    // ends clears the timer, so an idle install never probes.
    if (refreshTimer === undefined) {
      refreshTimer = setInterval(() => measureIfDue(ctx), SPEED_REFRESH_MS);
      refreshTimer.unref?.();
    }
  });

  pi.on?.("session_shutdown", () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
