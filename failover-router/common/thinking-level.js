/**
 * Which reasoning level may be sent to a provider.
 *
 * `off` and `minimal` are not part of the contract these channels honour. A
 * channel that refuses them answers 400 with
 * `does not support reasoning effort "none"; use low, medium, high, xhigh or max`,
 * and the request is lost. So the router never sends them, whatever a catalog
 * mapping claims: `thinkingLevelMap` is configuration, and configuration can be
 * wrong for the deployment behind it.
 *
 * The full scale is kept for one purpose only: to pick the *nearest* level a
 * model really supports when the requested one is not available.
 */
export const THINKING_SCALE = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The levels a provider may actually receive. */
export const ADMISSIBLE_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * @param {unknown} level
 * @returns {boolean}
 */
export function isAdmissible(level) {
  return typeof level === "string" && ADMISSIBLE_LEVELS.includes(level);
}

/**
 * The admissible levels a model declares it supports.
 *
 * A missing map is treated as "supports everything admissible": an unknown
 * catalog is not evidence of a refusal, and dropping the level entirely would
 * silently change what the caller asked for.
 *
 * @param {{thinkingLevelMap?: Record<string, unknown>} | undefined} model
 * @returns {string[]}
 */
export function supportedLevels(model) {
  const map = model?.thinkingLevelMap;
  if (!map || typeof map !== "object") return [...ADMISSIBLE_LEVELS];
  return ADMISSIBLE_LEVELS.filter((level) => map[level] != null);
}

/**
 * The level to send to `model` for a caller that asked for `requested`.
 *
 * Returns `undefined` when nothing may be sent, so the caller omits the field
 * instead of sending an effort the channel will refuse.
 *
 * @param {{thinkingLevelMap?: Record<string, unknown>} | undefined} model
 * @param {string | undefined | null} requested
 * @returns {string | undefined}
 */
export function resolveLevel(model, requested) {
  if (!requested) return undefined;
  const supported = supportedLevels(model);
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;

  // Nearest supported level, measured on the full scale so "off" lands on the
  // cheapest level that works and "max" degrades to the highest one available.
  const asked = THINKING_SCALE.indexOf(requested);
  const from = asked < 1 ? 1 : asked;
  let best = supported[0];
  let bestDistance = Infinity;
  for (const level of supported) {
    const distance = Math.abs(THINKING_SCALE.indexOf(level) - from);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

/** The levels a virtual model offers when its configuration leaves none usable. */
export const DEFAULT_LEVELS = ["low", "medium", "high"];
