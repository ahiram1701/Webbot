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
