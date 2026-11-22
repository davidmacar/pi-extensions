import "./no-network.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import telegramWaitNotifier from "../index.js";

const PROMPT_KIND = "respuesta a preguntas del agente";
const SETTLED_KIND = "terminación de las acciones del agente";

const CONFIG = { botToken: "123:dummy", chatId: "42", allowedUsername: "MacDamon15" };
const CHAT = { id: 42, type: "private", username: "MacDamon15" };
const start = (chat = CHAT, from = { id: 42, username: "MacDamon15", is_bot: false }) =>
  ({ update_id: 10, message: { text: "/start", chat, from } });

function taskBus(tasks = []) {
  const emitter = new EventEmitter();
  emitter.on("gentle-pi:herdr-desktop:tasks-request", ({ sessionId }) =>
    emitter.emit("gentle-pi:herdr-desktop:tasks", { sessionId, tasks }));
  return { emit: (name, data) => emitter.emit(name, data),
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); } };
}

function host({ config = CONFIG, updates = [], chat = CHAT, failSend = false, tools = [], bus = taskBus() } = {}) {
  const events = new Map(); const commands = new Map(); const sent = []; const saved = []; const ui = [];
  let readCount = 0;
  const ctx = { mode: "tui", hasUI: true, cwd: "/repo/pi", isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getSessionName: () => "sesión actual" },
    ui: { notify: (...args) => ui.push(args) } };
  const pi = { on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command), getAllTools: () => tools, events: bus };
  telegramWaitNotifier(pi, {
    readConfig: () => { readCount++; return config; },
    persistConfig: (_path, value) => saved.push(value),
    makeClient: () => ({ getUpdates: async () => updates, getChat: async () => chat,
      sendMessage: async (id, text) => { if (failSend) throw new Error("dummy send failure"); sent.push({ id, text }); } }),
  });
  return { events, commands, sent, saved, ui, ctx, config,
    fire: (name, event = {}, context = ctx) => events.get(name)?.(event, context),
    command: action => commands.get("telegram-notifier").handler(action, ctx),
    reads: () => readCount };
}

test("factory starts no resources and empty config makes no requests", async () => {
  const h = host({ config: {} }); assert.equal(h.reads(), 0);
  await h.fire("session_start"); await h.fire("agent_settled", { aborted: false });
  assert.equal(h.sent.length, 0); assert.equal(h.saved.length, 0);
});

test("settled notices contain no assistant text; abort, busy and child modes stay silent", async () => {
  const h = host(); await h.fire("session_start"); await h.fire("agent_start");
  assert.equal(h.events.has("agent_end"), false);
  await h.fire("agent_settled", { aborted: false, text: "PRIVATE OUTPUT" });
  assert.equal(h.sent.length, 1); assert.doesNotMatch(h.sent[0].text, /PRIVATE OUTPUT/);
  assert.match(h.sent[0].text, /🧩 Sesión: sesión actual/);
  assert.match(h.sent[0].text, /📁 Ruta: \/repo\/pi/);
  assert.match(h.sent[0].text, new RegExp(`📝 Input esperado: ${SETTLED_KIND}`));
  await h.fire("agent_settled", { aborted: true });
  await h.fire("agent_settled", {}, { ...h.ctx, isIdle: () => false });
  await h.fire("agent_settled", {}, { ...h.ctx, mode: "json", hasUI: false });
  assert.equal(h.sent.length, 1);
});

test("a prompt and the subsequent completion both notify; open prompts suppress idle duplicates", async () => {
  const h = host(); await h.fire("session_start"); await h.fire("agent_start");
  await h.fire("ui_prompt_start", { kind: "confirm", title: "PRIVATE TITLE" });
  assert.match(h.sent[0].text, /🧩 Sesión: sesión actual/);
  assert.match(h.sent[0].text, /📁 Ruta: \/repo\/pi/);
  assert.match(h.sent[0].text, new RegExp(`📝 Input esperado: ${PROMPT_KIND}`));
  await h.fire("agent_settled", {}); assert.equal(h.sent.length, 1);
  await h.fire("ui_prompt_end"); await h.fire("agent_settled", {});
  assert.equal(h.sent.length, 2); assert.doesNotMatch(h.sent[0].text, /PRIVATE TITLE/);
});

test("renames are reflected and a manager without getSessionName cannot break notices", async () => {
  const h = host(); await h.fire("session_start");
  h.ctx.sessionManager.getSessionName = () => "renombrada";
  await h.fire("ui_prompt_start", {});
  assert.match(h.sent[0].text, /🧩 Sesión: renombrada/);

  const noName = host(); noName.ctx.sessionManager = { getSessionId: () => "parent" };
  await noName.fire("session_start"); await noName.fire("agent_settled", {});
  assert.match(noName.sent[0].text, /🧩 Sesión: sin nombre/);
});

