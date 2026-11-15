/**
 * Failover router: a Pi extension that registers virtual models whose physical
 * target changes when a request fails for a reason another channel could fix.
 *
 * Why it exists: Pi classifies terminal errors into categories and only lets
 * quota/auth/rate_limit/provider_unavailable/timeout/network move a fallback
 * chain. Real channel defects land outside that set — a channel that rejects
 * tool calls answers 400 "invalid_request_error", and a cut stream reports
 * `499 ... response body closed`, which matches no keyword at all. Both stop the
 * run with no failover. This router reads the raw message and rotates anyway,
 * while refusing to rotate request-shaped failures that every model would share.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { classifyFailure, cooldownMs, nextCandidate } from "./lib/classify.js";
import { ConfigError, loadRouterConfig } from "./lib/config.js";

export const DEFAULT_CONFIG_FILE = "failover-router.json";

/** @param {string} path */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function failoverRouter(pi) {
  const configPath = resolve(expandHome(process.env.PI_FAILOVER_ROUTER_CONFIG || join("~/.pi/agent", DEFAULT_CONFIG_FILE)));

  /** model id -> epoch ms until which it is skipped */
  const cooldowns = new Map();
  /** `${provider}/${id}` -> last routed model, so a retry knows what failed */
  const lastRouted = new Map();

  let virtuals = [];
  try {
    virtuals = loadRouterConfig(configPath);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error?.message ?? error);
    pi.log?.(`failover-router: config not loaded: ${message}`);
    return;
  }
  if (virtuals.length === 0) return;

  for (const def of virtuals) {
    const key = `${def.provider}/${def.id}`;

    pi.registerVirtualModel({
      provider: def.provider,
      id: def.id,
      name: def.name,
      thinkingLevels: def.thinkingLevels,
      description: def.description,
      route(request, ctx) {
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
            const next = nextCandidate({ chain: def.chain, failedModel, cooldowns, now });
            if (next) {
              const model = find(next.model);
              if (model) {
                lastRouted.set(key, next.model);
                return next.thinkingLevel ? { model, thinkingLevel: next.thinkingLevel } : { model };
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

        // Everything else sticks to the model that last answered successfully,
        // which keeps the prompt cache warm across tool follow-ups.
        const sticky = request.previous?.model ?? (lastRouted.get(key) ? find(lastRouted.get(key)) : undefined);
        if (request.reason !== "user" && sticky) {
          return { model: sticky, thinkingLevel: request.previous?.thinkingLevel ?? request.thinkingLevel };
        }

        const first = find(def.chain[0].model);
        if (!first) return undefined; // let Pi report the broken config
        lastRouted.set(key, def.chain[0].model);
        return def.chain[0].thinkingLevel
          ? { model: first, thinkingLevel: def.chain[0].thinkingLevel }
          : { model: first };
      },
    });

    pi.log?.(`failover-router: registered ${key} (${def.chain.length} candidates)`);
  }
}
