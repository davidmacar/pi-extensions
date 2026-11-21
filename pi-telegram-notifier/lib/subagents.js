const TASKS = "gentle-pi:herdr-desktop:tasks";
const REQUEST = "gentle-pi:herdr-desktop:tasks-request";
const ACTIVE = new Set(["queued", "running", "waiting"]);
const FINISHED = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** Ask Gentle's display publisher for a fresh active-only snapshot of this session. */
export function activeSubagents(pi, ctx) {
  if (typeof pi.getAllTools !== "function") return undefined;
  let tools;
  try { tools = pi.getAllTools(); } catch { return undefined; }
  if (!Array.isArray(tools)) return undefined;
  const hasSpawner = tools.some(tool => /subagent|orchestrator/i.test(tool.name));
  if (!hasSpawner) return 0;
  if (!pi.events?.on || !pi.events?.emit || !ctx.sessionManager?.getSessionId) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) return undefined;
  let active;
  const unsubscribe = pi.events.on(TASKS, data => {
    if (data?.sessionId !== sessionId || !Array.isArray(data.tasks)) return;
    active = data.tasks.every(task => ACTIVE.has(task?.status) || FINISHED.has(task?.status)) ?
      data.tasks.filter(task => ACTIVE.has(task.status)).length : undefined;
  });
  // Pi's bus and Gentle's publisher are synchronous; never reuse cached snapshots.
  try { pi.events.emit(REQUEST, { sessionId }); }
  catch { active = undefined; }
  finally { unsubscribe(); }
  return active;
}
