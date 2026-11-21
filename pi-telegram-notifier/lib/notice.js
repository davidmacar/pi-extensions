export const INPUT_KIND_LABELS = Object.freeze({
  prompt: "respuesta a preguntas del agente",
  settled: "terminación de las acciones del agente",
});

const TELEGRAM_TEXT_LIMIT = 4096;
const FALLBACK_SESSION_NAME = "sin nombre";
const instruction = "Responde en Pi para continuar.";

function valueOrFallback(value) {
  return typeof value === "string" && value.trim() ? value : FALLBACK_SESSION_NAME;
}

function clip(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  return value.slice(0, limit - 1) + "…";
}

function buildNotice({ sessionName, cwd }, kind) {
  const name = valueOrFallback(sessionName);
  const path = typeof cwd === "string" ? cwd : String(cwd ?? "");
  const prefix = "Nombre de sesión: ";
  const middle = "\nRuta de trabajo: ";
  const kindLine = `\nTipo de input esperado: ${kind}`;
  const suffix = `\n${instruction}`;
  const fixedLength = prefix.length + middle.length + kindLine.length + suffix.length;
  const available = Math.max(0, TELEGRAM_TEXT_LIMIT - fixedLength);
  const total = name.length + path.length;
  const nameBudget = total === 0 ? 0 : Math.floor(available * name.length / total);
  const pathBudget = available - nameBudget;
  return `${prefix}${clip(name, nameBudget)}${middle}${clip(path, pathBudget)}${kindLine}${suffix}`;
}

export function buildPromptNotice(context) {
  return buildNotice(context ?? {}, INPUT_KIND_LABELS.prompt);
}

export function buildSettledNotice(context) {
  return buildNotice(context ?? {}, INPUT_KIND_LABELS.settled);
}
