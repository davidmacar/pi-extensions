import test from "node:test";
import assert from "node:assert/strict";
import { startGateway } from "../src/server.js";

const env = { LOCAL: "fixture-local", REMOTE: "fixture-upstream" };
const config = { apiKeyEnv: "LOCAL", channels: { a: { baseURL: "https://provider.invalid/v1", apiKeyEnv: "REMOTE" } }, profiles: { cheap: { chain: [{ channel: "a", model: "m" }] } } };
const headers = { authorization: `Bearer ${env.LOCAL}`, "content-type": "application/json" };

test("HTTP boundary enforces auth, exact paths and method before dispatch", async t => {
  let calls = 0;
  const gw = await startGateway({ config, env, port: 0, fetchImpl: async (target, options) => {
    ++calls;
    assert.equal(target, "https://provider.invalid/v1/chat/completions");
    assert.equal(options.headers.authorization, "Bearer fixture-upstream");
    assert.equal(options.headers.cookie, undefined);
    return Response.json({ id: "success" });
  } });
  t.after(() => gw.close());
  const body = '{"model":"cheap"}';
  for (const [path, method, requestHeaders, status] of [
    ["/v1/chat/completions?extra=1", "POST", headers, 404],
    ["/v1/chat/completions", "GET", headers, 405],
    ["/v1/chat/completions", "POST", {}, 401],
    ["/v1/models", "GET", {}, 401],
  ]) {
    const result = await fetch(gw.url + path, { method, headers: requestHeaders, body: method === "POST" ? body : undefined });
    assert.equal(result.status, status);
    await result.json();
    assert.equal(calls, 0);
  }
  const models = await fetch(`${gw.url}/v1/models`, { headers });
  assert.deepEqual((await models.json()).data.map(item => item.id), ["cheap"]);
  const success = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { ...headers, cookie: "client=fixture" }, body });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { id: "success" });
  assert.equal(calls, 1);
});

test("closing the gateway aborts active provider work without retrying", { timeout: 3000 }, async t => {
  const started = Promise.withResolvers(); const aborted = Promise.withResolvers();
  let attempts = 0;
  const gw = await startGateway({ config, env, port: 0, fetchImpl: async (_target, { signal }) => {
    ++attempts; started.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => {
      aborted.resolve(); reject(signal.reason);
    }, { once: true }));
  } });
  t.after(() => gw.close());
  const client = fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers, body: '{"model":"cheap"}' }).catch(error => error);
  await started.promise;
  await gw.close();
  await aborted.promise;
  assert.ok(await client instanceof Error);
  assert.equal(attempts, 1);
});
