import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { classifyFailure, cooldownMs } from "../../common/classify.js";
import { orderByPrice } from "../../common/price-cache.js";
import { tokensPerSecond } from "../../common/speed-cache.js";
import { orderBySpeed } from "../../common/speed-order.js";
import { dispatchRecovery, newRecovery, planRecovery, newPhysicalRecovery, planPhysicalRecovery, physicalWaitMs } from "../../common/recovery.js";
import { resolveLevel } from "../../common/thinking-level.js";
import { dispatchUpstream, failure } from "./upstream.js";

const MAX_BODY = 8 * 1024 * 1024;
const PATHS = new Set(["/v1/chat/completions", "/v1/responses"]);
const hash = value => createHash("sha256").update(value).digest();
const abortableSleep = (ms, signal) => delay(ms, undefined, { signal });

export const channelRef = step => `${step.channel}/${step.model}`;
export function candidateOrder(profile, _channels, { speedCache, priceCache } = {}) {
  const refs = profile.chain.map(step => ({ ...step, upstreamModel: step.model, model: channelRef(step) }));
  if (profile.order === "speed") return orderBySpeed(refs, speedCache, tokensPerSecond);
  if (profile.order === "cost") return orderByPrice(refs, priceCache);
  return refs;
}

const TOO_LARGE = Symbol("body too large");
async function readPayload(request) {
  if (Number(request.headers["content-length"]) > MAX_BODY) return TOO_LARGE;
  const chunks = [];
  let size = 0;
  // Don't destroy the HTTP socket on early exit: the client needs the 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) return TOO_LARGE;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response, result, extra = {}) {
  response.writeHead(result.status, { "content-type": result.contentType, "content-length": result.body.length, "cache-control": "no-store", ...extra });
  response.end(result.body);
}

export async function routeGatewayRequest({ request, response, config, signal, fetchImpl = fetch, dispatch = dispatchUpstream,
  channelsState = new Map(), getMetrics = () => ({}), prepare = async () => {}, now = Date.now, sleep = abortableSleep, log = () => {} }) {
  const reject = (status, message, type = "invalid_request_error", extra) => {
    request.resume();
    reply(response, failure(status, message, type), extra);
  };
  // Check the raw target; don't resolve a client-supplied URL against upstream.
  const path = request.url;
  if (!PATHS.has(path) && path !== "/v1/models") return reject(404, "Unknown gateway endpoint");
  if ((request.method ?? "POST") !== (path === "/v1/models" ? "GET" : "POST")) return reject(405, "Method not allowed", undefined, { allow: path === "/v1/models" ? "GET" : "POST" });
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !timingSafeEqual(hash(authorization), hash(`Bearer ${config.apiKey}`))) {
    return reject(401, "Invalid local gateway key", "authentication_error", { "www-authenticate": "Bearer" });
  }
  if (path === "/v1/models") {
    const data = Object.keys(config.profiles).map(id => ({ id, object: "model", created: 0, owned_by: "failover-router" }));
    return reply(response, { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ object: "list", data })) });
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") return reject(415, "Compressed requests are not supported");
  let payload;
  try { payload = await readPayload(request); }
  catch { if (!signal?.aborted) reject(400, "Request body must be valid JSON"); return; }
  if (payload === TOO_LARGE) return reject(413, "Request body too large", undefined, { connection: "close" });
  if (!payload || Array.isArray(payload) || typeof payload.model !== "string") return reject(400, "Request must include a model ID");
  const profile = Object.hasOwn(config.profiles, payload.model) ? config.profiles[payload.model] : undefined;
  if (!profile) return reject(404, "Unknown failover model", "model_not_found");
  if (profile.protocol && profile.protocol !== path.slice(4)) return reject(400, "Model uses a different upstream protocol");
  if (path === "/v1/responses" && payload.store === true) return reject(400, "Responses storage is not supported");
  if (path === "/v1/responses" && (payload.previous_response_id != null || payload.conversation != null || payload.background === true)) {
    return reject(400, "Provider-bound Responses state and background requests cannot be routed");
  }

  await prepare(profile, signal);
  signal?.throwIfAborted();
  const ordered = candidateOrder(profile, config.channels, getMetrics());
  const first = ordered.find(step => (channelsState.get(step.model)?.until ?? 0) <= now()) ?? ordered[0];
  const state = newRecovery();
  const physical = profile.recovery === "physical" ? newPhysicalRecovery() : undefined;
  let pending = { step: first, pass: 0 };
  let seen = 0;
  while (pending) {
    const { step, pass } = pending;
    signal?.throwIfAborted();
    if (!physical && seen > 0) {
      let remaining;
      while ((remaining = (channelsState.get(step.model)?.until ?? 0) - now()) > 0) {
        await sleep(remaining, signal);
        signal?.throwIfAborted();
      }
    }
    const before = channelsState.get(step.model);
    dispatchRecovery(state, step, pass);
    const outgoing = { ...payload, model: step.upstreamModel };
    const requested = path === "/v1/responses" ? outgoing.reasoning?.effort : outgoing.reasoning_effort;
    const map = step.reasoningLevels && Object.fromEntries(step.reasoningLevels.map(level => [level, level]));
    const effort = step.reasoningEffort ?? resolveLevel({ thinkingLevelMap: map }, typeof requested === "string" ? requested : undefined);
    if (path === "/v1/responses") {
      outgoing.store = false;
      if (effort || (outgoing.reasoning && typeof outgoing.reasoning === "object")) {
        outgoing.reasoning = { ...outgoing.reasoning };
        delete outgoing.reasoning.effort;
        if (effort) outgoing.reasoning.effort = effort;
        if (Object.keys(outgoing.reasoning).length === 0) delete outgoing.reasoning;
      }
    } else {
      delete outgoing.reasoning_effort;
      if (effort) outgoing.reasoning_effort = effort;
    }
    const result = await dispatch({ channel: config.channels[step.channel], path: path.slice(3), payload: outgoing, signal,
      fetchImpl, timeoutMs: config.attemptTimeoutMs ?? 300_000 });
    signal?.throwIfAborted();
    if (result.ok) {
      if (channelsState.get(step.model) === before) channelsState.delete(step.model);
      return reply(response, result, { "x-failover-channel": step.channel });
    }
    const verdict = classifyFailure(result.detail);
    if (!verdict.rotate) return reply(response, result);
    ++seen;
    log(`failover-router: ${payload.model} ${step.model} ${verdict.kind} (attempt ${seen})`);
    if (physical) {
      planPhysicalRecovery(physical, "", seen);
      if (physical.exhausted) return reply(response, result, { "x-failover-exhausted": "true" });
      const wait = physicalWaitMs(physical.attempts);
      if (wait) await sleep(wait, signal);
    } else {
      const streak = channelsState.get(step.model)?.streak ?? 0;
      channelsState.set(step.model, { streak: streak + 1, until: now() + cooldownMs(verdict.kind, streak) });
      planRecovery(state, ordered, step.model, "", seen);
      if (state.exhausted) return reply(response, result, { "x-failover-exhausted": "true" });
      pending = state.pending;
    }
  }
}
