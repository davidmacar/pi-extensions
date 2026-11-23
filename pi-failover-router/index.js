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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFailure, cooldownMs } from "./lib/classify.js";
import { createDecisionLog } from "./lib/decision-log.js";
import { buildChannelsSnapshot, CHANNELS_SNAPSHOT_EVENT } from "./lib/channels-snapshot.js";
import { decidePatchAction } from "./lib/patch-guard.js";
import {
  newRecovery,
  planRecovery,
  dispatchRecovery,
  waitForCooldown,
  newPhysicalRecovery,
  planPhysicalRecovery,
  physicalWaitMs,
  MAX_PHYSICAL_ATTEMPTS,
} from "./lib/recovery.js";
import { buildStamp } from "./lib/build-stamp.js";
import { retryableErrorText } from "./lib/retry-bridge.js";
import { DEFAULT_LEVELS, isAdmissible, resolveLevel } from "./lib/thinking-level.js";
import { ConfigError, loadRouterConfig } from "./lib/config.js";
import {
  dueRefs,
  emptyCache,
  pruneCache,
  readSpeedCache,
  recordFailure,
  recordSample,
  startingTier,
  tokensPerSecond,
} from "./lib/speed-cache.js";
import { orderBySpeed } from "./lib/speed-order.js";
import { probeChannels } from "./lib/speed-probe.js";
import { lastAssistantMessage, resolveDeadEnd } from "./lib/dead-end.js";
import { emptyPriceCache, orderByPrice, priceSnapshot, prunePriceCache, readPriceCache, recordPrices } from "./lib/price-cache.js";
import { fetchSubrouterPrices } from "./lib/subrouter-prices.js";

export const DEFAULT_CONFIG_FILE = "failover-router.json";
export const DEFAULT_SPEED_FILE = "failover-router-speed.json";
export const DEFAULT_PRICE_FILE = "failover-router-price.json";
/** How often an active session refreshes its measurements. */
export const SPEED_REFRESH_MS = 15 * 60_000;
/** How often an active Pi session refreshes marketplace prices. */
export const PRICE_REFRESH_MS = 60 * 60_000;
export const PRICES_EVENT = "failover-router:prices";
/**
 * How long a request may wait for the measurement session before routing with
 * whatever measurements already exist. A probe must never turn into a hang.
 */
export const MEASURE_WAIT_MS = 8_000;
/**
 * Repair script for the Gentle Shell Channels card. The card cannot be an
 * extension (the shell renders a closed section list), so it lives inside the
 * installed `gentle-pi` package and a package update removes it. Pi documents no
 * integrity check for installed packages, so the card re-installs itself here.
 */
export const PATCH_GUARD_SCRIPT = fileURLToPath(new URL("../patches/gentle-pi-channels/apply.mjs", import.meta.url));

/**
 * Counts one more consecutive failure for a channel.
 * @param {Map<string, number>} streaks
 * @param {string} model
 */
export function noteFailure(streaks, model) {
  const streak = streaks.get(model) ?? 0;
  streaks.set(model, streak + 1);
  return streak;
}

/** Clears a channel's failure history, because it just answered correctly. */
export function noteSuccess(streaks, model) {
  streaks.delete(model);
}

/** @param {string} path */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * A chain step may pin its own thinking level; when it does not, the level the
 * caller selected carries through, so a profile can choose `max` for one role
 * and `high` for another over the same channel chain.
 *
 * Whatever the caller asked for, only a level the resolved model accepts is
 * sent: `off` and `minimal` are refused with a 400 by these channels, and a
 * level the catalog marks `null` is equally unsupported. Nothing is sent when
 * the model supports no admissible level at all.
 *
 * @param {object} model
 * @param {string|undefined} thinkingLevel
 */
function withLevel(model, thinkingLevel) {
  const level = resolveLevel(model, thinkingLevel);
  return level ? { model, thinkingLevel: level } : { model };
}

/**
 * @param {string[]|undefined} configured
 * @returns {string[]}
 */
