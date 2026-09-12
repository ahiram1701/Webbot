import { FrameSchema, PROTOCOL_VERSION, type Frame, type LlmStatus } from "@webbot/shared";

import { agentConnectionLost, handleAgentEvent, registerPanel } from "./agent.js";
import { runCommand } from "./commands/index.js";
import { appendLog, getSettings } from "./settings.js";

/**
 * Cliente del puente. El service worker de MV3 no puede escuchar en un puerto, asi que es la
 * extension quien se conecta al servidor MCP.
 *
 * Sobre la supervivencia del worker: Chrome lo mata tras 30 s sin actividad, pero desde Chrome 116
 * el trafico WebSocket reinicia ese contador, y el servidor manda un ping cada 20 s. La alarma de
 * aqui abajo es la red de seguridad: si aun asi el worker muere, la alarma lo despierta y
 * reconecta.
 */

const KEEPALIVE_ALARM = "webbot-keepalive";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket: WebSocket | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** `llm` solo lo trae el welcome; al desconectar se borra, porque deja de haber nada que describir. */
async function setConnected(connected: boolean, detail = "", llm: LlmStatus | null = null): Promise<void> {
  await chrome.storage.session.set({ connected, connectionDetail: detail, connectionAt: Date.now(), llm });
  await chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: connected ? "#16a34a" : "#dc2626" });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

/** Envia por `target`, que por defecto es la conexion actual. */
function send(frame: Frame, target: WebSocket | null = socket): void {
  if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(frame));
}

/** Margen para que la respuesta llegue al servidor antes de que salte su temporizador. */
const DEADLINE_MARGIN_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** La respuesta vuelve por el socket que trajo la peticion, no por el que sea el actual al terminar. */
async function handleRequest(frame: Extract<Frame, { kind: "request" }>, origin: WebSocket): Promise<void> {
  try {
    const deadlineAt = Date.now() + (frame.timeoutMs ?? DEFAULT_TIMEOUT_MS) - DEADLINE_MARGIN_MS;
    const result = await runCommand(frame.command, { deadlineAt });
    send({ kind: "response", id: frame.id, ok: true, result }, origin);
    await appendLog({ at: Date.now(), command: frame.command.type, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code;
    send({ kind: "response", id: frame.id, ok: false, error: { message, code } }, origin);
    await appendLog({ at: Date.now(), command: frame.command.type, ok: false, detail: message });
  }
}

/**
 * Solo puede haber un intento de conexion en curso. connect() se llama desde varios sitios a la vez
 * (al recargar la extension coinciden onInstalled y la llamada de arranque), y comprobar "ya hay
 * socket" no basta: entre esa comprobacion y la asignacion hay un await. Dos llamadas la pasaban y
 * abrian dos sockets; el servidor sustituia uno por otro, el cierre del sustituido anulaba el global
 * y programaba otra reconexion, y asi en bucle, perdiendose las respuestas por el camino.
 */
let connecting: Promise<void> | null = null;

function connect(): Promise<void> {
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const settings = await getSettings();
  if (!settings.token) {
    await setConnected(false, "Falta el token: configuralo en Opciones (debe coincidir con WEBBOT_TOKEN del servidor).");
    return;
  }

  const url = `ws://127.0.0.1:${settings.bridgePort}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    await setConnected(false, `No se pudo abrir ${url}.`);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    send({ kind: "hello", token: settings.token, version: PROTOCOL_VERSION, agent: navigator.userAgent }, ws);
  });

  ws.addEventListener("message", (event: MessageEvent<string>) => {
    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = FrameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;

    switch (frame.kind) {
      case "welcome":
        reconnectDelayMs = RECONNECT_MIN_MS;
        void setConnected(true, `Conectado al puente en ${url}.`, frame.llm ?? null);
        return;
      case "request":
        void handleRequest(frame, ws);
        return;
      case "agent.event":
        void handleAgentEvent(frame.runId, frame.event);
        return;
      case "ping":
        send({ kind: "pong", t: frame.t }, ws);
        return;
      default:
        return;
    }
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    // Un socket que ya no es el actual no toca el estado ni programa reconexiones: eso era lo que
    // alimentaba el bucle.
    if (socket !== ws) return;
    socket = null;
    const motivo =
      event.code === 4403
        ? "Token rechazado: el de Opciones no coincide con WEBBOT_TOKEN del servidor."
        : event.code === 4400
          ? "Version de protocolo incompatible: actualiza la extension o el servidor."
          : event.code === 4409
            ? "Otra conexion de Webbot sustituyo a esta. Comprueba que la extension no este cargada dos veces."
            : `Conexion cerrada (codigo ${event.code}).`;
    void setConnected(false, motivo);
    void agentConnectionLost();
    // Un token o una version incorrectos no se arreglan reintentando en bucle, y si el servidor ya
    // atiende a otra conexion (4409), reconectar solo reabriria la pelea por el puente.
    if (event.code !== 4403 && event.code !== 4400 && event.code !== 4409) scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (socket !== ws) return;
    void setConnected(false, `Sin respuesta en ${url}. Arranca el servidor con 'npm run mcp'.`);
  });
}

// --- Panel lateral --------------------------------------------------------

// El clic en el icono abre el panel; ya no hay popup que abrir.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // Chrome < 116 o el panel deshabilitado: el resto de la extension sigue funcionando.
});

registerPanel((frame) => {
  if (socket?.readyState !== WebSocket.OPEN) {
    void connect();
    return false;
  }
  send(frame);
  return true;
});

// --- Ciclo de vida --------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void connect();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (socket?.readyState === WebSocket.OPEN) send({ kind: "ping", t: Date.now() });
  else void connect();
});

// Cambiar el token o el puerto debe reconectar sin tener que recargar la extension.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("token" in changes) && !("bridgePort" in changes)) return;
  reconnectDelayMs = RECONNECT_MIN_MS;
  socket?.close();
  socket = null;
  void connect();
});

// El panel pregunta el estado al abrirse; responderle tambien despierta al worker.
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== "webbot:reconnect") return undefined;
  reconnectDelayMs = RECONNECT_MIN_MS;
  socket?.close();
  socket = null;
  void connect().then(() => sendResponse({ ok: true }));
  return true;
});

void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
void connect();
