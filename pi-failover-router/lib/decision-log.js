import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** One rotation, so a very long session cannot grow the log without a bound. */
const MAX_BYTES = 512 * 1024;

/**
 * Persists routing decisions to a file.
 *
 * `pi.log` is the normal channel, but this runtime does not write it anywhere a
 * later session can read, so a failure that this extension failed to handle
 * leaves no trace of what it decided. That gap forced a diagnosis to be made
 * from session transcripts alone, which cannot show whether the takeover fired.
 *
 * Nothing here may break routing: a log that cannot be written is dropped.
 *
 * @param {object} options
 * @param {string | undefined} options.path
 * @param {number} [options.maxBytes]
 * @param {() => Date} [options.now]
 * @returns {(message: string) => void}
 */
export function createDecisionLog({ path, maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  if (!path) return () => {};
  return (message) => {
    try {
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      } catch {
        // Missing file on the first write is the normal case.
      }
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${now().toISOString()} ${message}\n`);
    } catch {
      // A decision that cannot be logged must still be made.
    }
  };
}
