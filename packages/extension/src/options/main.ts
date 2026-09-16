import { FlowSchema, type Flow, type LlmChoice, type LlmStatus } from "@webbot/shared";

import { llmLabel, readLlmStatus } from "../background/llm.js";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../background/settings.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id} en la pagina de opciones.`);
  return el as T;
};

const tokenInput = $<HTMLInputElement>("token");
const portInput = $<HTMLInputElement>("port");
const allowlistInput = $<HTMLTextAreaElement>("allowlist");
const flowsInput = $<HTMLTextAreaElement>("flows");
const providerInput = $<HTMLSelectElement>("provider");
const modelInput = $<HTMLInputElement>("model");
const baseUrlInput = $<HTMLInputElement>("baseUrl");
const visionInput = $<HTMLSelectElement>("vision");
const autoPublishInput = $<HTMLInputElement>("autoPublish");
const status = $("status");
const inUse = $("inuse");

function say(message: string, isError = false): void {
  status.textContent = message;
  status.style.color = isError ? "var(--warn)" : "var(--muted)";
  if (!isError) setTimeout(() => (status.textContent = ""), 2_500);
}

async function load(): Promise<void> {
  const settings = await getSettings();
  tokenInput.value = settings.token;
  portInput.value = String(settings.bridgePort);
  allowlistInput.value = settings.allowlist.join("\n");
  flowsInput.value = JSON.stringify(settings.flows, null, 2);
  providerInput.value = settings.llm?.provider ?? "";
  modelInput.value = settings.llm?.model ?? "";
  baseUrlInput.value = settings.llm?.baseUrl ?? "";
  // Tres estados, no dos: "" es no opinar y dejar que mande el .env.
  visionInput.value = settings.llm?.vision === undefined ? "" : settings.llm.vision ? "on" : "off";
  autoPublishInput.checked = settings.autoPublish;
}

/**
 * Lo que se escribe aqui es un parche sobre el .env del servidor, campo a campo: cada hueco lo
 * rellena el. Solo cuando no hay ni un campo puesto se devuelve null, que es "manda el .env entero".
 *
 * Antes hacia falta proveedor Y modelo o se descartaba la eleccion completa sin decirlo, asi que
 * cambiar solo el modelo se guardaba como "nada" y el panel seguia con el de siempre.
 */
function parseChoice(): LlmChoice | null {
  const crudo = providerInput.value.trim();
  const provider = crudo === "anthropic" || crudo === "openai" ? crudo : undefined;
  if (crudo && !provider) throw new Error(`Proveedor desconocido: ${crudo}.`);
  const model = modelInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const vision = visionInput.value;
  // Solo se protesta si anthropic se eligio a proposito: con el select vacio y un .env de openai,
  // poner una URL base es justo lo que hay que hacer.
  if (provider === "anthropic" && baseUrl) {
    throw new Error("La URL base solo se usa con el proveedor openai; con anthropic dejala vacia.");
  }
  const choice: LlmChoice = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(vision ? { vision: vision === "on" } : {}),
  };
  return Object.keys(choice).length > 0 ? choice : null;
}

/**
 * Con que modelo se quedo el servidor de verdad. Se pinta aqui, al lado de donde se elige, porque
 * una eleccion que no cuaja (un modelo que no existe, una clave que no va con el proveedor) solo se
 * descubria mandando un mensaje al panel y viendolo fallar.
 */
function renderInUse(llm: LlmStatus | null): void {
  if (llm === null) {
    inUse.textContent = "Sin conectar al servidor: no se sabe que modelo esta en uso.";
    inUse.classList.remove("warn");
    return;
  }
  inUse.textContent = llm.ready
    ? `En uso ahora mismo: ${llmLabel(llm)}.`
    : `El panel se ha quedado sin modelo: ${llm.reason ?? ""}`;
  inUse.classList.toggle("warn", !llm.ready);
}

/** Valida los flujos uno a uno para poder decir cual falla, no solo que "el JSON esta mal". */
function parseFlows(raw: string): Record<string, Flow> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`El JSON de flujos no es valido: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Los flujos deben ser un objeto con forma {\"nombre\": {\"steps\": [...]}}.");
  }
  const flows: Record<string, Flow> = {};
  for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
    const parsed = FlowSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Flujo '${name}': ${issue?.path.join(".") ?? ""} ${issue?.message ?? "no encaja con el esquema"}`.trim());
    }
    flows[name] = parsed.data;
  }
  return flows;
}

$("save").addEventListener("click", async () => {
  const port = Number.parseInt(portInput.value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    say("El puerto debe ser un numero entre 1 y 65535.", true);
    return;
  }

  let flows: Record<string, Flow>;
  try {
    flows = parseFlows(flowsInput.value);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), true);
    return;
  }

  let llm: LlmChoice | null;
  try {
    llm = parseChoice();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), true);
    return;
  }

  const allowlist = allowlistInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  await saveSettings({
    token: tokenInput.value.trim(),
    bridgePort: port,
    allowlist,
    flows,
    llm,
    autoPublish: autoPublishInput.checked,
  });
  say("Guardado. La extension reconecta sola con los valores nuevos.");
});

$("reset").addEventListener("click", async () => {
  await saveSettings({ ...DEFAULT_SETTINGS, token: tokenInput.value.trim() });
  await load();
  say("Valores por defecto restaurados (el token se conserva).");
});

// El welcome llega despues de que termine la reconexion, asi que leer el modelo justo tras guardar
// daria el anterior. Se espera a que el service worker lo deje en session y se repinta entonces.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !("llm" in changes)) return;
  renderInUse((changes.llm.newValue as LlmStatus | null) ?? null);
});

void load();
void readLlmStatus().then(renderInUse);
