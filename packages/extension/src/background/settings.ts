import { DEFAULT_BRIDGE_PORT, type Flow } from "@webbot/shared";

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
}

export const DEFAULT_SETTINGS: WebbotSettings = {
  token: "",
  bridgePort: DEFAULT_BRIDGE_PORT,
  // Arranca con lo justo para el caso de uso pedido; el resto se anade desde Opciones.
  allowlist: ["x.com", "twitter.com", "facebook.com", "wikipedia.org", "github.com", "news.ycombinator.com", "example.com"],
  flows: {},
};

export async function getSettings(): Promise<WebbotSettings> {
  // chrome.storage tipa las claves como un registro suelto; los valores se validan justo debajo.
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS } as Record<string, unknown>);
  return {
    token: typeof stored.token === "string" ? stored.token : "",
    bridgePort: typeof stored.bridgePort === "number" ? stored.bridgePort : DEFAULT_BRIDGE_PORT,
    allowlist: Array.isArray(stored.allowlist) ? (stored.allowlist as string[]) : DEFAULT_SETTINGS.allowlist,
    flows: (stored.flows as Record<string, Flow>) ?? {},
  };
}

export async function saveSettings(patch: Partial<WebbotSettings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Ultimas acciones ejecutadas, para que el popup muestre que esta haciendo el agente. */
export interface ActionLogEntry {
  at: number;
  command: string;
  ok: boolean;
  detail?: string;
}

const LOG_KEY = "actionLog";
const LOG_LIMIT = 40;

export async function appendLog(entry: ActionLogEntry): Promise<void> {
  const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
  const log = [entry, ...((stored[LOG_KEY] as ActionLogEntry[]) ?? [])].slice(0, LOG_LIMIT);
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

export async function getLog(): Promise<ActionLogEntry[]> {
  const stored = await chrome.storage.local.get({ [LOG_KEY]: [] });
  return (stored[LOG_KEY] as ActionLogEntry[]) ?? [];
}
