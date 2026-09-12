import type { AgentEvent, Frame } from "@webbot/shared";

import { activeTab } from "./activeTab.js";
import { answerConfirm, applyEvent, type TranscriptEntry } from "./transcript.js";

/**
 * Puente entre el panel lateral y el socket. El panel es una pagina normal de la extension, asi que
 * habla con el worker por un puerto; el worker traduce a tramas `agent.*` y reparte de vuelta los
 * eventos.
 *
 * El historial lo guarda el worker, no el panel: cerrar el panel a mitad de una tarea no debe
 * perder lo que el agente siga haciendo, y al reabrirlo tiene que aparecer todo.
 */

export const PANEL_PORT = "webbot-panel";
const STATE_KEY = "agentState";
/** Guardar en cada delta de texto machacaria chrome.storage; con un respiro va sobrado. */
const PERSIST_DEBOUNCE_MS = 400;

/** Del panel al worker. */
export type PanelMessage =
  | { type: "sync" }
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "confirm"; confirmId: string; approved: boolean }
  | { type: "reset" };

/** Del worker al panel. */
export type PanelUpdate =
  | { type: "snapshot"; transcript: TranscriptEntry[]; running: boolean }
  | { type: "event"; event: AgentEvent }
  | { type: "running"; running: boolean };

interface AgentState {
  runId: string;
  transcript: TranscriptEntry[];
  running: boolean;
}

const freshState = (): AgentState => ({ runId: crypto.randomUUID(), transcript: [], running: false });

let state: AgentState = freshState();
let port: chrome.runtime.Port | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * El worker muere y revive; el estado vive en session storage mientras dure el navegador.
 *
 * Se memoriza la promesa, no un booleano: si varios eventos entran a la vez, un flag puesto antes
 * del await dejaria pasar al segundo con el estado todavia sin cargar, que es justo lo que esto
 * intenta evitar.
 */
let loading: Promise<void> | null = null;
function load(): Promise<void> {
  loading ??= chrome.storage.session.get({ [STATE_KEY]: null }).then((stored) => {
    const saved = stored[STATE_KEY] as AgentState | null;
    if (saved?.runId) state = saved;
  });
  return loading;
}

function persist(immediate = false): void {
  if (persistTimer) clearTimeout(persistTimer);
  if (immediate) {
    void chrome.storage.session.set({ [STATE_KEY]: state });
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void chrome.storage.session.set({ [STATE_KEY]: state });
  }, PERSIST_DEBOUNCE_MS);
}

function toPanel(update: PanelUpdate): void {
  try {
    port?.postMessage(update);
  } catch {
    // El panel se cerro entre medias: el historial ya esta guardado, no hay nada que hacer.
    port = null;
  }
}

/**
 * Llega un evento del servidor: se pliega en el historial y se reenvia al panel si esta abierto.
 *
 * Carga el estado antes de mirar el runId. Si Chrome mato el worker a mitad de una tarea, lo revive
 * justo este mensaje, y sin cargar primero el runId en memoria seria uno recien inventado: el evento
 * se descartaria por no coincidir y la tarea parecerian haberse evaporado.
 */
export async function handleAgentEvent(runId: string, event: AgentEvent): Promise<void> {
  await load();
  if (runId !== state.runId) return;
  state.transcript = applyEvent(state.transcript, event);
  if (event.type === "done" || event.type === "error") state.running = false;
  persist(event.type === "done" || event.type === "error" || event.type === "confirm");
  toPanel({ type: "event", event });
  if (!state.running) toPanel({ type: "running", running: false });
}

/**
 * `send` la pone el modulo del socket. Devuelve false cuando no hay conexion, y entonces el panel
 * se entera por el mismo camino que cualquier otro error.
 */
export function registerPanel(send: (frame: Frame) => boolean): void {
  chrome.runtime.onConnect.addListener((incoming) => {
    if (incoming.name !== PANEL_PORT) return;
    port = incoming;
    incoming.onDisconnect.addListener(() => {
      if (port === incoming) port = null;
    });

    incoming.onMessage.addListener((message: PanelMessage) => {
      void (async () => {
        await load();
        switch (message.type) {
          case "sync":
            toPanel({ type: "snapshot", transcript: state.transcript, running: state.running });
            return;

          case "prompt": {
            state.transcript = [...state.transcript, { kind: "user", text: message.text }];
            state.running = true;
            persist(true);
            toPanel({ type: "snapshot", transcript: state.transcript, running: true });
            // Se mira al enviar, no al abrir el panel: entre una cosa y otra puede haber cambiado.
            const context = (await activeTab()) ?? undefined;
            if (!send({ kind: "agent.start", runId: state.runId, prompt: message.text, context })) {
              void handleAgentEvent(state.runId, {
                type: "error",
                message: "No hay conexion con el servidor. Arrancalo con 'npm run mcp' y pulsa Reconectar.",
                code: "not_connected",
              });
            }
            return;
          }

          case "cancel":
            send({ kind: "agent.cancel", runId: state.runId });
            state.running = false;
            persist(true);
            toPanel({ type: "running", running: false });
            return;

          case "confirm":
            send({
              kind: "agent.confirm",
              runId: state.runId,
              confirmId: message.confirmId,
              approved: message.approved,
            });
            state.transcript = answerConfirm(state.transcript, message.confirmId, message.approved);
            persist(true);
            toPanel({ type: "snapshot", transcript: state.transcript, running: state.running });
            return;

          case "reset":
            // Un runId nuevo es una conversacion nueva: el servidor no reutiliza el historial.
            send({ kind: "agent.cancel", runId: state.runId });
            state = freshState();
            persist(true);
            toPanel({ type: "snapshot", transcript: state.transcript, running: false });
            return;

          default:
            return;
        }
      })();
    });

    void load().then(() => toPanel({ type: "snapshot", transcript: state.transcript, running: state.running }));
  });
}

/** El socket se cayo con algo en marcha: no llegara ningun evento mas de ese run. */
export async function agentConnectionLost(): Promise<void> {
  await load();
  if (!state.running) return;
  await handleAgentEvent(state.runId, {
    type: "error",
    message: "Se perdio la conexion con el servidor a mitad de la tarea.",
    code: "not_connected",
  });
}
