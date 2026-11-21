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

test("plain Pi without subagent tools has no child work; unknown tools state fails closed", () => {
  assert.equal(activeSubagents({ getAllTools: () => [{ name: "read" }] }, ctx), 0);
  assert.equal(activeSubagents({}, ctx), undefined);
  assert.equal(activeSubagents({ getAllTools: () => [{ name: "subagent_run" }] }, ctx), undefined);
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
