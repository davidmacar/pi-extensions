/**
 * Identity of the code a running Pi process actually loaded.
 *
 * Pi extensions live in a long-running process: after an edit, the question
 * "is this session running the fix?" has no answer from the outside, and a
 * decision log that looks like the old behaviour is indistinguishable from the
 * old code. Every load therefore announces a stamp derived from the sources
 * themselves, so a stale process is visible instead of assumed.
 *
 * The stamp is a hash of the entry file plus every module in `lib/`: editing a
 * rule, a chain helper or the router itself changes it without anyone having to
 * remember to bump a constant.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "index.js");

/**
 * @param {{readFile?: (path: string) => string, readDir?: (path: string) => string[]}} [deps]
 * @returns {string} short stable id, or "unknown" when the sources are unreadable
 */
export function buildStamp(deps = {}) {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const readDir = deps.readDir ?? ((path) => readdirSync(path));
  try {
    const files = [ENTRY, ...readDir(HERE).filter((name) => name.endsWith(".js")).sort().map((name) => join(HERE, name))];
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.slice(HERE.length));
      hash.update("\0");
      hash.update(readFile(file));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 8);
  } catch {
    return "unknown";
  }
}
