import { FrameSchema, PROTOCOL_VERSION, type Frame } from "@webbot/shared";

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

async function setConnected(connected: boolean, detail = ""): Promise<void> {
  await chrome.storage.session.set({ connected, connectionDetail: detail, connectionAt: Date.now() });
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

function send(frame: Frame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

/** Margen para que la respuesta llegue al servidor antes de que salte su temporizador. */
const DEADLINE_MARGIN_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

async function handleRequest(frame: Extract<Frame, { kind: "request" }>): Promise<void> {
  try {
    const deadlineAt = Date.now() + (frame.timeoutMs ?? DEFAULT_TIMEOUT_MS) - DEADLINE_MARGIN_MS;
    const result = await runCommand(frame.command, { deadlineAt });
    send({ kind: "response", id: frame.id, ok: true, result });
    await appendLog({ at: Date.now(), command: frame.command.type, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code;
    send({ kind: "response", id: frame.id, ok: false, error: { message, code } });
    await appendLog({ at: Date.now(), command: frame.command.type, ok: false, detail: message });
  }
}

async function connect(): Promise<void> {
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
    send({ kind: "hello", token: settings.token, version: PROTOCOL_VERSION, agent: navigator.userAgent });
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
        void setConnected(true, `Conectado al puente en ${url}.`);
        return;
      case "request":
        void handleRequest(frame);
        return;
      case "ping":
        send({ kind: "pong", t: frame.t });
        return;
      default:
        return;
    }
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    socket = null;
    const motivo =
      event.code === 4403
        ? "Token rechazado: el de Opciones no coincide con WEBBOT_TOKEN del servidor."
        : event.code === 4400
          ? "Version de protocolo incompatible: actualiza la extension o el servidor."
          : `Conexion cerrada (codigo ${event.code}).`;
    void setConnected(false, motivo);
    // Un token o una version incorrectos no se arreglan reintentando en bucle.
    if (event.code !== 4403 && event.code !== 4400) scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    void setConnected(false, `Sin respuesta en ${url}. Arranca el servidor con 'npm run mcp'.`);
  });
}

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

// El popup pregunta el estado al abrirse; responderle tambien despierta al worker.
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
