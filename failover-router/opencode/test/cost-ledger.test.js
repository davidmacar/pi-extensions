import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateAttemptCost, normalizeUsage, createCostLedger } from "../src/cost-ledger.js";

const tariff = { price_currency: "CNY", input_price: 1, output_price: 4, effective_cache_read_price: 0.1, effective_cache_creation_price: 2 };

test("parses Chat and Responses usage without inventing missing counters", () => {
  assert.deepEqual(normalizeUsage("chat/completions", { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }),
    { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cacheWriteTokens: null });
  assert.deepEqual(normalizeUsage("responses", { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } }),
    { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cacheWriteTokens: null });
  assert.deepEqual(normalizeUsage("responses", undefined), { inputTokens: null, outputTokens: null, cachedReadTokens: null, cacheWriteTokens: null });
});

test("estimates total CNY per million billed tokens and records missing usage/rates as unknown", () => {
  const usage = normalizeUsage("chat/completions", { prompt_tokens: 1000, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 400 } });
  assert.deepEqual(estimateAttemptCost(usage, tariff), { status: "partial", currency: "CNY", amount: null, knownSubtotal: 0.00104, reason: "cache_write_tokens_missing", components: { input: null, cachedRead: 0.00004, cacheWrite: null, output: 0.001 } });
  assert.deepEqual(estimateAttemptCost(normalizeUsage("chat/completions", undefined), tariff), { status: "unknown", currency: "CNY", amount: null, reason: "usage_missing", components: null });
  assert.deepEqual(estimateAttemptCost(usage, undefined), { status: "unknown", currency: "CNY", amount: null, reason: "tariff_missing", components: null });
  assert.deepEqual(estimateAttemptCost({ ...usage, cachedReadTokens: 1200 }, tariff), { status: "unknown", currency: "CNY", amount: null, reason: "usage_inconsistent", components: null });
});

test("cache charges and missing applicable rates are handled explicitly", () => {
  const usage = { inputTokens: 100, outputTokens: 0, cachedReadTokens: 50, cacheWriteTokens: null };
  assert.deepEqual(estimateAttemptCost({ ...usage, cachedReadTokens: 50, cacheWriteTokens: 0 }, { price_currency: "USD", input_price: 1, output_price: 4, effective_cache_read_price: 0.1 }),
    { status: "estimated", currency: "CNY", amount: 0.000374, components: { input: 0.00034, cachedRead: 0.000034, cacheWrite: 0, output: 0 } });
  assert.deepEqual(estimateAttemptCost(usage, { price_currency: "USD", input_price: 1, effective_cache_creation_price_1h: 0.2 }),
    { status: "partial", currency: "CNY", amount: null, knownSubtotal: 0, reason: "cache_read_rate_missing,cache_write_tokens_missing", components: { input: null, cachedRead: null, cacheWrite: null, output: 0 } });
  const withTwoTiers = estimateAttemptCost({ ...usage, cacheWriteTokens: 10 }, { ...tariff, effective_cache_creation_price_1h: 3 });
  assert.equal(withTwoTiers.status, "partial");
  assert.equal(withTwoTiers.amount, null);
  assert.equal(withTwoTiers.reason, "cache_write_tier_unknown");
  assert.equal(withTwoTiers.knownSubtotal, 0.000045);
  assert.deepEqual(estimateAttemptCost(usage, { price_currency: "USD", input_price: 1 }),
    { status: "partial", currency: "CNY", amount: null, knownSubtotal: 0.00034, reason: "cache_read_rate_missing", components: { input: 0.00034, cachedRead: null, cacheWrite: 0, output: 0 } });
  assert.equal(estimateAttemptCost({ ...usage, cacheWriteTokens: 10 }, tariff).amount, 0.000065);
  assert.equal(estimateAttemptCost({ inputTokens: 1e9, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }, { price_currency: "USD", input_price: 1e9 }).reason, "amount_out_of_bounds");
});

test("appends only bounded per-attempt accounting fields to a private ledger", t => {
  const stateDir = mkdtempSync(join(tmpdir(), "gateway-cost-ledger-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = createCostLedger({ stateDir, now: () => 1234, requestId: "fixture-request" });
  ledger.record({ protocol: "chat/completions", requestedModel: "cheap", attempt: 1, channel: "subrouter-b", model: "m", statusCode: 429, outcome: "failed", failureKind: "rate_limit", usage: null, tariffs: undefined });
  ledger.record({ protocol: "chat/completions", requestedModel: "cheap", attempt: 2, channel: "subrouter-a", model: "m", statusCode: 200, outcome: "succeeded", usage: normalizeUsage("chat/completions", { prompt_tokens: 1000, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }), tariffs: { "subrouter-a/m": tariff } });
  ledger.close();
  const path = ledger.path;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { schema: 1, timestamp: 1234, requestId: "fixture-request", attempt: 1, protocol: "chat/completions", requestedModel: "cheap", channel: "subrouter-b", model: "m", statusCode: 429, outcome: "failed", failureKind: "rate_limit", usage: { inputTokens: null, outputTokens: null, cachedReadTokens: null, cacheWriteTokens: null }, tariff: null, cost: { status: "unknown", currency: "CNY", amount: null, reason: "usage_missing", components: null } });
  assert.equal(lines[1].cost.status, "estimated");
  assert.equal(lines[1].cost.amount, 0.002);
  assert.doesNotMatch(readFileSync(path, "utf8"), /prompt|secret|Authorization|messages/);
});

test("reopens a pre-existing ledger without copying unrelated contents", t => {
  const stateDir = mkdtempSync(join(tmpdir(), "gateway-cost-ledger-existing-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "cost-ledger.ndjson");
  writeFileSync(path, '{"unrelated":"fixture"}\\n', { mode: 0o600 });
  const ledger = createCostLedger({ stateDir });
  ledger.record({ protocol: "responses", requestedModel: "cheap", attempt: 1, channel: "subrouter-a", model: "m", statusCode: 200, outcome: "succeeded", usage: normalizeUsage("responses", { input_tokens: 1, output_tokens: 0 }), tariffs: { "subrouter-a/m": tariff } });
  ledger.close();
  const rows = readFileSync(path, "utf8").trimEnd().split("\\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0]), { unrelated: "fixture" });
  assert.equal(JSON.parse(rows[1]).cost.status, "partial");
  assert.equal(JSON.parse(rows[1]).cost.amount, null);
});


test("a symlink is rejected without changing an existing file", t => {
  const stateDir = mkdtempSync(join(tmpdir(), "gateway-cost-ledger-symlink-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const target = join(stateDir, "target");
  writeFileSync(target, "untouched", { mode: 0o644 });
  symlinkSync(target, join(stateDir, "cost-ledger.ndjson"));
  assert.throws(() => createCostLedger({ stateDir }));
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.equal(statSync(target).mode & 0o777, 0o644);
});
