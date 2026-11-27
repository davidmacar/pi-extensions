const JSON_TYPE = "application/json";
const MAX_REPLY = 16 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;

export function failure(status, message, type = "server_error", detail = message) {
  return { status, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ error: { message, type } })), detail };
}

async function readReply(response, cap, truncate = false) {
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
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function inspectStream(body, path) {
  let finish = false;
  let terminal = false;
  const frames = body.toString("utf8").replace(/\r\n?/g, "\n").split("\n\n");
  frames.pop(); // An event without the terminating blank line was never dispatched.
  for (const frame of frames) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data.trim() === "[DONE]") { terminal = path === "/chat/completions" && finish; break; }
    let event;
    try { event = JSON.parse(data); } catch { break; }
    const error = event?.error ?? event?.response?.error;
    if (error || ["error", "response.failed"].includes(event?.type)) return { error: error ?? { message: "Upstream stream reported an error" } };
    if (event?.choices?.some?.(choice => typeof choice?.finish_reason === "string")) finish = true;
    if (path === "/responses" && ["response.completed", "response.incomplete"].includes(event?.type)) { terminal = true; break; }
  }
  return { terminal };
}

function redactError(text, key) {
  if (!key) return text;
  if (key.length < 8) return "[upstream error redacted]";
  const encoded = JSON.stringify(key).slice(1, -1);
  return text.replaceAll(encoded, "[redacted]").replaceAll(key, "[redacted]");
}

function providerEventError(error, key) {
  const message = redactError(typeof error.message === "string" ? error.message : "Upstream returned an error", key);
  const type = typeof error.type === "string" && !error.type.includes(key) ? error.type : "server_error";
  return failure(502, message, type, JSON.stringify(error));
}

/** Only send a known protocol path and the configured upstream credential. */
export async function dispatchUpstream({ fetchImpl, signal, channel, path, payload, timeoutMs }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let result;
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
      const detail = `${result.status}: ${raw.slice(0, 8192)}`;
      let message;
      if (contentType === JSON_TYPE) {
        try { message = JSON.parse(raw)?.error?.message; } catch { /* not a complete envelope */ }
      }
      return failure(result.status, typeof message === "string" ? redactError(message, channel.apiKey).slice(0, 8192) : `Upstream HTTP ${result.status}`, "server_error", detail);
    }
    const body = await readReply(result, streaming || contentType === JSON_TYPE ? MAX_REPLY : MAX_ERROR);
    if (streaming && payload.stream) {
      const { terminal, error } = inspectStream(body, path);
      if (error) return providerEventError(error, channel.apiKey);
      if (terminal) return { ok: true, status: result.status, contentType, body };
    } else if (contentType === JSON_TYPE) {
      let json;
      try { json = JSON.parse(body); } catch { /* invalid provider response */ }
      if (json?.error) return providerEventError(json.error, channel.apiKey);
      if (!payload.stream && json && typeof json === "object" && !Array.isArray(json)) return { ok: true, status: result.status, contentType, body };
    }
    return failure(502, "Upstream stream ended without a valid completion", "server_error", "incomplete_stream");
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) return failure(504, "Upstream request timed out", "server_error", "timeout");
    if (error.message === "reply_too_large") return failure(502, "Upstream response exceeded the buffer limit", "server_error", "");
    return result
      ? failure(502, "Upstream response stream was interrupted", "server_error", "incomplete_stream")
      : failure(502, "Upstream connection failed", "server_error", "network");
  }
}
