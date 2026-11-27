import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageFiles } from "../scripts/package-files.mjs";

const audit = fileURLToPath(new URL("../scripts/audit-tarball.mjs", import.meta.url));
const manifest = JSON.stringify({ name: "opencode-failover-router", version: "0.1.0" });
const required = () => Object.fromEntries([...packageFiles].map(path => [`package/${path}`, path === "package.json" ? manifest : "safe fixture content\n"]));

async function archive(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(directory, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, contents);
  }
  const target = join(directory, "opencode-failover-router-0.1.0.tgz");
  execFileSync("tar", ["-czf", target, "package"], { cwd: directory });
  return target;
}

function run(path) {
  return spawnSync(process.execPath, [audit, path], { encoding: "utf8" });
}

test("audit accepts the allowlisted package and rejects private keys, tokens, and unshipped files", async t => {
  const work = await mkdtemp(join(tmpdir(), "opencode-audit-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const safe = await archive(join(work, "safe"), required());
  const accepted = run(safe);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, `OK: ${packageFiles.size} package files; allowlist and credential-pattern audit passed\n`);
  assert.equal(accepted.stderr, "");

  const privateKey = await archive(join(work, "private-key"), {
    ...required(),
    "package/index.js": "-----BEGIN PRIVATE KEY-----\nfixture-only-key\n-----END PRIVATE KEY-----\n",
  });
  const keyResult = run(privateKey);
  assert.equal(keyResult.status, 1);
  assert.equal(keyResult.stdout, "");
  assert.equal(keyResult.stderr, "Secret-like credential content in package/index.js: private-key-block\n");

  const accessToken = await archive(join(work, "token"), {
    ...required(),
    "package/index.js": `const token = "ghp_${"A".repeat(36)}";\n`,
  });
  const tokenResult = run(accessToken);
  assert.equal(tokenResult.status, 1);
  assert.equal(tokenResult.stdout, "");
  assert.equal(tokenResult.stderr, "Secret-like credential content in package/index.js: github-token\n");

  const envFile = await archive(join(work, "env-file"), { ...required(), "package/.env": "API_TOKEN=fixture\n" });
  const envResult = run(envFile);
  assert.equal(envResult.status, 1);
  assert.equal(envResult.stdout, "");
  assert.equal(envResult.stderr, "Unexpected package entry or non-regular file\n");
});