test("send-time identity check prevents delivery to a group or another user", async () => {
  for (const chat of [{ ...CHAT, type: "group" }, { ...CHAT, username: "OtherPerson" }, { ...CHAT, id: 99 }]) {
    const h = host({ chat }); await h.fire("session_start"); await h.fire("agent_settled", {});
    assert.equal(h.sent.length, 0);
  }
});

test("setup rejects strangers, groups, forwarded starts and mismatched sender IDs without storing or sending", async () => {
  const fixtures = [start(CHAT, { id: 42, username: "OtherPerson" }), start({ ...CHAT, type: "group" }),
    start(CHAT, { id: 99, username: "MacDamon15" }),
    { ...start(), message: { ...start().message, forward_origin: { type: "user" } } }];
  for (const update of fixtures) {
    const h = host({ config: { ...CONFIG, chatId: "" }, updates: [update] }); await h.fire("session_start"); await h.command("setup");
    assert.equal(h.saved.length, 0); assert.equal(h.sent.length, 0);
  }
});

test("setup pins the verified private chat and leaves an existing binding intact on failure", async () => {
  const h = host({ config: { ...CONFIG, chatId: "" }, updates: [start()] });
  await h.fire("session_start"); await h.command("setup"); assert.equal(h.saved.length, 1);
  assert.match(h.sent[0].text, /activados/);
  assert.doesNotMatch(h.sent[0].text, /Tipo de input esperado/); assert.equal(h.saved[0].chatId, "42");
  assert.equal(h.sent.length, 1);
  const failed = host(); await failed.fire("session_start"); await failed.command("setup");
  await failed.fire("agent_settled", {}); assert.equal(failed.saved.length, 0); assert.equal(failed.sent.length, 1);
});

test("unknown background subagent state suppresses completion but not input notices", async () => {
  const h = host({ tools: [{ name: "subagent_run" }], bus: null }); await h.fire("session_start");
  await h.fire("agent_settled", {}); assert.equal(h.sent.length, 0);
  await h.fire("ui_prompt_start", {}); assert.equal(h.sent.length, 1);
  assert.ok(h.ui.some(([text]) => /subagent/i.test(text)));
});

test("completion consults active child state even without a recognized spawner tool", async () => {
  for (const tools of [[{ name: "codemode" }], [{ name: "read" }], []]) {
    for (const status of ["queued", "running", "waiting"]) {
      const emitter = new EventEmitter(); let tasks = [{ status }]; let requests = 0;
      const bus = { emit: (name, data) => emitter.emit(name, data),
        on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); } };
      emitter.on("gentle-pi:herdr-desktop:tasks-request", ({ sessionId }) => {
        requests++; emitter.emit("gentle-pi:herdr-desktop:tasks", { sessionId, tasks });
      });
      const h = host({ tools, bus }); await h.fire("session_start");
      await h.fire("agent_settled", {});
      assert.equal(h.sent.length, 0, "Delegated work must suppress completion");
      assert.equal(requests, 1, "Completion must request a fresh task snapshot");
      assert.equal(h.saved.length, 0); assert.deepEqual(h.config, CONFIG);
      await h.fire("ui_prompt_start", { kind: "confirm" });
      assert.equal(h.sent.length, 1); assert.match(h.sent[0].text, new RegExp(PROMPT_KIND));
      assert.equal(requests, 1, "Question notices must remain independent of child activity");
      await h.fire("ui_prompt_end"); tasks = [];
      await h.fire("agent_settled", {});
      assert.equal(h.sent.length, 2); assert.match(h.sent[1].text, new RegExp(SETTLED_KIND));
      assert.equal(requests, 3, "Completion rechecks the empty snapshot before sending");
      await h.fire("agent_settled", {}); assert.equal(h.sent.length, 2);
      await h.fire("session_shutdown");
    }
  }
});

test("missing publisher suppresses completion even with no recognized spawner", async () => {
  const h = host({ tools: [{ name: "read" }], bus: null }); await h.fire("session_start");
  await h.fire("agent_settled", {}); assert.equal(h.sent.length, 0);
  assert.ok(h.ui.some(([text]) => /subagents cannot be confirmed/.test(text)));
  await h.fire("ui_prompt_start", {});
  assert.equal(h.sent.length, 1); assert.match(h.sent[0].text, new RegExp(PROMPT_KIND));
  assert.equal(h.saved.length, 0); assert.deepEqual(h.config, CONFIG);
});

test("Gentle active tasks suppress completion until a fresh empty snapshot arrives", async () => {
  const emitter = new EventEmitter(); let tasks = [{ status: "running" }];
  const bus = { emit: (n, data) => emitter.emit(n, data), on(n, fn) { emitter.on(n, fn); return () => emitter.off(n, fn); } };
  emitter.on("gentle-pi:herdr-desktop:tasks-request", ({ sessionId }) => {
    emitter.emit("gentle-pi:herdr-desktop:tasks", { sessionId, tasks });
  });
  const h = host({ tools: [{ name: "subagent_run" }], bus }); await h.fire("session_start");
  await h.fire("agent_settled", {}); assert.equal(h.sent.length, 0);
  tasks = [{ status: "waiting" }]; await h.fire("agent_settled", {}); assert.equal(h.sent.length, 0);
  tasks = []; await h.fire("agent_settled", {}); assert.equal(h.sent.length, 1);
  await h.fire("agent_settled", {}); assert.equal(h.sent.length, 1);
});

