/**
 * Router configuration: which virtual models exist and which physical models
 * each one may use, cheapest first.
 */
import { readFileSync } from "node:fs";

export const DEFAULT_CONFIG_PATH = "~/.pi/agent/failover-router.json";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INPUT_TYPES = new Set(["text", "image"]);
/** How a chain is ordered at request time. */
export const CHAIN_ORDERS = new Set(["cost", "speed"]);

export class ConfigError extends Error {}

function assertNonEmptyString(value, what) {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${what} must be a non-empty string`);
  return value.trim();
}

/**
 * Validates one chain step reference. Also accepts the compact "provider/id@level"
 * form so a string step can carry its own level.
 * @returns {[string, string|undefined]}
 */
function chainStepModel(value, what) {
  const text = assertNonEmptyString(value, what);
  const at = text.lastIndexOf("@");
  const model = at > 0 ? text.slice(0, at) : text;
  const level = at > 0 ? text.slice(at + 1) : undefined;
  if (!model.includes("/")) {
    throw new ConfigError(`${what}: model must be "provider/id", got "${model}"`);
  }
  if (level !== undefined && !THINKING_LEVELS.has(level)) {
    throw new ConfigError(`${what}: unknown thinking level "${level}"`);
  }
  return [model, level];
}

/**
 * Validates one virtual model definition and returns a normalized copy.
 * Throws ConfigError on anything the router could not act on, so a typo is
 * visible at load time instead of as a silently dead chain at 3am.
 *
 * @param {unknown} raw
 * @returns {{provider: string, id: string, name: string, thinkingLevels: string[],
 *            chain: Array<{model: string, thinkingLevel?: string}>, description?: string}}
 */
export function normalizeVirtual(raw) {
  if (!raw || typeof raw !== "object") throw new ConfigError("virtual model entry must be an object");
  const provider = assertNonEmptyString(raw.provider, "provider");
  const id = assertNonEmptyString(raw.id, "id");
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;

  const thinkingLevels =
    raw.thinkingLevels === undefined
      ? ["low", "medium", "high"]
      : Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.length > 0
        ? raw.thinkingLevels.map((l) => {
            if (!THINKING_LEVELS.has(l)) throw new ConfigError(`${provider}/${id}: unknown thinking level "${l}"`);
            return l;
          })
        : (() => {
            throw new ConfigError(`${provider}/${id}: thinkingLevels must be a non-empty array`);
          })();

  if (!Array.isArray(raw.chain) || raw.chain.length === 0) {
    throw new ConfigError(`${provider}/${id}: chain must be a non-empty array`);
  }
  const chain = raw.chain.map((step, i) => {
    if (typeof step === "string") {
      const [model, thinkingLevel] = chainStepModel(step, `${provider}/${id} chain[${i}]`);
      return thinkingLevel ? { model, thinkingLevel } : { model };
    }
    if (!step || typeof step !== "object") throw new ConfigError(`${provider}/${id} chain[${i}]: invalid step`);
    const [model, level] = chainStepModel(step.model, `${provider}/${id} chain[${i}].model`);
    if (level !== undefined) {
      throw new ConfigError(`${provider}/${id} chain[${i}]: thinkingLevel belongs on the object, not inside model`);
    }
    if (step.thinkingLevel !== undefined && !THINKING_LEVELS.has(step.thinkingLevel)) {
      throw new ConfigError(`${provider}/${id} chain[${i}]: unknown thinking level "${step.thinkingLevel}"`);
    }
    return step.thinkingLevel ? { model, thinkingLevel: step.thinkingLevel } : { model };
  });

  const seen = new Set();
  for (const step of chain) {
    if (seen.has(step.model)) throw new ConfigError(`${provider}/${id}: duplicate model in chain: ${step.model}`);
    seen.add(step.model);
  }

  const out = { provider, id, name, thinkingLevels, chain };
  if (raw.order !== undefined) {
    if (!CHAIN_ORDERS.has(raw.order)) {
      throw new ConfigError(`${provider}/${id}: order must be "cost" or "speed", got ${JSON.stringify(raw.order)}`);
    }
    out.order = raw.order;
  }
  if (typeof raw.description === "string" && raw.description.trim()) out.description = raw.description.trim();
  for (const key of ["contextWindow", "maxTokens"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`${provider}/${id}: ${key} must be a positive integer`);
    }
    out[key] = value;
  }
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input) || raw.input.length === 0) {
      throw new ConfigError(`${provider}/${id}: input must be a non-empty array`);
    }
    for (const type of raw.input) {
      if (!INPUT_TYPES.has(type)) throw new ConfigError(`${provider}/${id}: unknown input type "${type}"`);
    }
    out.input = [...raw.input];
  }
  return out;
}

/**
 * Parses a router config document. Accepts `{virtuals: [...]}` or a bare array.
 * @param {unknown} doc
 */
export function parseConfig(doc) {
  const list = Array.isArray(doc) ? doc : doc && typeof doc === "object" ? doc.virtuals : undefined;
  if (!Array.isArray(list)) throw new ConfigError('config must contain a "virtuals" array');
  if (list.length === 0) throw new ConfigError('"virtuals" must not be empty');
  const out = list.map(normalizeVirtual);
  const keys = new Set();
  for (const v of out) {
    const key = `${v.provider}/${v.id}`;
    if (keys.has(key)) throw new ConfigError(`duplicate virtual model: ${key}`);
    keys.add(key);
  }
  return out;
}

/** Reads and parses a router config file. A missing file yields no virtual models. */
export function loadRouterConfig(path, { readFile = readFileSync } = {}) {
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON (${error.message})`);
  }
  return parseConfig(doc);
}
