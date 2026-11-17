/**
 * Keeps the Gentle Shell Channels card installed across Pi updates.
 *
 * Gentle Shell renders a closed list of rail sections, so the card lives inside
 * the `gentle-pi` package (see `patches/gentle-pi-channels`), and a package
 * update replaces those files. Pi documents no checksum or modified-file check
 * for installed packages, so nothing else notices the card is gone — the shell
 * simply paints one section fewer. This decision is pure so the recovery can be
 * tested without spawning a process or touching an install.
 */

/**
 * The reason a patch could not be applied: the first problem `apply.mjs` names,
 * not the banner above it, so a notification carries the moving part.
 *
 * @param {string} stderr
 * @returns {string}
 */
export function patchProblem(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const named = lines.find((line) => line.startsWith("- "));
  if (named) return named.slice(2).trim();
  return lines[0] ?? "unknown reason";
}

/** What the session start should say when the card is not on screen. */
export const CARD_MISSING_LABEL = "failover-router: the Channels card is not loaded";

/**
 * What a session start should do about the card.
 *
 * `idle` means nothing to say: the installed package carries the card. Every
 * other action carries the one line the human reads at startup, so a card that
 * silently disappeared becomes a visible, bounded problem instead.
 *
 * @param {object} outcome
 * @param {number|null|undefined} outcome.checkCode  exit code of `apply.mjs --check`
 * @param {number|null|undefined} [outcome.applyCode] exit code of the repair run
 * @param {string} [outcome.stderr] standard error of the repair run
 * @param {boolean} [outcome.scriptMissing] the patch directory is not where the extension expects it
 * @returns {{action: "idle"} | {action: "repaired"|"manual", message: string}}
 */
export function decidePatchAction({ checkCode, applyCode, stderr = "", scriptMissing = false }) {
  if (scriptMissing) {
    return { action: "manual", message: `${CARD_MISSING_LABEL} — the patch script is missing; see patches/gentle-pi-channels/README.md` };
  }
  if (checkCode === 0) return { action: "idle" };
  if (applyCode === 0) {
    return {
      action: "repaired",
      message: "failover-router: the Channels card was missing after an update and has been re-applied; /reload to paint it",
    };
  }
  return {
    action: "manual",
    message: `${CARD_MISSING_LABEL} — the patch no longer applies (${patchProblem(stderr)}); run node patches/gentle-pi-channels/apply.mjs`,
  };
}
