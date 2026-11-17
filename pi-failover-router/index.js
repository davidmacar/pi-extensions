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
import { classifyFailure, cooldownMs, nextCandidate } from "./lib/classify.js";
import { createDecisionLog } from "./lib/decision-log.js";
import { buildChannelsSnapshot, CHANNELS_SNAPSHOT_EVENT } from "./lib/channels-snapshot.js";
import { decidePatchAction } from "./lib/patch-guard.js";
import { retryableErrorText } from "./lib/retry-bridge.js";
import { DEFAULT_LEVELS, isAdmissible, resolveLevel } from "./lib/thinking-level.js";
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
  /**
   * `${provider}/${id}` -> consecutive failures. Drives the cooldown backoff, so a
   * channel that keeps failing is tried further and further apart. Nothing else
   * limits rotations: every channel becomes available again when its cooldown
   * expires, which is what keeps a long working session from ever being stuck.
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

  /**
   * Publishes the snapshot the Channels card paints: what routing already knows,
   * in one read-only object. The listener is another extension's code, so a throw
   * there is contained: showing the card must never change a routing decision.
   */
  const publishChannels = () => {
    try {
      pi.events?.emit?.(
        CHANNELS_SNAPSHOT_EVENT,
        buildChannelsSnapshot({ virtuals, speedCache, cooldowns, lastRouted, now: Date.now() }),
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
    def.order === "speed" ? orderBySpeed(def.chain, speedCache, tokensPerSecond) : def.chain;

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
      log(
        `failover-router: ${key} retry after ${failedModel} — ${verdict.kind}: ${verdict.reason}` +
          (verdict.rotate ? "" : " (not rotating)"),
      );
      if (verdict.rotate) {
        const now = Date.now();
        const streak = noteFailure(failureStreak, failedModel);
        cooldowns.set(failedModel, now + cooldownMs(verdict.kind, streak));
        // The card shows the cooldown that just started, without waiting for the
        // next measurement to repaint the rail.
        publishChannels();
        const next = nextCandidate({ chain: chainFor(def), failedModel, cooldowns, now });
        if (next) {
          const model = find(next.model);
          if (model) {
            lastRouted.set(key, next.model);
            return withLevel(model, next.thinkingLevel ?? request.thinkingLevel);
          }
          log(`failover-router: ${next.model} is not in the catalog; falling through`);
        } else {
          log(`failover-router: ${key} chain exhausted`);
        }
      }
      // Not rotating, or nowhere to go: keep the model that failed so the
      // human sees the real error rather than a silently different channel.
      const same = request.failed.model;
      if (same) {
        const level = resolveLevel(find(same.provider + "/" + same.id) ?? same, request.failed.thinkingLevel);
        return level ? { model: same, thinkingLevel: level } : { model: same };
      }
    }

    // A dead end that Pi would not retry leaves a channel to use next. It wins
    // over the sticky model, which is the channel that just failed.
    const forced = forcedNext.get(key);
    if (forced) {
      forcedNext.delete(key);
      const model = find(forced.model);
      if (model) {
        lastRouted.set(key, forced.model);
        log(`failover-router: ${key} continuing on ${forced.model} after an unretryable failure`);
        return withLevel(model, forced.thinkingLevel ?? request.thinkingLevel);
      }
      log(`failover-router: ${forced.model} is not in the catalog; ignoring the rotation`);
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

  // ---- failures Pi refuses to retry -------------------------------------------
  // A channel-owned failure that Pi's own allow-list does not recognise would end
  // the run before `route()` is ever asked with `reason: "retry"`. Annotating the
  // error at `message_end` puts it on that list, so Pi retries through its normal
  // path and the chain rotates in `decideRoute`, the path the tests already cover.
  pi.on?.("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
    const failedModel = `${message.provider}/${message.model}`;
    const verdict = classifyFailure(message.errorMessage);
    if (!verdict.rotate) return undefined;

    // Only when the chain can actually go somewhere: rewriting the error while
    // every other channel cools would retry the same broken channel.
    const target = virtuals.find((def) => def.chain.some((step) => step.model === failedModel));
    if (!target) return undefined;
    const next = nextCandidate({ chain: chainFor(target), failedModel, cooldowns, now: Date.now() });
    if (!next) return undefined;

    const errorMessage = retryableErrorText(message.errorMessage);
    if (!errorMessage) return undefined;
    log(
      `failover-router: ${virtualKey(target)} making ${failedModel} retryable — ${verdict.kind}: ` +
        `${verdict.reason}; next ${next.model}`,
    );
    return { ...message, errorMessage };
  });

  // Pi ends the run without a retry when `isRetryableAssistantError` does not
  // recognise the message, so `route()` is never asked with `reason: "retry"`.
  // Those failures are exactly the ones this extension exists for, so take them
  // over here: pick the next channel on `agent_end`, then ask the boundary for one
  // more provider request. The timeout is short because it only schedules work.
  pi.on?.("agent_end", (event, ctx) => {
    const last = lastAssistantMessage(event?.messages);
    const failure = resolveDeadEnd(last);

    // A channel that answered correctly starts over: its next failure waits the
    // base cooldown instead of inheriting the backoff of an earlier bad patch.
    if (!failure && last?.stopReason !== "error" && last?.provider && last?.model) {
      noteSuccess(failureStreak, `${last.provider}/${last.model}`);
    }
    if (!failure || !failure.rotate) return;
    const failedModel = `${failure.provider}/${failure.id}`;

    // One failure decides one virtual: the one this session selected. Rotating
    // every virtual that happens to contain the channel would spend the budget
    // twice and log a decision that nobody uses.
    const selected = ctx?.model;
    const selectedKey = selected?.provider && selected?.id ? `${selected.provider}/${selected.id}` : undefined;

    // Rotating a session that cannot consume the rotation would log a decision
    // that never reaches a request.
    const bypass = bypassReport(selected);
    if (bypass) {
      log(bypass);
      return;
    }
    const target = selectedKey
      ? virtuals.find((def) => `${def.provider}/${def.id}` === selectedKey)
      : virtuals.find((def) => def.chain.some((step) => step.model === failedModel));
    if (!target) return;
    const key = `${target.provider}/${target.id}`;

    const ordered = chainFor(target);
    if (!ordered.some((step) => step.model === failedModel)) return;
    const now = Date.now();
    const streak = noteFailure(failureStreak, failedModel);
    const waitMs = cooldownMs(failure.kind, streak);
    cooldowns.set(failedModel, now + waitMs);
    const next = nextCandidate({ chain: ordered, failedModel, cooldowns, now });
    if (!next) {
      log(
        `failover-router: ${key} chain exhausted after ${failedModel} ` +
          `(${Math.round(waitMs / 60_000)} min cooldown, attempt ${streak + 1})`,
      );
      return;
    }
    forcedNext.set(key, next);
    log(
      `failover-router: ${key} taking over ${failedModel} — ${failure.kind}: ${failure.reason}; ` +
        `next ${next.model}; ${Math.round(waitMs / 60_000)} min cooldown (attempt ${streak + 1})`,
    );
  });

  pi.on?.("agent_before_settle", (event) => {
    if (forcedNext.size === 0) return undefined;
    if (!event?.context?.canContinue) {
      // The boundary refuses a bare continuation after an error; the marker keeps
      // the decision visible and the next user message still benefits from the
      // rotation, because route() consumes it.
      log("failover-router: rotation recorded; Pi will not continue automatically");
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

  pi.on?.("session_start", (event, ctx) => {
    // A new or reloaded session starts with no remembered failures.
    failureStreak.clear();
    forcedNext.clear();
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
      log(`failover-router: could not persist speed measurements: ${message}`);
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
