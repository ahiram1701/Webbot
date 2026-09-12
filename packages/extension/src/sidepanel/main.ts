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

const port = chrome.runtime.connect({ name: PANEL_PORT });
const post = (message: PanelMessage): void => port.postMessage(message);

// --- Estado de la conexion -------------------------------------------------

async function renderStatus(): Promise<void> {
  const [settings, session] = await Promise.all([
    getSettings(),
    chrome.storage.session.get({ connected: false, connectionDetail: "" }),
  ]);
  const connected = Boolean(session.connected);
  $("dot").classList.toggle("on", connected);
  $("state").textContent = connected ? "Conectado" : "Desconectado";
  const allow = settings.allowlist.includes("*") ? "todos los dominios" : `${settings.allowlist.length} dominio(s)`;
  $("detail").textContent = connected
    ? `127.0.0.1:${settings.bridgePort} - ${allow}`
    : String(session.connectionDetail ?? "");
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "session" || area === "local") void renderStatus();
});

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

function render(): void {
  // El usuario puede estar leyendo algo mas arriba: solo se sigue el final si ya estaba ahi.
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  logEl.replaceChildren();

  if (transcript.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = 'Dile que hacer. Por ejemplo: "abre example.com y dime de que va".';
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
      running = update.running;
      break;
    case "event":
      transcript = applyEvent(transcript, update.event);
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

post({ type: "sync" });
void renderStatus();
