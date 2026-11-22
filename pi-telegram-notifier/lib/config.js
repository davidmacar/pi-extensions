import { constants, openSync, closeSync, fchmodSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../config.local.json");
export const ALLOWED_USERNAME = "MacDamon15";
export class ConfigError extends Error {}

export function normalizeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config must be a JSON object");
  const username = value.allowedUsername ?? ALLOWED_USERNAME;
  if (typeof username !== "string" || username.trim().replace(/^@/, "").toLowerCase() !== ALLOWED_USERNAME.toLowerCase()) {
    throw new ConfigError("Only the authorized Telegram username is allowed");
  }
  const botToken = value.botToken ?? "";
  if (typeof botToken !== "string" || (botToken.trim() && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken.trim()))) {
    throw new ConfigError("botToken has an invalid format");
  }
  const rawId = value.chatId ?? "";
  if (!["string", "number"].includes(typeof rawId) || (typeof rawId === "number" && !Number.isSafeInteger(rawId))) {
    throw new ConfigError("chatId must be a positive private chat ID");
  }
  const chatId = String(rawId).trim();
  if (chatId && (!/^[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)))) {
    throw new ConfigError("chatId must be a positive private chat ID");
  }
  return { botToken: botToken.trim(), chatId, allowedUsername: ALLOWED_USERNAME };
}

function readPrivateFile(path) {
  // Open without following symlinks and secure permissions before reading any secret.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o600); return readFileSync(fd, "utf8"); }
  finally { closeSync(fd); }
}

export function loadConfig(path = DEFAULT_CONFIG_PATH, { readFile = readPrivateFile } = {}) {
  let source;
  try { source = readFile(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return normalizeConfig({});
    throw new ConfigError("Cannot securely read Telegram local config");
  }
  let value;
  try { value = JSON.parse(source); }
  catch { throw new ConfigError("Telegram local config contains invalid JSON"); }
  return normalizeConfig(value);
}

export function saveConfig(path, value) {
  const config = normalizeConfig(value);
  const temporary = resolve(dirname(path), ".config-" + randomUUID() + ".tmp");
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    created = true;
    renameSync(temporary, path);
  } catch { throw new ConfigError("Cannot securely save Telegram local config"); }
  finally { if (created) { try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ } } }
}
