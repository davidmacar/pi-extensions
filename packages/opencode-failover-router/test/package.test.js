import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const here = new URL("../", import.meta.url);

test("the extracted npm package owns one authenticated gateway until its last cleanup", async t => {
  const work = await mkdtemp(join(tmpdir(), "opencode-package-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const [{ filename, files }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: here, encoding: "utf8" }));
  assert.ok(files.some(file => file.path === "dist/index.js"));
  assert.ok(files.some(file => file.path === "index.js"));
  assert.ok(files.every(({ path }) => /^(?:index\.js$|dist\/|examples\/|README\.md$|package\.json$)/.test(path)));
  const destination = join(work, "unpacked");
  await mkdir(destination);
  execFileSync("tar", ["-xzf", join(work, filename), "-C", destination]);
  assert.deepEqual(await readdir(destination), ["package"]);
  const manifest = JSON.parse(await readFile(join(destination, "package", "package.json"), "utf8"));
  const { default: plugin } = await import(pathToFileURL(join(destination, "package", manifest.exports["."])).href);
  assert.equal(plugin.id, "opencode-failover-router");

  const probe = createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const path = join(work, "gateway.json");
  await writeFile(path, JSON.stringify({ listen: { port }, apiKeyEnv: "TEST_LOCAL", channels: {
    fixture: { baseURL: "https://fixture.invalid/v1", apiKeyEnv: "TEST_CHANNEL" },
  }, profiles: { demo: { chain: [{ channel: "fixture", model: "fixture-model" }] } } }));
  const url = `http://127.0.0.1:${port}`;
  const env = { FAILOVER_ROUTER_CONFIG: path, FAILOVER_ROUTER_STATE_DIR: join(work, "state"), TEST_LOCAL: "local-fixture", TEST_CHANNEL: "channel-fixture" };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const release = await Promise.all([plugin.setup(), plugin.setup()]);
  t.after(() => Promise.all(release.map(close => close())));
  const request = () => fetch(`${url}/v1/models`, { headers: { authorization: "Bearer local-fixture" } });
  const unauthorized = await fetch(`${url}/v1/models`);
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  await release[0]();
  await release[0](); // Idempotent cleanup must not drop the other lease.
  const models = await request();
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map(model => model.id), ["demo"]);
  await release[1]();
  await assert.rejects(request());
  const restarted = await plugin.setup();
  try { assert.equal((await request()).status, 200); } finally { await restarted(); }
});
