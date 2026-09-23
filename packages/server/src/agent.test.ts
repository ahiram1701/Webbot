import { describe, expect, it, vi } from "vitest";

import { AGENT_MAX_STEPS, ErrorCodes, type AgentEvent, type Command, type Frame } from "@webbot/shared";

import { createAgentRunner, type AgentBridge } from "./agent.js";
import { BridgeError } from "./bridge.js";
import { LlmError, type LlmConversation, type LlmInput, type LlmProvider, type LlmTurn } from "./llm/index.js";

/**
 * Guion de turnos: el proveedor falso devuelve uno por llamada y apunta lo que recibio. Es lo que
 * abarata tener la capa neutra de modelo: el bucle se prueba entero sin red ni SDK.
 */
function fakeProvider(turns: LlmTurn[]): LlmProvider & { inputs: LlmInput[]; aborted: boolean } {
  const inputs: LlmInput[] = [];
  const state = { aborted: false };
  let index = 0;

  const conversation: LlmConversation = {
    async send(input, handlers, signal) {
      inputs.push(input);
      const turn = turns[index++];
      if (!turn) throw new Error("el guion se quedo sin turnos");
      if (signal.aborted) {
        state.aborted = true;
        throw new Error("abortado");
      }
      if (turn.text) handlers.onText(turn.text);
      return turn;
    },
  };

  return {
    label: "falso:modelo",
    vision: false,
    start: () => conversation,
    inputs,
    get aborted() {
      return state.aborted;
    },
  } as LlmProvider & { inputs: LlmInput[]; aborted: boolean };
}

/** Puente falso: recoge los comandos que salen y los eventos que bajan al panel. */
function fakeBridge(respond: (command: Command) => Promise<unknown> = async () => ({ ok: true })) {
  const commands: Command[] = [];
  const events: AgentEvent[] = [];
  const bridge: AgentBridge = {
    send(command) {
      commands.push(command);
      return respond(command);
    },
    sendToExtension(frame: Frame) {
      if (frame.kind === "agent.event") events.push(frame.event);
    },
  };
  return { bridge, commands, events };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Espera a que el bucle, que corre en segundo plano, llegue a donde interesa. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`no se llego a: ${label}`);
}

const turn = (partial: Partial<LlmTurn>): LlmTurn => ({ text: "", toolCalls: [], stop: "end", ...partial });

