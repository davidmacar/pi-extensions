import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INPUT_KIND_LABELS,
  buildPromptNotice,
  buildSettledNotice,
} from "../lib/notice.js";

const fields = (text, sessionName, cwd, kind) => {
  assert.match(text, new RegExp(`Nombre de sesión: ${sessionName}`));
  assert.match(text, new RegExp(`Ruta de trabajo: ${cwd}`));
  assert.match(text, new RegExp(`Tipo de input esperado: ${kind}`));
  assert.match(text, /Responde en Pi para continuar\./);
};

test("prompt and settled builders include their Pi session fields and exact input kinds", () => {
  const prompt = buildPromptNotice({ sessionName: "sesión uno", cwd: "/tmp/pi" });
  const settled = buildSettledNotice({ sessionName: "sesión uno", cwd: "/tmp/pi" });

  fields(prompt, "sesión uno", "/tmp/pi", INPUT_KIND_LABELS.prompt);
  fields(settled, "sesión uno", "/tmp/pi", INPUT_KIND_LABELS.settled);
  assert.equal(INPUT_KIND_LABELS.prompt, "respuesta a preguntas del agente");
  assert.equal(INPUT_KIND_LABELS.settled, "terminación de las acciones del agente");
  assert.notEqual(prompt, settled);
});

test("missing or empty session names use the exact fallback", () => {
  for (const sessionName of [undefined, ""]) {
    assert.match(buildPromptNotice({ sessionName, cwd: "/repo" }), /Nombre de sesión: sin nombre/);
    assert.match(buildSettledNotice({ sessionName, cwd: "/repo" }), /Nombre de sesión: sin nombre/);
  }
});

test("long session fields are truncated while fixed labels and instruction remain intact", () => {
  const sessionName = "N".repeat(10000);
  const cwd = "/workspace/" + "p".repeat(10000);
  const text = buildSettledNotice({ sessionName, cwd });

  assert.ok(text.length <= 4096);
  assert.match(text, /Tipo de input esperado: terminación de las acciones del agente/);
  assert.match(text, /Responde en Pi para continuar\.$/);
  assert.ok(text.includes("…"));
  const nameField = text.match(/^Nombre de sesión: (.+)\nRuta de trabajo:/)?.[1];
  const pathField = text.match(/^Ruta de trabajo: (.+)\nTipo de input esperado:/m)?.[1];
  assert.ok(nameField?.endsWith("…"));
  assert.ok(pathField?.endsWith("…"));
  assert.ok(nameField.length < sessionName.length);
  assert.ok(pathField.length < cwd.length);
});
