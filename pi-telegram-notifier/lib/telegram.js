const TELEGRAM_TEXT_LIMIT = 4096;

export function createTelegramClient({ token, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Telegram bot token is not configured correctly");
  const base = "https://api.telegram.org/bot" + token;
  async function call(method, payload, signal) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response; let body;
    try {
      response = await fetchImpl(base + "/" + method, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: combined,
      });
      body = await response.json();
    } catch { throw new Error("Telegram " + method + " request failed"); }
    if (!response.ok || body?.ok !== true) {
      // Neither API body text nor network errors may be included: either can contain a token.
      const status = Number.isInteger(response.status) ? response.status : "error";
      throw new Error("Telegram " + method + " failed (HTTP " + status + ")");
    }
    return body.result;
  }
  return {
    sendMessage(chatId, text, signal) {
      if (!/^[1-9]\d*$/.test(String(chatId))) throw new Error("Telegram requires a positive private chat ID");
      const message = String(text);
      if (!message || message.length > TELEGRAM_TEXT_LIMIT) throw new Error("Telegram notice exceeds the message limit");
      return call("sendMessage", { chat_id: String(chatId), text: message }, signal);
    },
    getChat(chatId, signal) { return call("getChat", { chat_id: String(chatId) }, signal); },
    getUpdates(signal) { return call("getUpdates", { timeout: 0, limit: 100, allowed_updates: ["message"] }, signal); },
  };
}

export { TELEGRAM_TEXT_LIMIT };
