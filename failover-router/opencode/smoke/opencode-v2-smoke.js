import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startGateway } from "../src/server.js";

// Opt-in Linux smoke; requires Bubblewrap with network namespaces. Never fall
// back to running OpenCode with host networking or an inherited environment.
const scratchBase = "/tmp/opencode-failover-smoke";
const router = fileURLToPath(new URL("../..", import.meta.url));
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const keys = { LOCAL: "smoke-fake-local", primary: "smoke-fake-primary", backup: "smoke-fake-backup" };
const callID = "call_smoke_read";
const fixture = "SMOKE_FIXTURE_TOKEN_8f2c1d";
const finalText = "Fixture read successfully.";
const packageBase = "@opencode/ai/providers/openai-compatible";

function findBinary(command) {
  const paths = command.includes("/") ? [resolve(command)] :
    (process.env.PATH ?? env.PATH).split(delimiter).filter(Boolean).map(dir => resolve(dir, command));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Cannot find ${command}; set OPENCODE_BIN to the installed OpenCode v2.0.32 standalone binary`);
}

function command(binary, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"], ...options });
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timeout); fail(error); });
    child.once("close", (exitCode, signal) => { clearTimeout(timeout); done({ exitCode, signal, stdout, stderr }); });
  });
}

async function mock(t, handler) {
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      handler(request, response, JSON.parse(body));
    } catch (error) {
      errors.push(error);
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"malformed request: smoke assertion failed"}}');
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(done => server.close(done));
  });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, errors };
}

function sendSse(response, events, done = "") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map(event => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + done);
}

function chatStream(response, model, toolArgs) {
  const delta = toolArgs ? { tool_calls: [{ index: 0, id: callID, type: "function", function: { name: "read", arguments: toolArgs } }] } : { content: finalText };
  const header = { id: `chatcmpl_smoke_${toolArgs ? "read" : "final"}`, object: "chat.completion.chunk", created: 1, model };
  sendSse(response, [
    { ...header, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: toolArgs ? "tool_calls" : "stop" }] },
  ], "data: [DONE]\n\n");
}

function responsesStream(response, model, toolArgs) {
  const header = { id: `resp_smoke_${toolArgs ? "read" : "final"}`, object: "response", model };
  const part = { type: "output_text", text: finalText, annotations: [] };
  const item = toolArgs ? { id: "fc_smoke", type: "function_call", call_id: callID, name: "read", arguments: toolArgs } :
    { id: "msg_smoke", type: "message", role: "assistant", content: [part] };
  const position = { output_index: 0, item_id: item.id };
  sendSse(response, [
    { type: "response.created", response: { ...header, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(toolArgs ? { arguments: "" } : { content: [] }) } },
    toolArgs ? { type: "response.function_call_arguments.delta", ...position, delta: toolArgs } :
      { type: "response.output_text.delta", ...position, content_index: 0, delta: finalText },
    { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
    { type: "response.completed", response: { ...header, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
  ]);
}

function openCodeEnv(project, config) {
  const paths = Object.fromEntries(Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", TMPDIR: "tmp" }).map(([name, dir]) => [name, join(project, dir)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return { ...env, ...paths, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OTEL_SDK_DISABLED: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

async function smoke(t, protocol, scratch) {
  const chat = protocol === "chat/completions";
  const sdkPackage = chat ? packageBase : `${packageBase}/responses`;
  const model = chat ? "chat-local" : "responses-local";
  const project = join(scratch, model);
  mkdirSync(project);
  const filePath = join(project, "fixture.txt");
  writeFileSync(filePath, `${fixture}\n`);
  const attempts = [];
  const dispatch = (channel, answer) => (request, response, body) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, `/v1/${protocol}`);
    assert.equal(request.headers.authorization, `Bearer ${keys[channel]}`);
    assert.equal(body.model, `upstream-${channel}`);
    assert.equal(body.stream, true);
    if (!chat) {
      assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.conversation, undefined);
    }
    attempts.push(channel);
    answer(response, body);
  };
  const primary = await mock(t, dispatch("primary", (response, body) => {
    if (chat) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"message":"smoke rate limit","type":"rate_limit_error"}}');
      return;
    }
    // A completed tool item is not a completed generation. A truncated
    // attempt must not expose this tool call to the OpenCode client.
    const args = JSON.stringify({ path: filePath });
    const item = { id: "fc_truncated", type: "function_call", call_id: "call_truncated", name: "read", arguments: args };
    sendSse(response, [
      { type: "response.created", response: { id: "resp_truncated", model: body.model, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
    ]);
  }));
  const backup = await mock(t, dispatch("backup", (response, body) => {
    const stream = chat ? chatStream : responsesStream;
    if (attempts.length === 2) {
      assert.ok(body.tools.some(tool => (chat ? tool.function?.name : tool.name) === "read"));
      stream(response, body.model, JSON.stringify({ path: filePath }));
    } else {
      assert.equal(attempts.length, 3);
      const calls = chat ? body.messages.flatMap(message => message.tool_calls ?? []) : body.input.filter(item => item.type === "function_call");
      const results = chat ? body.messages.filter(message => message.role === "tool") : body.input.filter(item => item.type === "function_call_output");
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(chat ? calls[0].id : calls[0].call_id, callID);
      assert.equal(chat ? results[0].tool_call_id : results[0].call_id, callID);
      assert.ok(JSON.stringify(chat ? results[0].content : results[0].output).includes(fixture), "missing fixture token in the tool result");
      stream(response, body.model);
    }
  }));
  const gateway = await startGateway({ config: {
    apiKeyEnv: "LOCAL", attemptTimeoutMs: 3000,
    channels: { primary: { baseURL: primary.url, apiKeyEnv: "primary" }, backup: { baseURL: backup.url, apiKeyEnv: "backup" } },
    profiles: { [model]: { protocol, chain: ["primary", "backup"].map(channel => ({ channel, model: `upstream-${channel}` })) } },
  }, env: keys, port: 0 });
  t.after(() => gateway.close());
  const config = {
    update: "disable",
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
    providers: { smoke: { name: "Smoke gateway", package: sdkPackage, settings: { baseURL: `${gateway.url}/v1`, apiKey: keys.LOCAL, ...(chat ? {} : { store: false }) },
      models: { [model]: { name: model, capabilities: { tools: true }, limit: { context: 8192, output: 1024 } } } } },
  };
  const result = await command("/opencode", ["run", "--standalone", "--format", "json", "--model", `smoke/${model}`, "--title", "Failover smoke",
    "Read fixture.txt exactly once and report what happened."], { cwd: project, env: openCodeEnv(project, config), timeout: 8000 });
  t.diagnostic(JSON.stringify({ protocol, sdkPackage, attempts, ...result }));
  const mockErrors = [...primary.errors, ...backup.errors];
  assert.deepEqual(mockErrors.map(error => error.message), [], `${protocol} mock assertions`);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(attempts, ["primary", "backup", "backup"]);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "error").length, 0);
  const tools = events.filter(event => event.type === "tool_use");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].part.tool, "read");
  assert.equal(tools[0].part.state.status, "completed");
  assert.ok(JSON.stringify(tools[0].part.state.output).includes(fixture));
  assert.equal(events.filter(event => event.type === "text").map(event => event.part.text).join(""), finalText);
}

if (process.argv[2] === "--worker") {
  test("OpenCode v2.0.32 loopback failover", async t => {
    assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal), "requires loopback-only sandbox");
    const scratch = process.cwd();
    const version = await command("/opencode", ["--version"], { cwd: scratch, env: openCodeEnv(join(scratch, "version"), {}), timeout: 3000 });
    t.diagnostic(JSON.stringify({ version }));
    assert.equal(version.exitCode, 0);
    assert.equal(version.stdout.trim(), "opencode v2.0.32");
    await t.test("Chat", child => smoke(child, "chat/completions", scratch));
    await t.test("Responses", child => smoke(child, "responses", scratch));
  });
} else {
  test("native OpenCode Chat and Responses smoke (isolated)", async t => {
    const binary = findBinary(process.env.OPENCODE_BIN ?? "opencode");
    mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchBase, "run-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const result = await command("/usr/bin/bwrap", ["--die-with-parent", "--unshare-net", "--unshare-pid", "--unshare-ipc",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--ro-bind", router, "/router", "--ro-bind", binary, "/opencode",
      "--bind", scratch, "/tmp", "--chdir", "/tmp", "--setenv", "HOME", "/tmp", process.execPath,
      "/router/opencode/smoke/opencode-v2-smoke.js", "--worker"], { timeout: 23_000 });
    t.diagnostic(result.stdout.trimEnd());
    if (result.stderr) t.diagnostic(result.stderr.trimEnd());
    assert.equal(result.exitCode, 0, `sandbox failed (signal: ${result.signal ?? "none"})`);
  });
}
