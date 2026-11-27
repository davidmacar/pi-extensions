import { isAdmissible } from "../../common/thinking-level.js";

const LOOPBACK_URL = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(message) { throw new Error(`failover-router gateway config: ${message}`); }
function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}
function secret(env, name, field) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${field} must name an environment variable`);
  const value = env[name];
  if (typeof value !== "string" || !value) fail(`${field} environment variable is not set`);
  return value;
}

/** Validate routes and resolve credential values without ever logging them. */
export function normalizeGatewayConfig(raw, { env = process.env } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("root must be an object");
  const listen = raw.listen ?? {};
  const host = nonempty(listen.host ?? "127.0.0.1", "listen.host");
  if (!["127.0.0.1", "::1"].includes(host)) fail("listen.host must be 127.0.0.1 or ::1");
  const port = listen.port ?? 43128;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("listen.port must be 1..65535");
  const apiKey = secret(env, raw.apiKeyEnv ?? "FAILOVER_ROUTER_KEY", "apiKeyEnv");
  if (!raw.channels || typeof raw.channels !== "object" || Array.isArray(raw.channels) || Object.keys(raw.channels).length === 0) fail("channels must be a non-empty object");
  const channels = Object.create(null);
  for (const [id, channel] of Object.entries(raw.channels)) {
    if (!PROFILE_ID.test(id) || !channel || typeof channel !== "object") fail(`invalid channel ${id}`);
    let baseURL;
    try { baseURL = new URL(nonempty(channel.baseURL, `channels.${id}.baseURL`)); }
    catch { fail(`channels.${id}.baseURL must be an absolute URL`); }
    if (!new Set(["https:", "http:"]).has(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) fail(`channels.${id}.baseURL must be an HTTP(S) URL without credentials, query, or fragment`);
    if (baseURL.protocol === "http:" && !LOOPBACK_URL.has(baseURL.hostname)) fail(`channels.${id}.baseURL must use HTTPS except for loopback test servers`);
    if (!baseURL.pathname.replace(/\/$/, "").endsWith("/v1")) fail(`channels.${id}.baseURL must end in /v1`);
    const upstreamKey = secret(env, channel.apiKeyEnv, `channels.${id}.apiKeyEnv`);
    channels[id] = { baseURL: baseURL.toString().replace(/\/$/, ""), apiKey: upstreamKey };
  }
  if (!raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles) || Object.keys(raw.profiles).length === 0) fail("profiles must be a non-empty object");
  const profiles = Object.create(null);
  for (const [id, profile] of Object.entries(raw.profiles)) {
    if (!PROFILE_ID.test(id) || !profile || !Array.isArray(profile.chain) || profile.chain.length === 0) fail(`profiles.${id}.chain must be non-empty`);
    const protocol = profile.protocol ?? "chat/completions";
    if (!["chat/completions", "responses"].includes(protocol)) fail(`profiles.${id}.protocol must be chat/completions or responses`);
    const recovery = profile.recovery ?? "chain";
    if (!["chain", "physical"].includes(recovery) || (recovery === "physical" && profile.chain.length !== 1)) fail(`profiles.${id}.recovery must be chain, or physical with one candidate`);
    const seen = new Set();
    const chain = profile.chain.map((step, i) => {
      if (!step || typeof step !== "object") fail(`profiles.${id}.chain[${i}] must be an object`);
      const channel = nonempty(step.channel, `profiles.${id}.chain[${i}].channel`);
      const model = nonempty(step.model, `profiles.${id}.chain[${i}].model`);
      if (!channels[channel]) fail(`profiles.${id}.chain[${i}] references unknown channel ${channel}`);
      if (seen.has(`${channel}/${model}`)) fail(`profiles.${id}.chain has duplicate ${channel}/${model}`);
      seen.add(`${channel}/${model}`);
      const effort = step.reasoningEffort;
      if (effort !== undefined && !isAdmissible(effort)) fail(`profiles.${id}.chain[${i}] has an unsupported reasoning effort`);
      const levels = step.reasoningLevels;
      if (levels !== undefined && (!Array.isArray(levels) || levels.some(level => !isAdmissible(level)))) fail(`profiles.${id}.chain[${i}].reasoningLevels must list supported reasoning levels`);
      if (effort && levels && !levels.includes(effort)) fail(`profiles.${id}.chain[${i}].reasoningEffort must be supported by the candidate`);
      return { channel, model, ...(effort ? { reasoningEffort: effort } : {}), ...(levels ? { reasoningLevels: [...levels] } : {}) };
    });
    const order = profile.order ?? "configured";
    if (!["configured", "cost", "speed"].includes(order)) fail(`profiles.${id}.order must be configured, cost, or speed`);
    profiles[id] = { order, protocol, recovery, chain };
  }
  const attemptTimeoutMs = raw.attemptTimeoutMs ?? 300_000;
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 900_000) fail("attemptTimeoutMs must be 1..900000");
  const { refreshMarketplace = false, probeSpeed = false } = raw;
  if (typeof refreshMarketplace !== "boolean" || typeof probeSpeed !== "boolean") fail("refreshMarketplace and probeSpeed must be booleans");
  return { listen: { host, port }, apiKey, channels, profiles, attemptTimeoutMs, refreshMarketplace, probeSpeed };
}
