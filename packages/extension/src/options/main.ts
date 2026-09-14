import { FlowSchema, type Flow, type LlmChoice } from "@webbot/shared";

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
const visionInput = $<HTMLInputElement>("vision");
const autoPublishInput = $<HTMLInputElement>("autoPublish");
const status = $("status");

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
  visionInput.checked = settings.llm?.vision ?? false;
  autoPublishInput.checked = settings.autoPublish;
}

/**
 * Sin proveedor o sin modelo se devuelve null, que significa 'manda el .env del servidor'. Es
 * mejor eso que guardar media eleccion y dejar al panel sin modelo sin haberlo pedido.
 */
function parseChoice(): LlmChoice | null {
  const provider = providerInput.value.trim();
  const model = modelInput.value.trim();
  if (!provider || !model) return null;
  if (provider !== "anthropic" && provider !== "openai") throw new Error(`Proveedor desconocido: ${provider}.`);
  const baseUrl = baseUrlInput.value.trim();
  if (provider === "anthropic" && baseUrl) {
    throw new Error("La URL base solo se usa con el proveedor openai; con anthropic dejala vacia.");
  }
  return { provider, model, ...(baseUrl ? { baseUrl } : {}), vision: visionInput.checked };
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

void load();
