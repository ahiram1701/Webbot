import { DEFAULT_BRIDGE_PORT, type Flow, type LlmChoice, type RequestOrigin } from "@webbot/shared";

export interface WebbotSettings {
  /** Debe coincidir con WEBBOT_TOKEN del servidor. Sin el, el puente rechaza la conexion. */
  token: string;
  bridgePort: number;
  /**
   * Dominios sobre los que se permite actuar (sufijos de hostname). "*" desactiva el filtro.
   * Es el limite real de lo que un agente puede tocar en el navegador del usuario.
   */
  allowlist: string[];
  flows: Record<string, Flow>;
  /**
   * Modelo elegido aqui, que gana al del .env del servidor. null = manda el .env. Nunca lleva la
   * clave de API: esa se queda en el servidor, no en el almacenamiento del navegador.
   */
  llm: LlmChoice | null;
}

export const DEFAULT_SETTINGS: WebbotSettings = {
  token: "",
  bridgePort: DEFAULT_BRIDGE_PORT,
  // Arranca con lo justo para el caso de uso pedido; el resto se anade desde Opciones.
  allowlist: ["x.com", "twitter.com", "facebook.com", "wikipedia.org", "github.com", "news.ycombinator.com", "example.com"],
  flows: {},
  llm: null,
};

export async function getSettings(): Promise<WebbotSettings> {
  // chrome.storage tipa las claves como un registro suelto; los valores se validan justo debajo.
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS } as Record<string, unknown>);
  return {
    token: typeof stored.token === "string" ? stored.token : "",
    bridgePort: typeof stored.bridgePort === "number" ? stored.bridgePort : DEFAULT_BRIDGE_PORT,
    allowlist: Array.isArray(stored.allowlist) ? (stored.allowlist as string[]) : DEFAULT_SETTINGS.allowlist,
    flows: (stored.flows as Record<string, Flow>) ?? {},
    llm: (stored.llm as LlmChoice | null) ?? null,
  };
}

export async function saveSettings(patch: Partial<WebbotSettings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/**
 * Ultimas acciones ejecutadas en el navegador. Es la unica forma de saber que ha hecho un agente
 * externo mientras no mirabas: lo que pide el panel ya se ve en su conversacion, lo que llega por
 * MCP no se veia en ningun sitio.
 */
export interface ActionLogEntry {
  at: number;
  command: string;
  ok: boolean;
  /** Sobre que actuo: la url, la pestana, la red social... Sin esto "browser.openTab" no dice nada. */
  target?: string;
  origin?: RequestOrigin;
  detail?: string;
}

const LOG_KEY = "actionLog";
const LOG_LIMIT = 40;
/** Lo ensena el panel para que nadie espere encontrar ahi lo de hace una hora. */
export const ACTION_LOG_LIMIT = LOG_LIMIT;
/** El panel se suscribe a los cambios de esta clave para refrescar el registro en vivo. */
export const ACTION_LOG_KEY = LOG_KEY;

export async function appendLog(entry: ActionLogEntry): Promise<void> {
  const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
  const log = [entry, ...((stored[LOG_KEY] as ActionLogEntry[]) ?? [])].slice(0, LOG_LIMIT);
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

export async function getLog(): Promise<ActionLogEntry[]> {
  const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
  return (stored[LOG_KEY] as ActionLogEntry[]) ?? [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