describe("agente del panel", () => {
  it("ejecuta la herramienta contra el puente y le devuelve el resultado al modelo", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_open_tab", input: { url: "https://example.com/" } }] }),
      turn({ text: "Ya esta abierta.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge(async () => ({ tabId: 42 }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "abre example.com" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([{ type: "browser.openTab", url: "https://example.com/", active: undefined }]);
    expect(provider.inputs[1]).toEqual({
      kind: "toolResults",
      results: [{ id: "c1", name: "webbot_open_tab", ok: true, content: '{"tabId":42}' }],
    });
    expect(events.map((event) => event.type)).toEqual(["tool", "toolResult", "text", "done"]);
  });

  it("manda al panel el codigo del fallo, no solo su texto", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [{ id: "c1", name: "webbot_open_tab", input: { url: "https://bloqueado.example/" } }],
      }),
      turn({ text: "Ese dominio no esta permitido.", stop: "end" }),
    ]);
    const { bridge, events } = fakeBridge(() =>
      Promise.reject(new BridgeError("no esta en la allowlist", ErrorCodes.DOMAIN_BLOCKED)),
    );

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "abre eso" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    // El panel se apoya en el codigo para ofrecer "Permitir <dominio>"; leerlo del resumen seria adivinar.
    const result = events.find((event) => event.type === "toolResult");
    expect(result).toMatchObject({ ok: false, code: ErrorCodes.DOMAIN_BLOCKED });
  });
  it("con autoConfirm publica sin tarjeta, pero deja constancia de lo que publico", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [
          {
            id: "c1",
            name: "webbot_post_social",
            input: { network: "facebook", text: "hola", expectedAccount: "Ahiram", groups: ["Programadores"] },
          },
        ],
      }),
      turn({ text: "Publicado.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({
      kind: "agent.start",
      runId: "r1",
      prompt: "publica eso",
      autoConfirm: true,
    });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    // No se espera respuesta de nadie: el comando sale igual.
    expect(commands.map((command) => command.type)).toEqual(["social.post"]);
    // Pero la tarjeta sale igual, contando lo que paso: renunciar al permiso no es renunciar a verlo.
    const aviso = events.find((event) => event.type === "confirm");
    expect(aviso).toMatchObject({ auto: true, text: "hola", groups: ["Programadores"] });
  });

  it("sin autoConfirm no manda nada al navegador hasta que alguien conteste", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [
          { id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola", expectedAccount: "@yo" } },
        ],
      }),
      turn({ text: "Listo.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "publica" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");

    expect(commands).toEqual([]);
    const aviso = events.find((event) => event.type === "confirm");
    expect(aviso?.type).toBe("confirm");
    expect((aviso as { auto?: boolean }).auto).toBeUndefined();
  });
  it("identifica como 'panel' lo que pide, para no confundirlo con un agente externo", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_list_tabs", input: {} }] }),
      turn({ text: "Ahi las tienes.", stop: "end" }),
    ]);
    const origenes: string[] = [];
    const { bridge, events } = fakeBridge();
    const espiado: AgentBridge = {
      ...bridge,
      send(command, origin) {
        origenes.push(origin);
        return bridge.send(command, origin);
      },
    };

    createAgentRunner(espiado, provider).handle({ kind: "agent.start", runId: "r1", prompt: "que pestanas hay" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(origenes).toEqual(["panel"]);
  });
  it("saca la captura del JSON y se la manda al modelo si puede verla", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_screenshot", input: { tabId: 7 } }] }),
      turn({ text: "Veo un dialogo.", stop: "end" }),
    ]);
    (provider as { vision: boolean }).vision = true;
    const { bridge, events } = fakeBridge(async () => ({ tabId: 7, dataUrl: "data:image/png;base64,QUJD" }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "mira la pagina" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    const results = (provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>).results;
    expect(results[0]?.image).toEqual({ mediaType: "image/png", base64: "QUJD" });
    // El data URL nunca va en el texto: son cientos de kilobytes que ademas no dicen nada.
    expect(results[0]?.content).not.toContain("QUJD");
    expect(results[0]?.content).toContain("[PNG adjunto]");
  });

  it("sin vision la captura no se manda, y se dice por que", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_screenshot", input: { tabId: 7 } }] }),
      turn({ text: "No puedo verla.", stop: "end" }),
    ]);
    const { bridge, events } = fakeBridge(async () => ({ tabId: 7, dataUrl: "data:image/png;base64,QUJD" }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "mira la pagina" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    const results = (provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>).results;
    expect(results[0]?.image).toBeUndefined();
    expect(results[0]?.content).toContain("no ve imagenes");
  });

  it("le pasa al modelo la pestana que la persona tiene delante", async () => {
    const provider = fakeProvider([turn({ text: "Va de dominios de ejemplo.", stop: "end" })]);
    const { bridge, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({
      kind: "agent.start",
      runId: "r1",
      prompt: "de que va esto",
      context: { tabId: 42, url: "https://example.com/", title: "Example Domain", allowed: true },
    });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    const first = provider.inputs[0] as { kind: string; text: string };
    expect(first.kind).toBe("user");
    expect(first.text).toContain("tabId 42");
    expect(first.text).toContain("https://example.com/");
    expect(first.text).toContain("Example Domain");
    expect(first.text).toContain("permitida");
    // Lo que escribio la persona llega entero y al final, no diluido en la cabecera.
    expect(first.text.endsWith("de que va esto")).toBe(true);
  });

  it("avisa al modelo cuando la pestana de delante esta fuera de la allowlist", async () => {
    const provider = fakeProvider([turn({ text: "Ese dominio no esta permitido.", stop: "end" })]);
    const { bridge, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({
      kind: "agent.start",
      runId: "r1",
      prompt: "resume esto",
      context: { tabId: 7, url: "https://noestá.example/", title: "", allowed: false },
    });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect((provider.inputs[0] as { text: string }).text).toContain("NO permitida");
  });

  it("sin contexto manda el prompt tal cual: una extension sin recargar no manda ninguno", async () => {
    const provider = fakeProvider([turn({ text: "Hecho.", stop: "end" })]);
    const { bridge, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "hola" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(provider.inputs[0]).toEqual({ kind: "user", text: "hola" });
  });
  it("le cuenta al modelo el codigo de error del puente en vez de cortar el bucle", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_click", input: { tabId: 1, target: { text: "X" } } }] }),
      turn({ text: "No estaba ese boton.", stop: "end" }),
    ]);
    const { bridge, events } = fakeBridge(() =>
      Promise.reject(new BridgeError("no encontrado", ErrorCodes.ELEMENT_NOT_FOUND)),
    );

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "pulsa X" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    const result = provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>;
    expect(result.results[0]).toMatchObject({ ok: false });
    expect(result.results[0]?.content).toContain(ErrorCodes.ELEMENT_NOT_FOUND);
  });

  it("no publica de verdad hasta que llega la confirmacion", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola", expectedAccount: "@yo" } }],
      }),
      turn({ text: "Publicado.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();
    const runner = createAgentRunner(bridge, provider);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "publica hola en X" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");

    // La tarjeta esta en el panel y el puente sigue sin ver nada: es justo la garantia que importa.
    expect(commands).toEqual([]);
    const pregunta = events.find((event) => event.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    expect(pregunta).toMatchObject({ network: "x", text: "hola", account: "@yo" });

    runner.handle({ kind: "agent.confirm", runId: "r1", confirmId: pregunta.confirmId, approved: true });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([
      { type: "social.post", network: "x", text: "hola", dryRun: undefined, expectedAccount: "@yo" },
    ]);
  });

  it("con la confirmacion denegada no manda nunca la publicacion", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola" } }] }),
      turn({ text: "Vale, no publico nada.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();
    const runner = createAgentRunner(bridge, provider);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "publica hola" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");
    const pregunta = events.find((event) => event.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    runner.handle({ kind: "agent.confirm", runId: "r1", confirmId: pregunta.confirmId, approved: false });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([]);
    const result = provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>;
    expect(result.results[0]?.content).toContain("cancelo");
  });

  it("deja pasar el dryRun sin preguntar nada", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola", dryRun: true } }],
      }),
      turn({ text: "Saldria como @yo.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge(async () => ({ account: "@yo" }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "simula un post" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(events.some((event) => event.type === "confirm")).toBe(false);
    expect(commands[0]).toMatchObject({ type: "social.post", dryRun: true });
  });

  it("detener corta el bucle y no ejecuta el paso siguiente", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola" } }] }),
      turn({ text: "no deberia llegar aqui", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();
    const runner = createAgentRunner(bridge, provider);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "publica hola" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");

    runner.handle({ kind: "agent.cancel", runId: "r1" });
    await waitFor(
      () => events.some((event) => event.type === "error" && event.code === ErrorCodes.AGENT_CANCELLED),
      "cancelado",
    );
    await tick();

    expect(commands).toEqual([]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("corta el turno si el proveedor se queda callado", async () => {
    // Proveedor que no responde nunca: sin techo, el run se quedaria esperando para siempre y la
    // unica salida seria el boton Detener.
    const mudo: LlmProvider = {
      label: "mudo:modelo",
      vision: false,
      start: () => ({
        send: (_input, _handlers, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("abortado")));
          }),
      }),
    };
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, mudo, null, 50).handle({ kind: "agent.start", runId: "r1", prompt: "haz algo" });
    await waitFor(() => events.some((event) => event.type === "error"), "error");

    expect(commands).toEqual([]);
    const fallo = events.find((event) => event.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(fallo.message).toContain("no respondio");
    expect(fallo.code).toBe(ErrorCodes.LLM_ERROR);
  });

  it("detener no se reporta como un plazo agotado", async () => {
    const mudo: LlmProvider = {
      label: "mudo:modelo",
      vision: false,
      start: () => ({
        send: (_input, _handlers, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("abortado")));
          }),
      }),
    };
    const { bridge, events } = fakeBridge();
    const runner = createAgentRunner(bridge, mudo, null, 60_000);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "haz algo" });
    await tick();
    runner.handle({ kind: "agent.cancel", runId: "r1" });
    await waitFor(() => events.some((event) => event.type === "error"), "error");

    const fallo = events.find((event) => event.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(fallo.code).toBe(ErrorCodes.AGENT_CANCELLED);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("sin modelo configurado avisa y no toca el puente", async () => {
    const { bridge, commands, events } = fakeBridge();
    const error = new LlmError("Falta la clave del modelo.", ErrorCodes.LLM_NOT_CONFIGURED);

    createAgentRunner(bridge, null, error).handle({ kind: "agent.start", runId: "r1", prompt: "haz algo" });

    expect(commands).toEqual([]);
    expect(events).toEqual([{ type: "error", message: "Falta la clave del modelo.", code: ErrorCodes.LLM_NOT_CONFIGURED }]);
  });

  it("corta cuando el modelo da vueltas sin terminar", async () => {
    const loop = turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_list_tabs", input: {} }] });
    const provider = fakeProvider(Array.from({ length: AGENT_MAX_STEPS + 1 }, () => loop));
    const { bridge, events } = fakeBridge(async () => ({ tabs: [] }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "mira las pestanas" });
    await waitFor(
      () => events.some((event) => event.type === "error" && event.code === ErrorCodes.AGENT_MAX_STEPS),
      "tope de pasos",
    );

    expect(events.filter((event) => event.type === "tool")).toHaveLength(AGENT_MAX_STEPS);
  });

  it("rechaza una herramienta que no existe sin romper el run", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_inventada", input: {} }] }),
      turn({ text: "Perdona, no tengo esa.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "usa la inventada" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([]);
    const result = provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>;
    expect(result.results[0]?.content).toContain("No existe la herramienta");
    // Con la lista delante el modelo elige una que existe en vez de inventar otra.
    expect(result.results[0]?.content).toContain("webbot_fill_form");
    // Y en el panel se ve, en vez de parecer que el agente se quedo parado.
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "webbot_inventada" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "toolResult", name: "webbot_inventada", ok: false }));
  });

  it("si el modelo escribe la llamada como texto se lo dice, en vez de dar la tarea por hecha", async () => {
    const escrita =
      '{"name": "webbot_type", "parameters": {"tabId": 7, "target": {"css": "#id_1"}, "text": "fui"}}';
    const provider = fakeProvider([
      turn({ text: escrita, stop: "end" }),
      turn({
        stop: "tools",
        toolCalls: [{ id: "c1", name: "webbot_type", input: { tabId: 7, target: { css: "#id_1" }, text: "fui" } }],
      }),
      turn({ text: "Hecho.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "rellena el hueco" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(provider.inputs[1]).toMatchObject({ kind: "user", text: expect.stringContaining("webbot_type") });
    expect(commands).toEqual([
      { type: "page.type", tabId: 7, target: { css: "#id_1" }, text: "fui", clear: undefined, submit: undefined },
    ]);
  });

  it("no insiste para siempre con un modelo que solo sabe escribir las llamadas", async () => {
    const escrita = '{"name": "webbot_outline", "arguments": {"tabId": 7}}';
    const provider = fakeProvider([turn({ text: escrita }), turn({ text: escrita }), turn({ text: escrita })]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "mira" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(provider.inputs).toHaveLength(3);
    expect(commands).toEqual([]);
  });

  it("arregla los argumentos que un modelo pequeno manda como texto", async () => {
    const provider = fakeProvider([
      turn({
        stop: "tools",
        toolCalls: [
          {
            id: "c1",
            name: "webbot_type",
            input: {
              tabId: "7",
              target: "{'css': '#id_1', 'xpath': '', 'text': '', 'role': '', 'name': '', 'index': 0}",
              text: "3",
              clear: "true",
              submit: "false",
            },
          },
        ],
      }),
      turn({ text: "Hecho.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "pon un 3" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([
      { type: "page.type", tabId: 7, target: { css: "#id_1", index: 0 }, text: "3", clear: true, submit: false },
    ]);
  });

  it("devuelve el error de validacion cuando los argumentos no encajan", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_open_tab", input: { url: "no-es-una-url" } }] }),
      turn({ text: "Corrijo.", stop: "end" }),
    ]);
    const { bridge, commands, events } = fakeBridge();

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "abre algo" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    expect(commands).toEqual([]);
    const result = provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>;
    expect(result.results[0]?.content).toContain("Argumentos invalidos");
  });

  it("no deja arrancar dos instrucciones a la vez sobre la misma conversacion", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola" } }] }),
    ]);
    const { bridge, events } = fakeBridge();
    const runner = createAgentRunner(bridge, provider);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "publica" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");
    runner.handle({ kind: "agent.start", runId: "r1", prompt: "y otra cosa" });

    expect(events.some((event) => event.type === "error" && event.message.includes("en marcha"))).toBe(true);
  });

  it("la captura de pantalla no le manda el PNG al modelo", async () => {
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_screenshot", input: { tabId: 1 } }] }),
      turn({ text: "Hecha.", stop: "end" }),
    ]);
    const { bridge, events } = fakeBridge(async () => ({
      tabId: 1,
      url: "https://example.com/",
      dataUrl: `data:image/png;base64,${"A".repeat(5_000)}`,
    }));

    createAgentRunner(bridge, provider).handle({ kind: "agent.start", runId: "r1", prompt: "hazme una captura" });
    await waitFor(() => events.some((event) => event.type === "done"), "done");

    const result = provider.inputs[1] as Extract<LlmInput, { kind: "toolResults" }>;
    expect(result.results[0]?.content).not.toContain("AAAA");
    expect(result.results[0]?.content).toContain("https://example.com/");
  });
});

/** Que el runner no dependa de temporizadores reales para las pruebas de arriba. */
describe("agente del panel: sin temporizadores colgados", () => {
  it("no deja intervalos vivos tras stopAll", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    const provider = fakeProvider([
      turn({ stop: "tools", toolCalls: [{ id: "c1", name: "webbot_post_social", input: { network: "x", text: "hola" } }] }),
    ]);
    const { bridge, events } = fakeBridge();
    const runner = createAgentRunner(bridge, provider);

    runner.handle({ kind: "agent.start", runId: "r1", prompt: "publica" });
    await waitFor(() => events.some((event) => event.type === "confirm"), "confirm");
    runner.stopAll();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
