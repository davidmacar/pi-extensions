import { ALLOWED_USERNAME, DEFAULT_CONFIG_PATH, loadConfig, normalizeConfig, saveConfig } from "./lib/config.js";
import { createTelegramClient } from "./lib/telegram.js";
import { activeSubagents } from "./lib/subagents.js";

const interactive = ctx => ctx?.mode === "tui" && ctx.hasUI === true;
const authorized = (chat, id) => chat?.type === "private" && String(chat.id) === id &&
  chat.username?.toLowerCase() === ALLOWED_USERNAME.toLowerCase();

export default function telegramWaitNotifier(pi, {
  readConfig = loadConfig, persistConfig = saveConfig, makeClient = createTelegramClient,
} = {}) {
  let binding;
  let alive = false;
  let generation = 0;
  let requestController;
  let promptOpen = false;
  let noticeSent = false;
  let noticePending = false;
  let setupPending = false;

  const notify = (ctx, text, type = "warning") => ctx?.ui?.notify?.(text, type);
  const readBinding = () => {
    const config = normalizeConfig(readConfig(DEFAULT_CONFIG_PATH));
    return { config, client: config.botToken ? makeClient({ token: config.botToken }) : undefined };
  };

  async function send(text, ctx, current = binding, expectedGeneration = generation, stillWaiting = () => true) {
    if (!alive || !interactive(ctx) || !current?.config.botToken || !current.config.chatId) return false;
    try {
      const { config, client } = current;
      const chat = await client.getChat(config.chatId, requestController.signal);
      if (!alive || expectedGeneration !== generation || !stillWaiting()) return false;
      if (!authorized(chat, config.chatId)) throw new Error("identity mismatch");
      await client.sendMessage(config.chatId, text, requestController.signal);
      return true;
    } catch {
      if (alive && expectedGeneration === generation) notify(ctx, "Telegram notification failed; check the private chat, token and connection.");
      return false;
    }
  }

  pi.registerCommand("telegram-notifier", {
    description: "Telegram wait alerts: setup | status | test (responses stay in Pi)",
    handler: async (args, ctx) => {
      if (!interactive(ctx) || !alive) return;
      const action = String(args ?? "").trim().toLowerCase();
      if (action === "status") {
        notify(ctx, binding?.config.botToken && binding.config.chatId ?
          "Telegram notifier configured for @MacDamon15; delivery has not been tested by status." :
          "Telegram notifier disabled. Set a replacement token in config.local.json, then run /telegram-notifier setup.", "info");
        return;
      }
      if (action === "test") {
        if (!binding?.config.chatId) { notify(ctx, "Run /telegram-notifier setup first."); return; }
        if (await send("Prueba de avisos de Pi. Las respuestas se introducen en Pi.", ctx)) notify(ctx, "Telegram test message sent.", "info");
        return;
      }
      if (action !== "setup") { notify(ctx, "Usage: /telegram-notifier setup | status | test", "info"); return; }
      if (setupPending) { notify(ctx, "Telegram setup is already running."); return; }
      setupPending = true;
      const expectedGeneration = generation;
      try {
        const candidate = readBinding();
        if (!candidate.config.botToken) { notify(ctx, "Set a newly rotated token in config.local.json before setup."); return; }
        const updates = await candidate.client.getUpdates(requestController.signal);
        if (!alive || expectedGeneration !== generation) return;
        const ownStart = Array.isArray(updates) && [...updates].reverse().find(update => {
          const message = update?.message;
          return message?.text?.trim() === "/start" && !message.forward_origin && !message.forward_from &&
            message.from?.is_bot !== true && message.from?.username?.toLowerCase() === ALLOWED_USERNAME.toLowerCase() &&
            authorized(message.chat, String(message.from?.id)) &&
            /^[1-9]\d*$/.test(String(message.chat.id)) &&
            (!candidate.config.chatId || candidate.config.chatId === String(message.chat.id));
        });
        if (!ownStart) { notify(ctx, "No private /start from @MacDamon15 was found. Send /start to the bot and retry; existing configuration is unchanged."); return; }
        const config = normalizeConfig({ ...candidate.config, chatId: String(ownStart.message.chat.id) });
        if (!authorized(await candidate.client.getChat(config.chatId, requestController.signal), config.chatId)) throw new Error("identity mismatch");
        if (!alive || expectedGeneration !== generation) return;
        persistConfig(DEFAULT_CONFIG_PATH, config);
        binding = { config, client: candidate.client };
        if (await send("Avisos de Pi activados para este chat privado. Responde a las preguntas en Pi.", ctx, binding, expectedGeneration)) {
          notify(ctx, "Telegram notifier configured and confirmation sent to @MacDamon15.", "info");
        } else { notify(ctx, "Telegram configuration saved; confirmation delivery failed."); }
      } catch { notify(ctx, "Telegram setup failed. Check config.local.json, bot token, private /start and connection; existing configuration is unchanged."); }
      finally { setupPending = false; }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    alive = true; generation++; requestController = new AbortController();
    promptOpen = false; noticeSent = false; noticePending = false;
    if (!interactive(ctx)) return;
    try { binding = readBinding(); }
    catch { binding = undefined; notify(ctx, "Telegram notifier disabled: local configuration could not be securely loaded."); }
  });
  pi.on("session_shutdown", async () => {
    alive = false; generation++; requestController?.abort(); binding = undefined;
  });
  pi.on("agent_start", () => { noticeSent = false; });
  pi.on("ui_prompt_start", async (_event, ctx) => {
    promptOpen = true;
    await send("Pi necesita tu respuesta a una pregunta o formulario. Abre Pi para responder y continuar.", ctx, binding, generation, () => promptOpen);
  });
  pi.on("ui_prompt_end", () => { promptOpen = false; });
  pi.on("agent_settled", async (event, ctx) => {
    if (!alive || !interactive(ctx) || !binding?.config.botToken || !binding.config.chatId || event.aborted || !ctx.isIdle() || promptOpen || noticeSent || noticePending) return;
    const children = activeSubagents(pi, ctx);
    if (children !== 0) {
      if (children === undefined) notify(ctx, "Telegram completion notice suppressed: active subagents cannot be confirmed. Input prompt alerts remain enabled.");
      return;
    }
    noticePending = true;
    try { noticeSent = await send("El agente de Pi ha terminado su trabajo y está a la espera de tu input. Abre Pi para continuar.", ctx, binding, generation, () => ctx.isIdle() && !promptOpen && activeSubagents(pi, ctx) === 0); }
    finally { noticePending = false; }
  });
}
