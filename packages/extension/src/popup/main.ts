import { getLog, getSettings } from "../background/settings.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id} en el popup.`);
  return el as T;
};

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)}m`;
  return `hace ${Math.round(seconds / 3600)}h`;
}

async function render(): Promise<void> {
  const [settings, log, session] = await Promise.all([
    getSettings(),
    getLog(),
    chrome.storage.session.get({ connected: false, connectionDetail: "" }),
  ]);

  const connected = Boolean(session.connected);
  $("dot").classList.toggle("on", connected);
  $("state").textContent = connected ? "Conectado" : "Desconectado";
  $("detail").textContent = String(session.connectionDetail ?? "");

  $("port").textContent = `127.0.0.1:${settings.bridgePort}`;
  $("token").textContent = settings.token ? "configurado" : "sin configurar";
  $("allow").textContent = settings.allowlist.includes("*")
    ? "todos (*)"
    : `${settings.allowlist.length} dominio(s)`;

  const list = $("log");
  list.replaceChildren();
  if (log.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sin actividad todavia.";
    list.append(empty);
    return;
  }
  for (const entry of log) {
    const item = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = entry.ok ? "✓" : "✕";
    mark.style.color = entry.ok ? "var(--ok)" : "var(--bad)";
    const command = document.createElement("span");
    command.className = "cmd";
    command.textContent = entry.command;
    if (entry.detail) command.title = entry.detail;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = relativeTime(entry.at);
    item.append(mark, command, time);
    list.append(item);
  }
}

$("reconnect").addEventListener("click", async () => {
  $("state").textContent = "Reconectando...";
  await chrome.runtime.sendMessage({ type: "webbot:reconnect" });
  setTimeout(() => void render(), 600);
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

void render();
