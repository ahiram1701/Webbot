import type { LlmStatus, PanelContext } from "@webbot/shared";

import { activeTab } from "../background/activeTab.js";
import { PANEL_PORT, type PanelMessage, type PanelUpdate } from "../background/agent.js";
import { getSettings } from "../background/settings.js";
import { applyEvent, answerConfirm, type TranscriptEntry } from "../background/transcript.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id} en el panel.`);
  return el as T;
};

const logEl = $("log");
const promptEl = $<HTMLTextAreaElement>("prompt");
const sendEl = $<HTMLButtonElement>("send");

let transcript: TranscriptEntry[] = [];
let running = false;
/** La pagina que el panel tiene al lado; null si no es una pagina sobre la que se pueda actuar. */
let tab: PanelContext | null = null;
/** Lo que el servidor dijo de si mismo al conectar; null mientras no haya conexion. */
let llm: LlmStatus | null = null;
/** Ultima senal de vida del agente, para poder decir cuanto lleva callado. */
let lastSignAt = Date.now();
let activityTimer: ReturnType<typeof setInterval> | null = null;

const port = chrome.runtime.connect({ name: PANEL_PORT });
const post = (message: PanelMessage): void => port.postMessage(message);

// --- Estado de la conexion -------------------------------------------------

/**
 * Todo lo que hace falta saber antes de escribir nada: si el servidor esta, con que modelo, y si
 * falta algo, que. El modelo lo anuncia el servidor en el welcome; sin esto, que no haya ninguno
 * configurado solo se descubria mandando un mensaje y viendolo fallar.
 */
async function renderStatus(): Promise<void> {
  const [settings, session] = await Promise.all([
    getSettings(),
    chrome.storage.session.get({ connected: false, connectionDetail: "", llm: null }),
  ]);
  const connected = Boolean(session.connected);
  llm = session.llm as LlmStatus | null;

  $("dot").classList.toggle("on", connected);
  $("state").textContent = connected ? "Conectado" : "Desconectado";

  const allow = settings.allowlist.includes("*") ? "todos los dominios" : `${settings.allowlist.length} dominio(s)`;
  // Un servidor viejo no manda `llm`: mejor no decir nada que inventarse que no hay modelo.
  const modelo = llm === null ? "" : llm.ready ? ` - ${llm.model ?? "modelo sin nombre"}` : " - sin modelo";
  $("detail").textContent = connected
    ? `127.0.0.1:${settings.bridgePort} - ${allow}${modelo}`
    : String(session.connectionDetail ?? "");

  const problema = connected && llm !== null && !llm.ready ? (llm.reason ?? "") : "";
  $("warn").hidden = problema === "";
  $("warn").textContent = problema;
  refreshQuick();
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "session" && area !== "local") return;
  void renderStatus();
  // Tocar la allowlist en Opciones cambia si la pestana de al lado esta permitida o no.
  void renderTab();
});

// --- La pestana que la persona tiene delante -------------------------------

/** Quita el "www." igual que hace la allowlist: en una columna estrecha solo estorba. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Va aparte de render() a proposito. render() rehace el log entero con replaceChildren, asi que
 * repintarlo en cada cambio de pestana cerraria los <details> abiertos y perderia el scroll.
 */
async function renderTab(): Promise<void> {
  tab = await activeTab();
  const row = $("tab");
  row.hidden = tab === null;
  if (tab) {
    row.classList.toggle("blocked", !tab.allowed);
    row.title = tab.url;
    $("tab-host").textContent = hostOf(tab.url);
    $("tab-title").textContent = tab.allowed ? tab.title : "fuera de la allowlist";
  }
  refreshQuick();
}

/** Un atajo que solo puede acabar en error es peor que no ofrecerlo; el title dice por que. */
function refreshQuick(): void {
  const box = $("quick");
  box.hidden = running || tab === null;
  const motivo =
    llm !== null && !llm.ready
      ? "El servidor no tiene modelo configurado."
      : tab !== null && !tab.allowed
        ? `${hostOf(tab.url)} no esta en la allowlist: anadelo en Opciones.`
        : "";
  for (const chip of box.querySelectorAll("button")) {
    chip.disabled = motivo !== "";
    chip.title = motivo;
  }
}

// --- Pintado de la conversacion -------------------------------------------

function toolLine(entry: TranscriptEntry & { kind: "tool" }): HTMLElement {
  const box = document.createElement("details");
  box.className = "tool";
  const summary = document.createElement("summary");
  const mark = document.createElement("span");
  mark.textContent = entry.ok === undefined ? "..." : entry.ok ? "✓" : "✕";
  mark.style.color = entry.ok === false ? "var(--bad)" : entry.ok ? "var(--ok)" : "var(--muted)";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = entry.name;
  summary.append(mark, name);
  box.append(summary);

  const detail = document.createElement("pre");
  detail.textContent = `${JSON.stringify(entry.input)}\n${entry.summary ?? ""}`.trim();
  box.append(detail);
  return box;
}

