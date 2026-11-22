import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INPUT_KIND_LABELS,
  buildPromptNotice,
  buildSettledNotice,
} from "../lib/notice.js";

const fields = (text, sessionName, cwd, kind) => {
  assert.match(text, new RegExp(`🧩 Sesión: ${sessionName}`));
  assert.match(text, new RegExp(`📁 Ruta: ${cwd}`));
  assert.match(text, new RegExp(`📝 Input esperado: ${kind}`));
  assert.match(text, /📡 Canal: Pi/);
  assert.match(text, /👉 Acción:/);
  assert.match(text, /Responde en Pi para continuar\./);
};

test("prompt and settled builders include readable session fields and exact input kinds", () => {
  const prompt = buildPromptNotice({ sessionName: "sesión uno", cwd: "/tmp/pi" });
  const settled = buildSettledNotice({ sessionName: "sesión uno", cwd: "/tmp/pi" });

  fields(prompt, "sesión uno", "/tmp/pi", INPUT_KIND_LABELS.prompt);
  fields(settled, "sesión uno", "/tmp/pi", INPUT_KIND_LABELS.settled);
  assert.match(prompt, /❓ Pi necesita tu respuesta/);
  assert.match(prompt, /🔄 Estado: Esperando una respuesta a preguntas del agente/);
  assert.match(prompt, /Abre Pi y responde allí a las preguntas\./);
  assert.match(settled, /✅ El agente ha terminado/);
  assert.match(settled, /🔄 Estado: Esperando tu próximo input/);
  assert.match(settled, /Abre Pi y escribe la siguiente instrucción\./);
  assert.notEqual(prompt, settled);
});

test("missing session fields use safe fallbacks", () => {
  const prompt = buildPromptNotice({ sessionName: undefined });
  const settled = buildSettledNotice({ sessionName: "", cwd: "" });
  assert.match(prompt, /🧩 Sesión: sin nombre/);
  assert.match(prompt, /📁 Ruta: ruta no disponible/);
  assert.match(settled, /🧩 Sesión: sin nombre/);
  assert.match(settled, /📁 Ruta: ruta no disponible/);
});

test("long session fields are truncated while fixed details remain intact", () => {
  const sessionName = "N".repeat(10000);
  const cwd = "/workspace/" + "p".repeat(10000);
  const text = buildSettledNotice({ sessionName, cwd });

  assert.ok(text.length <= 4096);
  assert.match(text, /📝 Input esperado: terminación de las acciones del agente/);
  assert.match(text, /📡 Canal: Pi/);
  assert.match(text, /👉 Acción: Abre Pi y escribe la siguiente instrucción\./);
  assert.match(text, /Responde en Pi para continuar\.$/);
  assert.ok(text.includes("…"));
  const nameField = text.match(/^🧩 Sesión: (.+)$/m)?.[1];
  const pathField = text.match(/^📁 Ruta: (.+)$/m)?.[1];
  assert.ok(nameField?.endsWith("…"));
  assert.ok(pathField?.endsWith("…"));
  assert.ok(nameField.length < sessionName.length);
  assert.ok(pathField.length < cwd.length);
});
