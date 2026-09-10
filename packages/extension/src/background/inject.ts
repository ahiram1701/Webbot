import { ErrorCodes } from "@webbot/shared";

import { installWebbotRuntime, type WebbotApi } from "../content/runtime.js";
import { assertAllowed, WebbotError } from "./allowlist.js";

/** Resultado normalizado que devuelve el wrapper inyectado en la pagina. */
type RuntimeOutcome = { ok: true; value: unknown } | { ok: false; message: string; code?: string };

export async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new WebbotError(
      `No existe ninguna pestana con id ${tabId}. Usa webbot_list_tabs para ver las abiertas.`,
      ErrorCodes.TAB_NOT_FOUND,
    );
  }
}

/** Toda accion sobre una pestana pasa por aqui: sin url permitida, no se inyecta nada. */
export async function requireAllowedTab(tabId: number, allowlist: string[]): Promise<chrome.tabs.Tab> {
  const tab = await getTab(tabId);
  assertAllowed(tab.url ?? "", allowlist);
  return tab;
}

/** Espera a que la pestana termine de cargar; resuelve enseguida si ya estaba lista. */
export async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const tab = await getTab(tabId);
  if (tab.status === "complete") return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new WebbotError(`La pestana ${tabId} no termino de cargar en ${timeoutMs} ms.`, ErrorCodes.TIMEOUT));
    }, timeoutMs);

    const listener = (updatedId: number, info: { status?: string }): void => {
      if (updatedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Inyecta el runtime (idempotente) y llama a uno de sus metodos.
 *
 * El wrapper captura los errores dentro de la pagina y los devuelve como datos: si dejaramos que
 * la excepcion saliera de executeScript, Chrome la aplanaria a un mensaje generico y perderiamos
 * el codigo de error que el agente necesita para reaccionar.
 */
export async function callRuntime<T = unknown>(
  tabId: number,
  method: keyof WebbotApi,
  args: unknown = {},
): Promise<T> {
  await chrome.scripting.executeScript({ target: { tabId }, func: installWebbotRuntime });

  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [method as string, args],
    func: (name: string, payload: unknown) => {
      const api = (globalThis as unknown as { __webbot?: Record<string, (input: unknown) => unknown> }).__webbot;
      const method = api?.[name];
      if (typeof method !== "function") {
        return { ok: false, message: `El runtime de Webbot no expone '${name}'.` };
      }
      return Promise.resolve()
        .then(() => method(payload))
        .then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            code: (error as { webbotCode?: string })?.webbotCode,
          }),
        );
    },
  });

  const outcome = frame?.result as RuntimeOutcome | undefined;
  if (!outcome) throw new WebbotError("La pagina no devolvio ningun resultado.", ErrorCodes.BAD_REQUEST);
  if (!outcome.ok) throw new WebbotError(outcome.message, outcome.code ?? ErrorCodes.BAD_REQUEST);
  return outcome.value as T;
}