function confirmCard(entry: TranscriptEntry & { kind: "confirm" }): HTMLElement {
  const box = document.createElement("div");
  box.className = "confirm";

  const title = document.createElement("h2");
  title.textContent = "Publicar de verdad";
  box.append(title);

  const list = document.createElement("dl");
  const rows: Array<[string, string]> = [
    ["Red", entry.network === "x" ? "X" : "Facebook"],
    ["Cuenta", entry.account ?? "sin comprobar"],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  box.append(list);

  const quote = document.createElement("div");
  quote.className = "quote";
  quote.textContent = entry.text;
  box.append(quote);

  if (entry.answered) {
    const answered = document.createElement("p");
    answered.className = "answered";
    answered.textContent = entry.approved ? "Publicado a peticion tuya." : "Cancelado: no se publico nada.";
    box.append(answered);
    return box;
  }

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const go = document.createElement("button");
  go.className = "go";
  go.textContent = "Publicar";
  go.addEventListener("click", () => answer(entry.confirmId, true));
  const no = document.createElement("button");
  no.textContent = "Cancelar";
  no.addEventListener("click", () => answer(entry.confirmId, false));
  buttons.append(go, no);
  box.append(buttons);
  return box;
}

/**
 * Con proveedores lentos pasan mas de 50 s entre el envio y el primer byte. Sin contador no hay
 * forma de saber si el agente sigue vivo, asi que se dice que esta haciendo y cuanto lleva sin dar
 * senales; cada evento que llega pone el contador a cero.
 */
function activityLabel(): string {
  const last = transcript[transcript.length - 1];
  const what =
    last?.kind === "tool" && last.ok === undefined
      ? `Ejecutando ${last.name}`
      : last?.kind === "assistant" && last.text
        ? "Escribiendo"
        : "Pensando";
  const seconds = Math.round((Date.now() - lastSignAt) / 1_000);
  return seconds < 3 ? `${what}...` : `${what}... ${seconds}s`;
}

/** Esperando a que pulses Publicar o Cancelar: el que tarda eres tu, no el agente. */
function waitingOnUser(): boolean {
  const last = transcript[transcript.length - 1];
  return last?.kind === "confirm" && !last.answered;
}

function refreshActivity(): void {
  const active = running && !waitingOnUser();
  $("activity").hidden = !active;
  if (!active) {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
    return;
  }
  $("activity-text").textContent = activityLabel();
  activityTimer ??= setInterval(() => ($("activity-text").textContent = activityLabel()), 1_000);
}

function render(): void {
  // El usuario puede estar leyendo algo mas arriba: solo se sigue el final si ya estaba ahi.
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  logEl.replaceChildren();

  if (transcript.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      'Dile que hacer sobre la pagina que tienes al lado: "resume esto", "de que va esto". Abajo tienes atajos.';
    logEl.append(empty);
  }

  for (const entry of transcript) {
    if (entry.kind === "user") {
      const div = document.createElement("div");
      div.className = "user";
      div.textContent = entry.text;
      logEl.append(div);
    } else if (entry.kind === "assistant") {
      const div = document.createElement("div");
      div.className = "assistant";
      if (entry.reasoning) {
        const think = document.createElement("div");
        think.className = "reasoning";
        think.textContent = entry.reasoning;
        div.append(think);
      }
      div.append(document.createTextNode(entry.text));
      logEl.append(div);
    } else if (entry.kind === "tool") {
      logEl.append(toolLine(entry));
    } else if (entry.kind === "confirm") {
      logEl.append(confirmCard(entry));
    } else {
      const div = document.createElement("div");
      div.className = "error";
      div.textContent = entry.code ? `${entry.message} (${entry.code})` : entry.message;
      logEl.append(div);
    }
  }

  sendEl.textContent = running ? "Detener" : "Enviar";
  sendEl.classList.toggle("stop", running);
  refreshActivity();
  refreshQuick();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function answer(confirmId: string, approved: boolean): void {
  post({ type: "confirm", confirmId, approved });
  transcript = answerConfirm(transcript, confirmId, approved);
  render();
}

// --- Mensajes del worker ---------------------------------------------------

port.onMessage.addListener((update: PanelUpdate) => {
  switch (update.type) {
    case "snapshot":
      transcript = update.transcript;
      if (!running && update.running) lastSignAt = Date.now();
      running = update.running;
      break;
    case "event":
      transcript = applyEvent(transcript, update.event);
      lastSignAt = Date.now();
      if (update.event.type === "done" || update.event.type === "error") running = false;
      break;
    case "running":
      running = update.running;
      break;
  }
  render();
});

// --- Interaccion -----------------------------------------------------------

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (running) {
    post({ type: "cancel" });
    running = false;
    render();
    return;
  }
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = "";
  promptEl.style.height = "auto";
  post({ type: "prompt", text });
});

// Enter envia, Shift+Enter hace salto de linea: es lo que espera cualquiera en un chat.
promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $<HTMLFormElement>("composer").requestSubmit();
  }
});

promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 120)}px`;
});

$("reset").addEventListener("click", () => post({ type: "reset" }));

$("reconnect").addEventListener("click", async () => {
  $("state").textContent = "Reconectando...";
  await chrome.runtime.sendMessage({ type: "webbot:reconnect" });
  setTimeout(() => void renderStatus(), 600);
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Los atajos mandan la instruccion tal cual: el worker devuelve el snapshot con la entrada ya puesta.
$("quick").addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-prompt]");
  if (!chip || chip.disabled || running) return;
  post({ type: "prompt", text: chip.dataset.prompt ?? "" });
});

chrome.tabs.onActivated.addListener(() => void renderTab());
chrome.windows.onFocusChanged.addListener(() => void renderTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Sin fila visible tambien interesa: un chrome:// que navega a una pagina normal la hace aparecer.
  const mine = tab === null || tab.tabId === tabId;
  const visible = changeInfo.url !== undefined || changeInfo.title !== undefined || changeInfo.status === "complete";
  if (mine && visible) void renderTab();
});

post({ type: "sync" });
void renderStatus();
void renderTab();
