import type { LlmStatus } from "@webbot/shared";

/**
 * Como se nombra el modelo del panel donde haga falta. Lo usan la cabecera del panel lateral y la
 * pagina de opciones, y tienen que decir lo mismo: si no coinciden, el sitio donde se elige el
 * modelo y el sitio donde se ve cual esta puesto se contradicen.
 *
 * `null` no es "no hay modelo" sino "no hay nada que decir": el servidor no ha contestado todavia,
 * esta desconectado, o es uno viejo que no manda el dato. Inventarse un "sin modelo" ahi seria
 * senalar un problema que nadie sabe si existe.
 */
export function llmLabel(llm: LlmStatus | null): string | null {
  if (llm === null) return null;
  return llm.ready ? (llm.model ?? "modelo sin nombre") : "sin modelo";
}

/** El estado del modelo que dejo el welcome. Lo escribe el service worker al conectar. */
export async function readLlmStatus(): Promise<LlmStatus | null> {
  const session = await chrome.storage.session.get({ llm: null });
  return (session.llm as LlmStatus | null) ?? null;
}
