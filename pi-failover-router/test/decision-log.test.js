import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDecisionLog } from "../lib/decision-log.js";

const at = () => new Date("2026-11-17T09:19:53.000Z");

test("a decision is appended with its time, and appends do not overwrite", () => {
  const path = join(tmpdir(), `decision-log-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const log = createDecisionLog({ path, now: at });
  log("first");
  log("second");
  assert.equal(
    readFileSync(path, "utf8"),
    "2026-11-17T09:19:53.000Z first\n2026-11-17T09:19:53.000Z second\n",
  );
});

test("a full log is rotated instead of growing without a bound", () => {
  const path = join(tmpdir(), `decision-log-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(path, "x".repeat(2048));
  createDecisionLog({ path, maxBytes: 1024, now: at })("after rotation");
  assert.equal(readFileSync(`${path}.1`, "utf8").length, 2048);
  assert.equal(readFileSync(path, "utf8"), "2026-11-17T09:19:53.000Z after rotation\n");
});

test("an unwritable log never breaks the caller", () => {
  // A regular file where a directory would be needed: the write fails with
  // ENOTDIR at once. This used to point at `/proc/denied`, where `mkdirSync`
  // with `recursive: true` spins for minutes on this kernel and hung the suite.
  const blocker = join(tmpdir(), `decision-log-blocker-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(blocker, "");
  const log = createDecisionLog({ path: join(blocker, "nested", "failover.log"), now: at });
  assert.doesNotThrow(() => log("decision still made"));
});

test("no path means no logging at all", () => {
  const log = createDecisionLog({});
  assert.doesNotThrow(() => log("ignored"));
});
