import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createAnthropicProvider } from "./anthropic.js";
import type { LlmTool } from "./types.js";

const TOOLS: LlmTool[] = [
  { name: "webbot_screenshot", description: "hace una captura", schema: { type: "object", properties: {} } },
];

/**
 * Cliente falso que se queda con los parametros de la llamada. Lo que interesa fijar aqui es la
 * FORMA del mensaje que sale, que es lo unico que no se puede comprobar sin hablar con la API: si
 * el bloque de imagen no encaja con lo que espera Anthropic, la respuesta es un 400 en produccion.
 */
function clienteFalso(captured: { params?: Record<string, unknown> }): Anthropic {
  return {
    messages: {
      stream(params: Record<string, unknown>) {
        captured.params = params;
        return {
          on() {
            return this;
          },
          finalMessage: () =>
            Promise.resolve({
              content: [{ type: "text", text: "veo un dialogo" }],
              stop_reason: "end_turn",
            } as unknown as Anthropic.Message),
        };
      },
    },
  } as unknown as Anthropic;
}

/** Manda unos resultados de herramienta y devuelve los parametros con los que se llamo a la API. */
async function enviar(
  results: Array<{ id: string; name: string; ok: boolean; content: string; image?: { mediaType: string; base64: string } }>,
): Promise<Record<string, unknown>> {
  const captured: { params?: Record<string, unknown> } = {};
  const conversation = createAnthropicProvider({
    apiKey: "clave",
    model: "claude-x",
    thinking: false,
    vision: true,
    client: clienteFalso(captured),
  }).start("sistema", TOOLS);

  await conversation.send({ kind: "toolResults", results }, { onText: () => {} }, new AbortController().signal);
  return captured.params ?? {};
}

describe("adaptador de Anthropic", () => {
  it("mete la captura dentro del propio tool_result, que es donde la admite", async () => {
    const params = await enviar([
      {
        id: "call_1",
        name: "webbot_screenshot",
        ok: true,
        content: '{"tabId":7}',
        image: { mediaType: "image/png", base64: "QUJD" },
      },
    ]);

    const messages = params.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: '{"tabId":7}' },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
          is_error: false,
        },
      ],
    });
  });

  it("sin imagen el contenido sigue siendo la cadena de siempre", async () => {
    const params = await enviar([{ id: "call_1", name: "webbot_outline", ok: true, content: "{}" }]);

    const messages = params.messages as Array<{ content: Array<{ content: unknown }> }>;
    expect(messages[0]?.content[0]?.content).toBe("{}");
  });

  it("un resultado fallido se marca como error para que el modelo no lo lea como exito", async () => {
    const params = await enviar([{ id: "call_1", name: "webbot_click", ok: false, content: "no estaba" }]);

    const messages = params.messages as Array<{ content: Array<{ is_error: boolean }> }>;
    expect(messages[0]?.content[0]?.is_error).toBe(true);
  });
});
