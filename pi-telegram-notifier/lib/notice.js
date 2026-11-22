export const INPUT_KIND_LABELS = Object.freeze({
  prompt: "respuesta a preguntas del agente",
  settled: "terminación de las acciones del agente",
});

const TELEGRAM_TEXT_LIMIT = 4096;
const FALLBACK_SESSION_NAME = "sin nombre";
const FALLBACK_CWD = "ruta no disponible";
const instruction = "Responde en Pi para continuar.";

const NOTICE_COPY = Object.freeze({
  prompt: {
    icon: "❓",
    title: "Pi necesita tu respuesta",
    state: "Esperando una respuesta a preguntas del agente",
    action: "Abre Pi y responde allí a las preguntas.",
  },
  settled: {
    icon: "✅",
    title: "El agente ha terminado",
    state: "Esperando tu próximo input",
    action: "Abre Pi y escribe la siguiente instrucción.",
  },
});

function valueOrFallback(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function clip(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  return value.slice(0, limit - 1) + "…";
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function buildNotice({ sessionName, cwd }, kindKey) {
  const copy = NOTICE_COPY[kindKey];
  const name = escapeHtml(valueOrFallback(sessionName, FALLBACK_SESSION_NAME));
  const path = escapeHtml(valueOrFallback(cwd, FALLBACK_CWD));
  const prefix = `${copy.icon} ${copy.title}`;
  const fixed = [
    prefix,
    "",
    `🔄 Estado: ${copy.state}`,
    `🧩 Sesión: `,
    `📁 Ruta: `,
    `📝 Input esperado: ${INPUT_KIND_LABELS[kindKey]}`,
    `📡 Canal: Pi`,
    `👉 Acción: ${copy.action}`,
  ];
  const suffix = `\n${instruction}`;
  const fixedLength = fixed.join("\n").length + suffix.length;
  const available = Math.max(0, TELEGRAM_TEXT_LIMIT - fixedLength);
  const separatorLength = 1;
  const total = name.length + path.length + separatorLength;
  const nameBudget = total === 0 ? 0 : Math.floor((available - separatorLength) * name.length / total);
  const pathBudget = Math.max(0, available - nameBudget - separatorLength);
  fixed[3] += clip(name, nameBudget);
  fixed[4] += clip(path, pathBudget);
  return `${fixed.join("\n")}${suffix}`;
}

export function buildPromptNotice(context) {
  return buildNotice(context ?? {}, "prompt");
}

export function buildSettledNotice(context) {
  return buildNotice(context ?? {}, "settled");
}
