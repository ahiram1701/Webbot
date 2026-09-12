import { describe, expect, it } from "vitest";

import { createOpenAiProvider, type FetchLike } from "./openai.js";
import { LlmError, type LlmTool } from "./types.js";

const TOOLS: LlmTool[] = [
  { name: "webbot_outline", description: "mira la pagina", schema: { type: "object", properties: {} } },
];

/** Responde con un SSE partido tal cual lo mandan los proveedores: por trozos arbitrarios. */
function streamingFetch(chunks: string[], captured?: { body?: unknown }): FetchLike {
  return (_url, init) => {
    if (captured) captured.body = JSON.parse(String(init.body));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function provider(fetchImpl: FetchLike) {
  return createOpenAiProvider({ apiKey: "clave", model: "modelo-x", baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
}

/**
 * El parseo del SSE es la parte artesanal del adaptador generico y la que mas facil se rompe: el
 * nombre y los argumentos de una herramienta llegan troceados entre chunks y solo se pueden parsear
 * al final.
 */
describe("adaptador OpenAI-compatible", () => {
  it("manda la captura en un mensaje aparte, porque un role:'tool' no admite imagenes", async () => {
    const captured: { body?: unknown } = {};
    const conversation = createOpenAiProvider({
      apiKey: "clave",
      model: "modelo-x",
      baseUrl: "http://127.0.0.1:1234/v1",
      vision: true,
      fetchImpl: streamingFetch([sse({ choices: [{ delta: { content: "veo un boton" } }] }), "data: [DONE]\n\n"], captured),
    }).start("sistema", TOOLS);

    await conversation.send(
      {
        kind: "toolResults",
        results: [
          {
            id: "call_1",
            name: "webbot_screenshot",
            ok: true,
            content: '{"tabId":7}',
            image: { mediaType: "image/png", base64: "QUJD" },
          },
        ],
      },
      { onText: () => {} },
      new AbortController().signal,
    );

    const { messages } = captured.body as { messages: Array<{ role: string; content: unknown }> };
    const tool = messages.find((m) => m.role === "tool");
    const user = messages.find((m) => m.role === "user");
    expect(tool?.content).toBe('{"tabId":7}');
    expect(user?.content).toEqual([
      { type: "text", text: "Captura devuelta por webbot_screenshot:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("sin imagen no mete ningun mensaje de mas", async () => {
    const captured: { body?: unknown } = {};
    const conversation = provider(
      streamingFetch([sse({ choices: [{ delta: { content: "listo" } }] }), "data: [DONE]\n\n"], captured),
    ).start("sistema", TOOLS);

    await conversation.send(
      { kind: "toolResults", results: [{ id: "call_1", name: "webbot_outline", ok: true, content: "{}" }] },
      { onText: () => {} },
      new AbortController().signal,
    );

    const { messages } = captured.body as { messages: Array<{ role: string }> };
    expect(messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("recompone una tool call repartida entre varios chunks", async () => {
    const conversation = provider(
      streamingFetch([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "webbot_" } }] } }] }),
        // El nombre viene partido, y los argumentos en tres trozos que por separado no son JSON.
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "outline" } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tab' } }] } }] }),
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":' } }] } }] })}`,
        `\n\n${sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "7}" } }] } }] })}`,
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    ).start("sistema", TOOLS);

    const turn = await conversation.send({ kind: "user", text: "mira la pagina" }, { onText: () => {} }, new AbortController().signal);

    expect(turn.stop).toBe("tools");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "webbot_outline", input: { tabId: 7 } }]);
  });

  it("transmite el texto por deltas y termina en end", async () => {
    const deltas: string[] = [];
    const conversation = provider(
      streamingFetch([
        sse({ choices: [{ delta: { content: "Hola" } }] }),
        sse({ choices: [{ delta: { reasoning_content: "pensando" } }] }),
        sse({ choices: [{ delta: { content: " mundo" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    ).start("sistema", TOOLS);

    const razonamiento: string[] = [];
    const turn = await conversation.send(
      { kind: "user", text: "saluda" },
      { onText: (delta) => deltas.push(delta), onReasoning: (delta) => razonamiento.push(delta) },
      new AbortController().signal,
    );

    expect(deltas).toEqual(["Hola", " mundo"]);
    expect(razonamiento).toEqual(["pensando"]);
    expect(turn).toMatchObject({ text: "Hola mundo", stop: "end", toolCalls: [] });
  });

  it("manda los resultados como un mensaje 'tool' por llamada", async () => {
    const captured: { body?: unknown } = {};
    const conversation = provider(
      streamingFetch([sse({ choices: [{ delta: { content: "listo" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"], captured),
    ).start("sistema", TOOLS);

    await conversation.send(
      { kind: "toolResults", results: [{ id: "call_1", name: "webbot_outline", ok: true, content: '{"nodes":[]}' }] },
      { onText: () => {} },
      new AbortController().signal,
    );

    const body = captured.body as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"nodes":[]}' });
  });

  it("traduce un 401 a un error sobre la clave, no a un volcado HTTP", async () => {
    const conversation = provider(() =>
      Promise.resolve(new Response("no autorizado", { status: 401 })),
    ).start("sistema", TOOLS);

    await expect(
      conversation.send({ kind: "user", text: "hola" }, { onText: () => {} }, new AbortController().signal),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("falla claro si el modelo manda argumentos que no son JSON", async () => {
    const conversation = provider(
      streamingFetch([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "webbot_outline", arguments: "{esto no" } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    ).start("sistema", TOOLS);

    await expect(
      conversation.send({ kind: "user", text: "hola" }, { onText: () => {} }, new AbortController().signal),
    ).rejects.toThrow(/ilegibles/);
  });
});