function offeredLevels(configured) {
  const admissible = (configured ?? []).filter(isAdmissible);
  return admissible.length > 0 ? admissible : [...DEFAULT_LEVELS];
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function failoverRouter(pi) {
  const configPath = resolve(expandHome(process.env.PI_FAILOVER_ROUTER_CONFIG || join("~/.pi/agent", DEFAULT_CONFIG_FILE)));
  const speedPath = resolve(
    expandHome(process.env.PI_FAILOVER_ROUTER_SPEED_CACHE || join("~/.pi/agent", DEFAULT_SPEED_FILE)),
  );
  const pricePath = resolve(
    expandHome(process.env.PI_FAILOVER_ROUTER_PRICE_CACHE || join("~/.pi/agent", DEFAULT_PRICE_FILE)),
  );

  /** model id -> epoch ms until which it is skipped */
  const cooldowns = new Map();
  /** `${provider}/${id}` -> last routed model, so a retry knows what failed */
  const lastRouted = new Map();
  /** Latest measurements, shared by every virtual that orders by speed. */
  let speedCache = emptyCache();
  /** Latest public marketplace prices, shared by cost-ordered virtuals. */
  let priceCache = emptyPriceCache();
  /** The measurement session in flight, if any. */
  let measurement = null;
  /** The price refresh in flight, if any. */
  let priceRefresh = null;
  const recovery = new Map();
  const physicalRecovery = new Map();
  const physicalWaits = new Map();
  const resetRecovery = new Set();
  // Timers/controllers are deliberately kept out of Pi's JSON route state.
  const recoveryWaits = new Map();
  let dispatchSerial = 0;
  const abortError = () => new DOMException("Channel recovery cancelled", "AbortError");
  const stopRecovery = (key) => {
    const state = recovery.get(key);
    if (state) {
      state.pending = null;
      state.stopped = true;
    }
    recoveryWaits.get(key)?.controller.abort();
  };
  const clearRecovery = (key) => {
    stopRecovery(key);
    recovery.delete(key);
    resetRecovery.add(key);
  };
  const clearPhysicalRecovery = (key) => {
    physicalRecovery.delete(key);
    const waiting = physicalWaits.get(key);
    waiting?.controller.abort();
    physicalWaits.delete(key);
  };
  // Share the dispatch, not callers' cancellation: each observer owns its
  // signal. Cancel the episode's timer only when nobody is waiting anymore.
  const observeRecoveryWait = (key, waiting, signal) => new Promise((resolve, reject) => {
    const observer = {};
    waiting.observers.add(observer);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      waiting.observers.delete(observer);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      finish(abortError());
      if (waiting.observers.size === 0 && recoveryWaits.get(key) === waiting) stopRecovery(key);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    waiting.promise.then(
      result => signal?.aborted ? abort() : finish(undefined, result),
      error => finish(error),
    );
  });
  /**
   * `${provider}/${id}` -> consecutive failures, driving cooldown backoff.
   * Recovery also has a separate four-pass budget per failure episode.
   */
  const failureStreak = new Map();

  // `pi.log` is not part of Pi's documented extension API, so it may be a no-op.
  // The file is therefore the durable channel: every decision goes to both.
  const decisionLog = createDecisionLog({
    path: process.env.PI_FAILOVER_ROUTER_LOG ?? join(homedir(), ".pi", "agent", "failover-router.log"),
  });
  const log = (message) => {
    pi.log?.(message);
    decisionLog(message);
  };

  log(`failover-router: build ${buildStamp()} loaded (pid ${process.pid})`);
  let virtuals = [];
  try {
    virtuals = loadRouterConfig(configPath);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error?.message ?? error);
    log(`failover-router: config not loaded: ${message}`);
    return;
  }
  if (virtuals.length === 0) return;

  speedCache = readSpeedCache(speedPath, { readFile: readFileSync }) ?? emptyCache();
  priceCache = readPriceCache(pricePath, { readFile: readFileSync }) ?? emptyPriceCache();

  /**
   * Publishes the snapshot the Channels card paints: what routing already knows,
   * in one read-only object. The listener is another extension's code, so a throw
   * there is contained: showing the card must never change a routing decision.
   */
  const publishChannels = () => {
    try {
      pi.events?.emit?.(
        CHANNELS_SNAPSHOT_EVENT,
        buildChannelsSnapshot({ virtuals, speedCache, priceCache, cooldowns, lastRouted, now: Date.now() }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failover-router: could not publish the channel snapshot: ${message}`);
    }
  };
  publishChannels();

  /**
   * Orders one chain for this request. `speed` chains put measured channels first,
   * fastest winning; a chain with no measurement at all keeps its configured order.
   */
  const chainFor = (def) =>
    def.order === "speed"
      ? orderBySpeed(def.chain, speedCache, tokensPerSecond)
      : orderByPrice(def.chain, priceCache);

  const virtualKey = (def) => `${def.provider}/${def.id}`;

  /**
   * A session commits to one model for its whole life, and Pi keeps each virtual
   * model's route under that virtual id alone (`model-runtime.js` maps id -> route).
   * A session that selected a physical channel therefore never asks a router/*
   * route, so no rotation can reach it. Silent ineffectiveness is the worst
   * outcome for a failover layer, so this is reported out loud instead.
   */
  const bypassReport = (model) => {
    if (!model?.provider || !model?.id) return undefined;
    const key = `${model.provider}/${model.id}`;
    if (virtuals.some((def) => virtualKey(def) === key)) return undefined;
    const owner = virtuals.find((def) => def.chain.some((step) => step.model === key));
    if (!owner) return undefined;
    return (
      `failover-router: this session bypasses failover — it selected ${key} directly, ` +
      `so no rotation applies; select ${virtualKey(owner)} to get the chain`
    );
  };

  const selectedDefinition = (ctx, failedModel) => {
    const selected = ctx?.model;
    if (selected?.provider && selected?.id) {
      return virtuals.find(def => virtualKey(def) === `${selected.provider}/${selected.id}`);
    }
    return virtuals.find(def => def.chain.some(step => step.model === failedModel));
  };

  const selectedPhysical = (ctx) => {
    const selected = ctx?.model;
    if (!selected?.provider || !selected?.id) return undefined;
    if (virtuals.some(def => virtualKey(def) === `${selected.provider}/${selected.id}`)) return undefined;
    return selected;
  };

  const physicalFailure = (ctx, message) => {
    const selected = selectedPhysical(ctx);
    if (!selected || message?.provider !== selected.provider || message?.model !== selected.id) return undefined;
    const key = `${selected.provider}/${selected.id}`;
    const verdict = classifyFailure(message.errorMessage);
    if (!verdict.rotate) {
      clearPhysicalRecovery(key);
      return undefined;
    }
    let state = physicalRecovery.get(key);
    if (!state) {
      state = newPhysicalRecovery();
      physicalRecovery.set(key, state);
    }
    planPhysicalRecovery(
      state,
      message.errorMessage,
      `${message.provider}/${message.model}:${message.timestamp ?? ""}`,
    );
    log(`failover-router: physical ${key} failure ${state.attempts}/${MAX_PHYSICAL_ATTEMPTS} — ${verdict.kind}`);
    if (state.exhausted) {
      log(`failover-router: physical ${key} recovery exhausted after ${MAX_PHYSICAL_ATTEMPTS} attempts; last error: ${state.error}`);
    }
    return { key, state };
  };

  // Both native retry and terminal takeover consume the same planned decision.
  // agent_end may repeat the message object, so use the persisted dispatch token
  // plus its timestamp rather than object identity alone.
  const recordChannelFailure = (def, message, model) => {
    const key = virtualKey(def);
    let state = recovery.get(key);
    if (!state) {
      state = newRecovery();
      recovery.set(key, state);
    }
    const failedModel = model ?? `${message?.provider}/${message?.model}`;
    const verdict = classifyFailure(message?.errorMessage);
    if (!verdict.rotate || !chainFor(def).some(step => step.model === failedModel)) {
      state.pending = null;
      log(`failover-router: ${key} not recovering ${failedModel} — ${verdict.kind}: ${verdict.reason}`);
      return state;
    }
    if (state.stopped || state.exhausted) return state;
    // agent_end can arrive after native retry already routed another channel.
    // Timestamps identify cloned late messages, including single-channel repeats.
    const identity = message?.timestamp === undefined ? undefined : `${failedModel}:${message.timestamp}`;
    state.seenFailures ??= [];
    if ((identity && state.seenFailures.includes(identity)) || (state.last && state.last !== failedModel)) return state;
    if (identity) state.seenFailures.push(identity);
    state.order ??= structuredClone(chainFor(def));
    const failureKey = `${state.dispatchToken ?? "initial"}:${failedModel}:${message?.timestamp ?? ""}`;
    if (!planRecovery(state, state.order, failedModel, message.errorMessage, failureKey)) return state;
    const streak = noteFailure(failureStreak, failedModel);
    const waitMs = cooldownMs(verdict.kind, streak);
    cooldowns.set(failedModel, Date.now() + waitMs);
    publishChannels();
    log(`failover-router: ${key} failure recorded ${failedModel} — ${verdict.kind}; ${Math.round(waitMs / 60_000)} min cooldown (attempt ${streak + 1})`);
    if (state.exhausted) {
      log(`failover-router: ${key} recovery exhausted after initial pass and 3 repeats; last error: ${state.error}`);
    } else {
      log(`failover-router: ${key} taking over ${failedModel}; next ${state.pending.step.model}; pass ${state.pending.pass + 1}/4`);
    }
    return state;
  };

  /** Plan synchronously; only a cooldown wait returns a Promise. */
  const decideRoute = (def, key, request, ctx) => {
    const find = ref => {
      const slash = ref.indexOf("/");
      return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    };
    let state = recovery.get(key);
    if (!state) {
      state = !resetRecovery.has(key) && request.state?.version === 1 ? structuredClone(request.state) : newRecovery();
      resetRecovery.delete(key);
      recovery.set(key, state);
    }
    const signal = request.signal ?? ctx?.signal;
    if (signal?.aborted) {
      stopRecovery(key);
      throw abortError();
    }
    if (state.exhausted) {
      throw new Error(`failover-router: recovery exhausted after initial pass and 3 repeats: ${state.error}`);
    }
    if (request.reason === "retry" && request.failed) {
      const failedModel = `${request.failed.model?.provider}/${request.failed.model?.id}`;
      const verdict = classifyFailure(request.failed.message?.errorMessage);
      log(`failover-router: ${key} retry after ${failedModel} — ${verdict.kind}: ${verdict.reason}`);
      if (request.failed.message?.stopReason === "aborted") {
        stopRecovery(key);
        throw abortError();
      }
      if (!verdict.rotate) {
        stopRecovery(key);
        const same = request.failed.model;
        return withLevel(same, request.failed.thinkingLevel);
      }
      state = recordChannelFailure(def, request.failed.message, failedModel);
    }
    if (state.stopped) throw abortError();
    if (state.exhausted) {
      throw new Error(`failover-router: recovery exhausted after initial pass and 3 repeats: ${state.error}`);
    }
    if (state.pending) {
      const { step, pass } = state.pending;
      const model = find(step.model);
      if (!model) {
        state.pending = null;
        throw new Error(`failover-router: ${step.model} is not in the catalog; last error: ${state.error}`);
      }
      const existingWait = recoveryWaits.get(key);
      if (existingWait?.state === state) return observeRecoveryWait(key, existingWait, signal);
      const dispatch = () => {
        if (state.stopped || recovery.get(key) !== state) {
          stopRecovery(key);
          throw abortError();
        }
        dispatchRecovery(state, step, pass);
        state.dispatchToken = ++dispatchSerial;
        state.failureKey = null;
        lastRouted.set(key, step.model);
        log(`failover-router: ${key} continuing on ${step.model}; pass ${pass + 1}/4`);
        return { ...withLevel(model, step.thinkingLevel ?? request.thinkingLevel), state: structuredClone(state) };
      };
      const waitMs = Math.max(0, (cooldowns.get(step.model) ?? 0) - Date.now());
      if (waitMs === 0) return dispatch();
      log(`failover-router: ${key} waiting ${waitMs} ms for ${step.model}; pass ${pass + 1}/4 (cancel to stop)`);
      try { ctx?.ui?.setStatus?.("failover-router", `Channel recovery: waiting ${Math.ceil(waitMs / 1000)}s, pass ${pass + 1}/4`); } catch {}
      const controller = new AbortController();
      const waiting = { state, controller, observers: new Set() };
      // Another virtual can extend the shared physical cooldown while this
      // timer sleeps. Recheck only at a deadline, then wait for the new one;
      // never poll or dispatch using the stale deadline.
      const awaitDeadline = () => {
        if (controller.signal.aborted) throw abortError();
        const remaining = Math.max(0, (cooldowns.get(step.model) ?? 0) - Date.now());
        return remaining > 0
          ? waitForCooldown(remaining, controller.signal).then(awaitDeadline)
          : dispatch();
      };
      waiting.promise = Promise.resolve(awaitDeadline()).finally(() => {
        if (recoveryWaits.get(key) === waiting) {
          recoveryWaits.delete(key);
          try { ctx?.ui?.setStatus?.("failover-router", undefined); } catch {}
        }
      });
      recoveryWaits.set(key, waiting);
      return observeRecoveryWait(key, waiting, signal);
    }

    const sticky = request.previous?.model ?? (lastRouted.get(key) ? find(lastRouted.get(key)) : undefined);
    const ordered = chainFor(def);
    const step = request.reason !== "user" && sticky
      ? ordered.find(step => step.model === `${sticky.provider}/${sticky.id}`)
      : ordered.find(step => (cooldowns.get(step.model) ?? 0) <= Date.now()) ?? ordered[0];
    const model = request.reason !== "user" && sticky ? sticky : step ? find(step.model) : undefined;
    if (!model) return undefined;
    if (step && step !== ordered[0] && request.reason === "user") {
      log(`failover-router: ${key} skips ${ordered[0].model} for this request; it is cooling after a failure`);
    }
    state.order ??= structuredClone(ordered);
    const chosen = step ?? { model: `${model.provider}/${model.id}` };
    dispatchRecovery(state, chosen);
    state.dispatchToken = ++dispatchSerial;
    state.failureKey = null;
    lastRouted.set(key, chosen.model);
    // A legacy continuation carries the previous response's level. Explicit
    // chain levels remain authoritative for a new user request and retries.
    const level = request.reason !== "user" && request.reason !== "retry"
      ? request.previous?.thinkingLevel ?? request.thinkingLevel
      : chosen.thinkingLevel ?? request.previous?.thinkingLevel ?? request.thinkingLevel;
    return { ...withLevel(model, level), state: structuredClone(state) };
  };

  /** One initial publish per session, so a late-loading shell is never empty. */
  let published = false;

  for (const def of virtuals) {
    const key = `${def.provider}/${def.id}`;
    // A level the providers refuse is dropped, but never silently: a configuration
    // that still lists it would otherwise look accepted and behave differently.
    const dropped = (def.thinkingLevels ?? []).filter((level) => !isAdmissible(level));
    if (dropped.length > 0) {
      log(`failover-router: ${key} ignores thinking level(s) ${dropped.join(", ")}: providers refuse them`);
    }

    pi.registerVirtualModel({
      provider: def.provider,
      id: def.id,
      name: def.name,
      // Only levels the router may actually send are offered: listing `off` let a
      // selection reach a channel that answers it with a 400. A configuration
      // that leaves nothing usable still has to offer something selectable.
      thinkingLevels: offeredLevels(def.thinkingLevels),
      description: def.description,
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
      input: def.input,
      route(request, ctx) {
        // A shell that loaded after this extension still needs the snapshot; the
        // first request of the session is the earliest moment both are live.
        if (!published) {
          published = true;
          publishChannels();
        }
        // Cost routing waits for the current marketplace refresh so the first
        // selection uses fresh prices. Each underlying request has a bounded
        // timeout, and refresh failures preserve the last known cache.
        if (def.order !== "speed" && priceRefresh) {
          const inFlightPrices = priceRefresh;
          return inFlightPrices.then(() => decideRoute(def, key, request, ctx));
        }
        // A cost-ordered route should not make its first choice from stale or
        // configured-order data while the session-start marketplace refresh is
        // still running. Each request is bounded by PRICE_FETCH_TIMEOUT_MS.
        if (def.order !== "speed" && priceRefresh) {
          const inFlightPrices = priceRefresh;
          return inFlightPrices.then(() => decideRoute(def, key, request, ctx));
        }
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
            log(`failover-router: ${key} routing without waiting further for measurements`);
          }
          return decideRoute(def, key, request, ctx);
        });
      },
    });

    log(`failover-router: registered ${key} (${def.chain.length} candidates)`);
  }

  // ---- terminal takeover ----------------------------------------------------
  // Native retries and the final settle takeover share this extension-owned plan.
  pi.on?.("message_end", (event, ctx) => {
    const message = event?.message;
    if (message?.role !== "assistant") return undefined;
    if (message.stopReason === "error") {
      if (!selectedDefinition(ctx, `${message.provider}/${message.model}`)) physicalFailure(ctx, message);
      const ref = `${message.provider}/${message.model}`;
      const def = selectedDefinition(ctx, ref);
      if (!def) return undefined;
      const verdict = classifyFailure(message.errorMessage);
      if (!verdict.rotate) {
        stopRecovery(virtualKey(def));
        return undefined;
      }
      const state = recordChannelFailure(def, message, ref);
      if (state.exhausted || !state.pending) return undefined;
      // A deterministic rejection (provider moderation) fails identically on the
      // channel that just refused it, so buying Pi's native retry would spend
      // three identical requests there. The takeover path advances the chain.
      if (verdict.annotate === false) return undefined;
      const annotated = retryableErrorText(message.errorMessage);
      return annotated ? { ...message, errorMessage: annotated } : undefined;
    }
    const ref = `${message.provider}/${message.model}`;
    if (message.stopReason !== "aborted") noteSuccess(failureStreak, ref);
    const def = selectedDefinition(ctx, ref);
    if (!def) {
      if (message.stopReason !== "aborted") clearPhysicalRecovery(ref);
      return undefined;
    }
    if (def) {
      const key = virtualKey(def);
      if (message.stopReason === "aborted") stopRecovery(key);
      else clearRecovery(key);
    }
    return undefined;
  });

  pi.on?.("agent_end", (event, ctx) => {
    const last = lastAssistantMessage(event?.messages);
    const failure = resolveDeadEnd(last);
    const failedModel = `${last?.provider}/${last?.model}`;
    const def = selectedDefinition(ctx, failedModel);
    if (!def) {
      if (failure) physicalFailure(ctx, last);
      else if (last && last.stopReason !== "aborted") clearPhysicalRecovery(failedModel);
      const bypass = bypassReport(ctx?.model);
      if (bypass) log(bypass);
      return;
    }
    if (!failure) {
      const key = virtualKey(def);
      if (last?.stopReason === "aborted") stopRecovery(key);
      else if (last) {
        clearRecovery(key);
        noteSuccess(failureStreak, failedModel);
      }
      return;
    }
    if (!failure.rotate) stopRecovery(virtualKey(def));
    else recordChannelFailure(def, last, failedModel);
  });

  pi.on?.("agent_before_settle", (event, ctx) => {
    if (event?.outcome !== "error") return undefined;
    const selected = selectedPhysical(ctx);
    if (selected) {
      const key = `${selected.provider}/${selected.id}`;
      const state = physicalRecovery.get(key);
      if (state && !state.exhausted && !state.stopped && state.markerAttempt !== state.attempts) {
        const waitMs = physicalWaitMs(state.attempts);
        const continueRun = () => {
          if (ctx?.signal?.aborted || physicalRecovery.get(key) !== state || state.exhausted) return undefined;
          state.markerAttempt = state.attempts;
          log(`failover-router: physical ${key} continuing after attempt ${state.attempts}/${MAX_PHYSICAL_ATTEMPTS}`);
          return {
            entries: [
              ...(event.entries ?? []),
              {
                type: "custom_message",
                customType: "failover-router.physical-continue",
                content: "Retry the current task on the selected physical model. Use the existing tool results; do not repeat completed actions.",
                display: false,
              },
            ],
            continue: true,
          };
        };
        if (waitMs === 0) return continueRun();
        const existing = physicalWaits.get(key);
        if (existing) return existing.promise.then(continueRun);
        log(`failover-router: physical ${key} waiting ${waitMs / 60_000} minutes after attempt ${state.attempts}/${MAX_PHYSICAL_ATTEMPTS}`);
        const controller = new AbortController();
        const waiting = { controller };
        waiting.promise = waitForCooldown(waitMs, controller.signal).finally(() => {
          if (physicalWaits.get(key) === waiting) physicalWaits.delete(key);
        });
        physicalWaits.set(key, waiting);
        return waiting.promise.then(continueRun);
      }
      return undefined;
    }
    const state = ctx?.model?.provider && ctx?.model?.id
      ? recovery.get(`${ctx.model.provider}/${ctx.model.id}`)
      : [...recovery.values()].find(state => state.pending);
    if (!state?.pending || state.exhausted || state.stopped || ctx?.signal?.aborted) return undefined;
    // One marker per dispatch. Returning the prior proposals preserves other
    // extensions' entries. Pi rechecks canContinue after committing this marker.
    const token = state.dispatchToken ?? "initial";
    if (state.markerToken === token) return undefined;
    state.markerToken = token;
    log("failover-router: asking Pi for one more request on the rotated channel");
    return {
      entries: [
        ...(event.entries ?? []),
        {
          type: "custom_message",
          customType: "failover-router.continue",
          content: "Continue the current task on another channel. Use the existing tool results; do not repeat completed actions.",
          display: false,
        },
      ],
      continue: true,
    };
  });

  // A real new prompt is distinct from a boundary marker, which fires no input
  // hooks. Clear exhausted episodes here, not on reason:user (markers use it too).
  pi.on?.("before_agent_start", () => {
    for (const key of recovery.keys()) clearRecovery(key);
    physicalRecovery.clear();
    physicalWaits.clear();
    for (const def of virtuals) resetRecovery.add(virtualKey(def));
  });
  pi.on?.("session_start", (_event, ctx) => {
    failureStreak.clear();
    physicalRecovery.clear();
    physicalWaits.clear();
    for (const key of recovery.keys()) clearRecovery(key);
    for (const def of virtuals) resetRecovery.add(virtualKey(def));
    published = false;
    const bypass = bypassReport(ctx?.model);
    if (bypass) log(bypass);
  });

  /**
   * Keeps the Channels card installed. Pi documents no integrity check for
   * installed packages, so nothing else notices when an update removes it: the
   * rail would just paint one section fewer. The check is one short child
   * process per session and says nothing when the card is there.
   */
  const notifyQuietly = (ctx, message, level) => {
    log(message);
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      // A notification is a courtesy; it never breaks a session start.
    }
  };
  let patchGuardStarted = false;
  const guardChannelsCard = (ctx) => {
    if (patchGuardStarted) return;
    patchGuardStarted = true;
    // The one documented way out: no patch directory, nothing to keep alive.
    if (process.env.PI_FAILOVER_ROUTER_NO_PATCHER === "1") return;
    if (!existsSync(PATCH_GUARD_SCRIPT)) {
      const decision = decidePatchAction({ checkCode: null, scriptMissing: true });
      notifyQuietly(ctx, decision.message, "warning");
      return;
    }
    const runScript = (args) =>
      new Promise((settle) => {
        const child = spawn(process.execPath, [PATCH_GUARD_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stdout?.on("data", () => {});
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => settle({ code: null, stderr: `${stderr}${error?.message ?? error}` }));
        child.on("close", (code) => settle({ code, stderr }));
        child.unref?.();
      });
    void (async () => {
      const checked = await runScript(["--check"]);
      if (checked.code === 0) return;
      const repaired = await runScript([]);
      const decision = decidePatchAction({
        checkCode: checked.code,
        applyCode: repaired.code,
        stderr: repaired.stderr || checked.stderr,
      });
      if (decision.action === "idle") return;
      notifyQuietly(ctx, decision.message, decision.action === "repaired" ? "info" : "warning");
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      notifyQuietly(ctx, `failover-router: the Channels card could not be verified (${message})`, "warning");
    });
  };

  pi.on?.("session_start", (_event, ctx) => {
    guardChannelsCard(ctx);
  });

  // ---- throughput and marketplace refresh ------------------------------------
  const refs = [...new Set(virtuals.flatMap((def) => def.chain.map((s) => s.model)))];
  const speedRefs = [
    ...new Set(virtuals.filter((def) => def.order === "speed").flatMap((def) => def.chain.map((s) => s.model))),
  ];

  const persistPrices = () => {
    priceCache = prunePriceCache(priceCache, refs);
    try {
      const temporary = `${pricePath}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(priceCache, null, 2)}\n`);
      renameSync(temporary, pricePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failover-router: could not persist marketplace prices: ${message}`);
    }
  };
  persistPrices();

  const refreshPrices = () => {
    if (priceRefresh) return priceRefresh;
    priceRefresh = fetchSubrouterPrices(refs, {
      fetchImpl: pi.subrouterFetch ?? globalThis.fetch,
      log,
    }).then(({ prices, failures }) => {
      if (Object.keys(prices).length > 0) {
        priceCache = recordPrices(priceCache, prices, Date.now());
        persistPrices();
        publishChannels();
        try { pi.events?.emit?.(PRICES_EVENT, priceSnapshot(priceCache, refs)); } catch {}
      }
      if (failures.length > 0) log(`failover-router: ${failures.length} marketplace price fetch(es) failed`);
    }).catch(error => {
      log(`failover-router: marketplace price refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      priceRefresh = null;
    });
    return priceRefresh;
  };

  let refreshTimer = undefined;
  let priceTimer = undefined;
  pi.on?.("session_start", () => {
    void refreshPrices();
    if (priceTimer === undefined) {
      priceTimer = setInterval(() => { void refreshPrices(); }, PRICE_REFRESH_MS);
      priceTimer.unref?.();
    }
  });
  pi.on?.("session_shutdown", () => {
    if (priceTimer !== undefined) clearInterval(priceTimer);
    priceTimer = undefined;
  });

  const persist = () => {
    speedCache = pruneCache(speedCache, speedRefs);
    try {
      const temporary = `${speedPath}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(speedCache, null, 2)}\n`);
      renameSync(temporary, speedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failover-router: could not persist speed measurements: ${message}`);
    }
  };

  // Persist once at load so obsolete refs are removed even when no probe is due
  // or the router has cost-only virtuals.
  persist();

  if (speedRefs.length === 0) return;

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
      // The durable channel, not `pi.log`: a measurement that only reaches a
      // channel this runtime does not persist is indistinguishable from one that
      // never ran, which is exactly the confusion this file exists to prevent.
      log,
      startingTierFor: (ref) => startingTier(speedCache, ref),
    })
      .then(({ measured, failed }) => {
        const now = Date.now();
        for (const { ref, tokensPerSecond: speed, timeoutTierMs, message } of measured) {
          speedCache = recordSample(speedCache, ref, speed, now, timeoutTierMs, message);
        }
        for (const { ref, message } of failed) {
          // Kept in the cache so the channel is retried next time and the log has
          // a durable record; without it a permanently failing channel vanishes.
          speedCache = recordFailure(speedCache, ref, message, now);
        }
        if (measured.length > 0 || failed.length > 0) persist();
        // A measurement just changed every speed number the card shows.
        publishChannels();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`failover-router: speed measurement failed: ${message}`);
        publishChannels();
      })
      .finally(() => {
        measurement = null;
      });
    return measurement;
  };

  const measureIfDue = (ctx) => {
    // Only the channels that are stale, never measured, or last failed.
    const pending = dueRefs(speedCache, speedRefs, Date.now());
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
