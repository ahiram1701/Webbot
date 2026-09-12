import type { PanelContext } from "@webbot/shared";

import { isAllowed } from "./allowlist.js";
import { getSettings } from "./settings.js";

/**
 * La pestana que la persona tiene delante. La usan los dos lados del panel: el worker para
 * adjuntarla a la instruccion y el panel para ensenar de que pagina se esta hablando.
 *
 * Devuelve null cuando no hay nada sobre lo que actuar (una pagina interna de Chrome, una pestana
 * de extension, un about:blank). Eso no es lo mismo que "no permitida": una no se ensena siquiera,
 * la otra se ensena avisando, porque se arregla anadiendo el dominio en Opciones.
 */
export async function activeTab(): Promise<PanelContext | null> {
  // Desde el service worker no existe `currentWindow`; la ultima ventana enfocada es aquella en la
  // que la persona acaba de escribir.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined || !tab.url) return null;

  let protocol: string;
  try {
    protocol = new URL(tab.url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "http:" && protocol !== "https:") return null;

  const { allowlist } = await getSettings();
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? "",
    allowed: isAllowed(tab.url, allowlist),
  };
}
