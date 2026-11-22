import "./no-network.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { activeSubagents } from "../lib/subagents.js";

const TASKS = "gentle-pi:herdr-desktop:tasks";
const REQUEST = "gentle-pi:herdr-desktop:tasks-request";
const ctx = { sessionManager: { getSessionId: () => "parent" } };
const eventsFor = emitter => ({ emit: (name, data) => emitter.emit(name, data),
  on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); } });

function fixture(snapshot) {
  const emitter = new EventEmitter();
  emitter.on(REQUEST, request => emitter.emit(TASKS, typeof snapshot === "function" ? snapshot(request) : snapshot));
  return { emitter, pi: { events: eventsFor(emitter), getAllTools: () => [{ name: "subagent_run" }] } };
}

test("missing task publishers never establish zero active children", () => {
  assert.equal(activeSubagents({ getAllTools: () => [{ name: "read" }] }, ctx), undefined);
  assert.equal(activeSubagents({}, ctx), undefined);
  assert.equal(activeSubagents({ getAllTools: () => [{ name: "subagent_run" }] }, ctx), undefined);
});

test("snapshots are consulted regardless of the registered tool names", () => {
  for (const tools of [[{ name: "codemode" }], [{ name: "read" }], []]) {
    const h = fixture({ sessionId: "parent", tasks: [{ status: "running" }] });
    h.pi.getAllTools = () => tools;
    assert.equal(activeSubagents(h.pi, ctx), 1);
    assert.equal(h.emitter.listenerCount(TASKS), 0);
  }
  const h = fixture({ sessionId: "parent", tasks: [] });
  h.pi.getAllTools = () => { throw new Error("Tool registry must not be queried"); };
  assert.equal(activeSubagents(h.pi, ctx), 0);
  delete h.pi.getAllTools;
  assert.equal(activeSubagents(h.pi, ctx), 0);
});

test("Gentle snapshots count queued, running and waiting as active, with listener cleanup", () => {
  const h = fixture(({ sessionId }) => ({ sessionId, tasks: ["queued", "running", "waiting"].map(status => ({ status })) }));
  assert.equal(activeSubagents(h.pi, ctx), 3);
  assert.equal(h.emitter.listenerCount(TASKS), 0);
  const empty = fixture({ sessionId: "parent", tasks: [] });
  assert.equal(activeSubagents(empty.pi, ctx), 0);
});

test("foreign, absent, malformed or stale snapshots never mean zero active children", () => {
  for (const snapshot of [undefined, { sessionId: "other", tasks: [] }, { sessionId: "parent" },
    { sessionId: "parent", tasks: [{ status: "mystery" }] }]) {
    const h = fixture(snapshot); assert.equal(activeSubagents(h.pi, ctx), undefined);
    assert.equal(h.emitter.listenerCount(TASKS), 0);
  }
  let calls = 0;
  const h = fixture(() => ++calls === 1 ? { sessionId: "parent", tasks: [] } : undefined);
  assert.equal(activeSubagents(h.pi, ctx), 0); assert.equal(activeSubagents(h.pi, ctx), undefined);
});
