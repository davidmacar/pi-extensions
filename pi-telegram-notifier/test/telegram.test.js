import "./no-network.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramClient, TELEGRAM_TEXT_LIMIT } from "../lib/telegram.js";

const response = result => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

test("sends a plain fixed notice to one chat; rejects oversize messages and groups", async () => {
  const requests = [];
  const client = createTelegramClient({ token: "123:dummy", fetchImpl: async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) }); return response({ message_id: 5 });
  } });
  assert.deepEqual(await client.sendMessage("42", "hello"), { message_id: 5 });
  assert.equal(requests[0].url, "https://api.telegram.org/bot123:dummy/sendMessage");
  assert.deepEqual(requests[0].body, { chat_id: "42", text: "hello" });
  assert.equal(requests[0].init.redirect, "error");
  assert.throws(() => client.sendMessage("42", "x".repeat(TELEGRAM_TEXT_LIMIT + 1)), /limit/);
  assert.throws(() => client.sendMessage("-10055", "hi"), /private/);
  assert.equal(requests.length, 1);
});

test("getChat validates identity and getUpdates is setup-only short polling without a destructive offset", async () => {
  const requests = [];
  const client = createTelegramClient({ token: "123:dummy", fetchImpl: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) }); return response([]);
  } });
  await client.getChat("42"); await client.getUpdates();
  assert.deepEqual(requests.map(r => r.body), [{ chat_id: "42" }, { timeout: 0, limit: 100, allowed_updates: ["message"] }]);
});

test("API, malformed response and network errors cannot expose token or response body", async () => {
  const token = "123:dummy-private";
  const fakes = [async () => { throw new Error("https://api.telegram.org/bot" + token); },
    async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: token }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(token); } })];
  for (const fetchImpl of fakes) {
    const client = createTelegramClient({ token, fetchImpl });
    await assert.rejects(client.sendMessage("42", "hi"), error => !error.message.includes(token));
  }
});

test("requests carry an abort signal and invalid tokens never reach transport", async () => {
  let signal;
  const client = createTelegramClient({ token: "123:dummy", fetchImpl: async (_url, init) => { signal = init.signal; return response(true); } });
  await client.getChat("42"); assert.equal(signal instanceof AbortSignal, true);
  assert.throws(() => createTelegramClient({ token: "" }), /not configured/);
});