test("a subagent that starts during chat verification suppresses the pending completion notice", async () => {
  const emitter = new EventEmitter(); const sent = []; let tasks = [];
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "parent" }, ui: { notify() {} } };
  const events = new Map();
  const bus = { emit: (n, data) => emitter.emit(n, data), on(n, fn) { emitter.on(n, fn); return () => emitter.off(n, fn); } };
  emitter.on("gentle-pi:herdr-desktop:tasks-request", ({ sessionId }) => emitter.emit("gentle-pi:herdr-desktop:tasks", { sessionId, tasks }));
  telegramWaitNotifier({ on: (n, f) => events.set(n, f), registerCommand() {}, events: bus, getAllTools: () => [{ name: "subagent_run" }] }, {
    readConfig: () => CONFIG, makeClient: () => ({
      getChat: async () => { tasks = [{ status: "running" }]; return CHAT; },
      sendMessage: async (_id, text) => sent.push(text),
    }),
  });
  await events.get("session_start")({}, ctx); await events.get("agent_settled")({}, ctx);
  assert.equal(sent.length, 0);
});

test("task labels, prompts, titles, and agent text never leave Pi", async () => {
  const emitter = new EventEmitter(); let tasks = [{ status: "running", label: "PRIVATE TASK LABEL", prompt: "PRIVATE TASK PROMPT" }];
  const bus = { emit: (n, data) => emitter.emit(n, data), on(n, fn) { emitter.on(n, fn); return () => emitter.off(n, fn); } };
  emitter.on("gentle-pi:herdr-desktop:tasks-request", ({ sessionId }) => emitter.emit("gentle-pi:herdr-desktop:tasks", { sessionId, tasks }));
  const h = host({ tools: [{ name: "subagent_run" }], bus }); await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("ui_prompt_start", { kind: "question", title: "PRIVATE PROMPT TITLE", message: "PRIVATE PROMPT BODY" });
  tasks = []; await h.fire("ui_prompt_end"); await h.fire("agent_settled", { text: "PRIVATE AGENT TEXT" });
  assert.equal(h.sent.length, 2);
  for (const { text } of h.sent) assert.doesNotMatch(text, /PRIVATE (?:TASK LABEL|TASK PROMPT|PROMPT TITLE|PROMPT BODY|AGENT TEXT)/);
});

test("setup storage failure preserves the existing working binding and reports failure", async () => {
  const events = new Map(); const commands = new Map(); const sent = []; const messages = [];
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "parent" }, ui: { notify: text => messages.push(text) } };
  telegramWaitNotifier({ on: (n, f) => events.set(n, f), registerCommand: (n, c) => commands.set(n, c), getAllTools: () => [], events: taskBus() }, {
    readConfig: () => CONFIG, persistConfig() { throw new Error("dummy write failed"); },
    makeClient: () => ({ getUpdates: async () => [start()], getChat: async () => CHAT,
      sendMessage: async (_id, text) => sent.push(text) }),
  });
  await events.get("session_start")({}, ctx);
  await commands.get("telegram-notifier").handler("setup", ctx);
  assert.equal(sent.length, 0); assert.ok(messages.some(text => /setup failed/i.test(text)));
  await events.get("agent_settled")({}, ctx); assert.equal(sent.length, 1);
});

test("completed prompts and resumed work do not receive a stale wait notice", async () => {
  const events = new Map(); const sent = []; let resolveChat;
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "parent" }, ui: { notify() {} } };
  telegramWaitNotifier({ on: (n, f) => events.set(n, f), registerCommand() {}, getAllTools: () => [], events: taskBus() }, {
    readConfig: () => CONFIG, makeClient: () => ({ getChat: () => new Promise(resolve => { resolveChat = resolve; }),
      sendMessage: async (_id, text) => sent.push(text) }),
  });
  await events.get("session_start")({}, ctx);
  const notice = events.get("ui_prompt_start")({}, ctx);
  events.get("ui_prompt_end")(); resolveChat(CHAT); await notice;
  assert.equal(sent.length, 0);
  const settled = events.get("agent_settled")({}, ctx);
  ctx.isIdle = () => false; resolveChat(CHAT); await settled;
  assert.equal(sent.length, 0);
});

test("delivery failure is visible locally and shutdown prevents subsequent sends", async () => {
  const h = host({ failSend: true }); await h.fire("session_start"); await h.fire("agent_settled", {});
  assert.ok(h.ui.some(([text]) => /failed/i.test(text)));
  const stopped = host(); await stopped.fire("session_start"); await stopped.fire("session_shutdown");
  await stopped.fire("agent_settled", {}); assert.equal(stopped.sent.length, 0);
});
