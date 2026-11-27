const JSON_TYPE = "application/json";
const MAX_REPLY = 16 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;

export function failure(status, message, type = "server_error", detail = message) {
  return { status, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ error: { message, type } })), detail };
}

async function readReply(response, cap, truncate = false, onInterrupted) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      if (total + value.byteLength > cap) {
        if (!truncate) throw new Error("reply_too_large");
        chunks.push(Buffer.from(value.subarray(0, cap - total)));
        return Buffer.concat(chunks, cap);
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    onInterrupted?.(Buffer.concat(chunks, total));
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function inspectStream(body, path) {
  let finish = false;
  let usageBody;
  const frames = body.toString("utf8").replace(/\r\n?/g, "\n").split("\n\n");
  frames.pop(); // An event without the terminating blank line was never dispatched.
  for (const frame of frames) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data.trim() === "[DONE]") return { terminal: path === "/chat/completions" && finish, usageBody };
    let event;
    try { event = JSON.parse(data); } catch { break; }
    usageBody = reportedUsage(event) ?? usageBody;
    const error = event?.error ?? event?.response?.error;
    if (error || ["error", "response.failed"].includes(event?.type)) return { error: error ?? { message: "Upstream stream reported an error" }, usageBody };
    if (event?.choices?.some?.(choice => typeof choice?.finish_reason === "string")) finish = true;
    if (path === "/responses" && ["response.completed", "response.incomplete"].includes(event?.type)) return { terminal: true, usageBody };
  }
  return { terminal: false, usageBody };
}

function redactError(text, key) {
  if (!key) return text;
  if (key.length < 8) return "[upstream error redacted]";
  const encoded = JSON.stringify(key).slice(1, -1);
  return text.replaceAll(encoded, "[redacted]").replaceAll(key, "[redacted]");
}

function reportedUsage(value) {
  const usage = value?.response?.usage ?? value?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? usage : undefined;
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return undefined; }
}

function providerEventError(error, key, usageBody) {
  const message = redactError(typeof error.message === "string" ? error.message : "Upstream returned an error", key);
  const type = typeof error.type === "string" && !error.type.includes(key) ? error.type : "server_error";
  return { ...failure(502, message, type, JSON.stringify(error)), usageBody };
}

/** Only send a known protocol path and the configured upstream credential. */
export async function dispatchUpstream({ fetchImpl, signal, channel, path, payload, timeoutMs }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let result;
  let usageBody;
  try {
    result = await fetchImpl(`${channel.baseURL}${path}`, {
      method: "POST", redirect: "manual", signal: combined,
      headers: { authorization: `Bearer ${channel.apiKey}`, "content-type": JSON_TYPE,
        accept: payload.stream ? "text/event-stream" : JSON_TYPE },
      body: JSON.stringify(payload),
    });
    if (result.status >= 300 && result.status < 400) {
      void result.body?.cancel().catch(() => {});
      return failure(502, "Upstream redirects are not allowed", "server_error", "");
    }
    const contentType = result.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const streaming = contentType === "text/event-stream";
    if (!result.ok) {
      let raw = "";
      try { raw = (await readReply(result, MAX_ERROR, true)).toString("utf8"); }
      catch { signal?.throwIfAborted(); }
      const json = contentType === JSON_TYPE ? parseJson(raw) : undefined;
      usageBody = reportedUsage(json);
      // Numeric usage counters are not error codes and must not affect rotation.
      const diagnostic = usageBody ? JSON.stringify(json, (key, value) => key === "usage" ? undefined : value) : raw;
      const detail = `${result.status}: ${typeof diagnostic === "string" ? diagnostic.slice(0, 8192) : ""}`;
      const message = json?.error?.message;
      return { ...failure(result.status, typeof message === "string" ? redactError(message, channel.apiKey).slice(0, 8192) : `Upstream HTTP ${result.status}`, "server_error", detail), usageBody };
    }
    const body = await readReply(result, streaming || contentType === JSON_TYPE ? MAX_REPLY : MAX_ERROR, false,
      streaming && payload.stream ? partial => { usageBody = inspectStream(partial, path).usageBody; } : undefined);
    if (streaming && payload.stream) {
      const inspected = inspectStream(body, path);
      usageBody = inspected.usageBody;
      if (inspected.error) return providerEventError(inspected.error, channel.apiKey, usageBody);
      if (inspected.terminal) return { ok: true, status: result.status, contentType, body, usageBody };
    } else if (contentType === JSON_TYPE) {
      const json = parseJson(body);
      usageBody = reportedUsage(json);
      if (json?.error) return providerEventError(json.error, channel.apiKey, usageBody);
      if (!payload.stream && json && typeof json === "object" && !Array.isArray(json)) return { ok: true, status: result.status, contentType, body, usageBody };
    }
    return { ...failure(502, "Upstream stream ended without a valid completion", "server_error", "incomplete_stream"), usageBody };
  } catch (error) {
    if (signal?.aborted) return { status: result?.status, usageBody };
    if (deadline.aborted) return { ...failure(504, "Upstream request timed out", "server_error", "timeout"), usageBody };
    if (error?.message === "reply_too_large") return { ...failure(502, "Upstream response exceeded the buffer limit", "server_error", ""), usageBody };
    return result
      ? { ...failure(502, "Upstream response stream was interrupted", "server_error", "incomplete_stream"), usageBody }
      : failure(502, "Upstream connection failed", "server_error", "network");
  }
}
