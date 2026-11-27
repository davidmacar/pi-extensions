/** One initial pass and three repeats per consecutive provider-failure episode. */
export const MAX_CHAIN_REPEATS = 3;

/** Physical models get three attempts in each of three groups. */
export const PHYSICAL_ATTEMPTS_PER_GROUP = 3;
export const PHYSICAL_GROUPS = 3;
export const MAX_PHYSICAL_ATTEMPTS = PHYSICAL_ATTEMPTS_PER_GROUP * PHYSICAL_GROUPS;
export const PHYSICAL_GROUP_WAIT_MS = 5 * 60_000;

/**
 * State is plain JSON so Pi can persist it with the virtual route. A successful
 * assistant response closes the episode; tool execution is never replayed here.
 */
export function newRecovery() {
  return {
    version: 1,
    pass: 0,
    visited: [],
    last: null,
    failureKey: null,
    pending: null,
    exhausted: false,
    error: "",
    seenFailures: [],
    stopped: false,
  };
}

/** Decide once per failed dispatch; the caller owns cooldown bookkeeping. */
export function planRecovery(state, chain, failedModel, error, failureKey) {
  if (state.failureKey === failureKey) return false;
  state.failureKey = failureKey;
  state.error = error;
  state.pending = null;
  if (!state.visited.includes(failedModel)) state.visited.push(failedModel);
  let candidates = chain.filter(step => !state.visited.includes(step.model));
  let pass = state.pass;
  if (candidates.length === 0 && pass < MAX_CHAIN_REPEATS) {
    pass++;
    candidates = chain;
  }
  if (candidates.length === 0) {
    state.exhausted = true;
  } else {
    // Keep order stable within a pass, even when speed measurements refresh.
    state.pending = { step: candidates[0], pass };
  }
  return true;
}

/** Advance only when the next request is actually dispatched, never on a notice. */
export function dispatchRecovery(state, step, pass = state.pass) {
  if (pass !== state.pass) state.visited = [];
  state.pass = pass;
  if (!state.visited.includes(step.model)) state.visited.push(step.model);
  state.last = step.model;
  state.pending = null;
}

/** Abortable timer: no poll, no blocking sleep, and no leftover abort listeners. */
export function waitForCooldown(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Plain state for recovery of one directly selected physical model. */
export function newPhysicalRecovery() {
  return {
    version: 1,
    attempts: 0,
    failureKey: null,
    error: "",
    exhausted: false,
    stopped: false,
    markerAttempt: 0,
  };
}

/** Count one physical failure, once per assistant message identity. */
export function planPhysicalRecovery(state, error, failureKey) {
  if (state.failureKey === failureKey || state.exhausted || state.stopped) return false;
  state.failureKey = failureKey;
  state.error = error;
  state.attempts++;
  if (state.attempts >= MAX_PHYSICAL_ATTEMPTS) state.exhausted = true;
  return true;
}

/** The exact two five-minute gaps follow attempts 3 and 6. */
export function physicalWaitMs(attempts) {
  return attempts > 0 && attempts < MAX_PHYSICAL_ATTEMPTS && attempts % PHYSICAL_ATTEMPTS_PER_GROUP === 0
    ? PHYSICAL_GROUP_WAIT_MS
    : 0;
}
