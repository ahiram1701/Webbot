import { ErrorCodes } from "@webbot/shared";

export class WebbotError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WebbotError";
  }
}

/** Quita el "www." para que la allowlist no dependa de ese detalle. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Un dominio esta permitido si la allowlist contiene "*" o un sufijo suyo. El match es por
 * etiquetas completas: "github.com" permite "gist.github.com" pero no "evilgithub.com".
 */
export function isAllowed(url: string, allowlist: string[]): boolean {
  if (allowlist.includes("*")) return true;
  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(url);
    host = normalizeHost(parsed.hostname);
    protocol = parsed.protocol;
  } catch {
    return false;
  }
  if (protocol !== "http:" && protocol !== "https:") return false;
  return allowlist.some((entry) => {
    const needle = normalizeHost(entry.trim());
    if (!needle) return false;
    return host === needle || host.endsWith(`.${needle}`);
  });
}

/** Igual que isAllowed pero lanzando el error que el agente vera con su codigo. */
export function assertAllowed(url: string, allowlist: string[]): void {
  if (isAllowed(url, allowlist)) return;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // Se deja la url tal cual en el mensaje.
  }
  throw new WebbotError(
    `El dominio '${host}' no esta en la allowlist de Webbot. Anadelo en la pagina de Opciones de la ` +
      `extension si quieres que el agente pueda actuar ahi.`,
    ErrorCodes.DOMAIN_BLOCKED,
  );
}
