import "./no-network.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, loadConfig, saveConfig, ConfigError } from "../lib/config.js";

const VALID = { botToken: "123456:dummy-token", chatId: "123456789", allowedUsername: "MacDamon15" };

test("empty credentials disable delivery and the sole username is canonical", () => {
  assert.deepEqual(normalizeConfig({}), { botToken: "", chatId: "", allowedUsername: "MacDamon15" });
  assert.deepEqual(normalizeConfig({ ...VALID, allowedUsername: "@macdamon15" }), VALID);
});

test("rejects other users, groups, zero, and malformed credentials", () => {
  for (const patch of [{ allowedUsername: "OtherPerson" }, { chatId: "-10055" }, { chatId: "0" },
    { chatId: "@somebody" }, { chatId: {} }, { chatId: Number.MAX_SAFE_INTEGER + 1 },
    { botToken: "bad-token" }, { botToken: {} }, { allowedUsername: " " }]) {
    assert.throws(() => normalizeConfig({ ...VALID, ...patch }), ConfigError);
  }
});

test("malformed JSON errors never echo credential-like source", () => {
  const token = "123:dummy-secret";
  assert.throws(() => loadConfig("/bad", { readFile: () => "'" + token + "'" }), error => {
    assert.equal(error.message.includes(token), false);
    assert.match(error.message, /invalid JSON/i);
    return true;
  });
});

test("missing config disables delivery", () => {
  assert.equal(loadConfig("/missing", { readFile() { const error = new Error(); error.code = "ENOENT"; throw error; } }).botToken, "");
});

test("private config load/save and invalid save leave contents safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-config-"));
  const path = join(dir, "config.local.json");
  try {
    writeFileSync(path, JSON.stringify(VALID), { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.deepEqual(loadConfig(path), VALID);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const original = readFileSync(path, "utf8");
    assert.throws(() => saveConfig(path, { ...VALID, chatId: "-10055" }), ConfigError);
    assert.equal(readFileSync(path, "utf8"), original);
    saveConfig(path, VALID);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), VALID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
