import { test } from "node:test";
import assert from "node:assert/strict";

import { CARD_MISSING_LABEL, decidePatchAction, patchProblem } from "../lib/patch-guard.js";

test("an installed card asks for nothing", () => {
  assert.deepEqual(decidePatchAction({ checkCode: 0, applyCode: undefined, stderr: "" }), { action: "idle" });
});

test("a wiped card is repaired and says a reload is what paints it", () => {
  const decision = decidePatchAction({ checkCode: 1, applyCode: 0, stderr: "" });
  assert.equal(decision.action, "repaired");
  assert.match(decision.message, /re-applied/);
  assert.match(decision.message, /reload/);
});

test("an anchor that moved upstream is reported, never half-patched silently", () => {
  const decision = decidePatchAction({
    checkCode: 1,
    applyCode: 1,
    stderr: "apply: 1 problem(s), the package no longer matches this patch:\n  - lib/shell-bar.ts: import the Channels renderer\n",
  });
  assert.equal(decision.action, "manual");
  assert.match(decision.message, /lib\/shell-bar\.ts: import the Channels renderer/);
});

test("a missing patch script says the card is not loaded, and where to look", () => {
  const decision = decidePatchAction({ checkCode: null, scriptMissing: true });
  assert.equal(decision.action, "manual");
  assert.ok(decision.message.startsWith(CARD_MISSING_LABEL), "the startup line names the missing card first");
  assert.match(decision.message, /patch script is missing/);
});

test("a repair that cannot run reports the card as not loaded, never as repaired", () => {
  const decision = decidePatchAction({ checkCode: 1, applyCode: null, stderr: "spawn node ENOENT" });
  assert.equal(decision.action, "manual");
  assert.ok(decision.message.startsWith(CARD_MISSING_LABEL));
  assert.match(decision.message, /spawn node ENOENT/);
});

test("the first named problem is the one reported, without the noisy banner", () => {
  assert.equal(patchProblem("apply: 2 problem(s):\n  - a.ts: first\n  - b.ts: second\n"), "a.ts: first");
  assert.equal(patchProblem("boom: the script crashed\n"), "boom: the script crashed");
  assert.equal(patchProblem(""), "unknown reason");
});
