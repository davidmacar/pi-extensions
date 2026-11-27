import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const tag = `opencode-v${manifest.version}`;
const name = `${manifest.name}-${manifest.version}.tgz`;
const run = (version, output) => spawnSync(process.execPath, [script, version, output], { encoding: "utf8", timeout: 15000 });

test("release tag must match the stable package version; valid artifacts are checksummed and never replaced", async t => {
  const work = await mkdtemp(join(tmpdir(), "opencode-release-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "release");
  for (const invalid of [`v${manifest.version}`, `${tag}-rc.1`, "opencode-v9999.0.0"]) {
    const result = run(invalid, output);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage: node scripts\/release\.mjs/);
    assert.deepEqual(await readdir(work), []);
  }
  const result = run(tag, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${join(output, name)}\n`);
  assert.deepEqual((await readdir(output)).sort(), [name, `${name}.sha256`]);
  const bytes = await readFile(join(output, name));
  const checksum = await readFile(join(output, `${name}.sha256`), "utf8");
  assert.equal(checksum, `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  const duplicate = run(tag, output);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, "");
  assert.match(duplicate.stderr, /already exists/);
  assert.deepEqual(await readFile(join(output, name)), bytes);
  assert.equal(await readFile(join(output, `${name}.sha256`), "utf8"), checksum);
});
