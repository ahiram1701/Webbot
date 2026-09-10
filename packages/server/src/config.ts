import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import { DEFAULT_BRIDGE_PORT, DEFAULT_HTTP_PORT } from "@webbot/shared";

/**
 * Los scripts de npm workspaces corren con cwd en packages/server, asi que el .env de la raiz del
 * repo queda fuera del alcance por defecto de dotenv. Se prueban los dos: primero el del directorio
 * desde el que se invoco (util en Docker o al lanzar desde otro sitio) y luego el de la raiz. El
 * primero que defina una clave gana, y dotenv nunca pisa lo que ya venga en process.env.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
loadEnv({ path: [path.resolve(process.cwd(), ".env"), path.join(repoRoot, ".env")] });

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * El token es obligatorio: sin el, cualquier proceso local podria conducir el navegador del
 * usuario a traves del puente.
 */
function requiredToken(): string {
  const token = process.env.WEBBOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Falta WEBBOT_TOKEN. Copia .env.example a .env, pon un token largo y aleatorio, " +
        "y pega el mismo valor en la pagina de opciones de la extension.",
    );
  }
  return token;
}

export const config = {
  get token(): string {
    return requiredToken();
  },
  bridgePort: intFromEnv("WEBBOT_BRIDGE_PORT", DEFAULT_BRIDGE_PORT),
  bridgeHost: process.env.WEBBOT_BRIDGE_HOST?.trim() || "127.0.0.1",
  httpPort: intFromEnv("WEBBOT_HTTP_PORT", DEFAULT_HTTP_PORT),
  requestTimeoutMs: intFromEnv("WEBBOT_REQUEST_TIMEOUT_MS", 30_000),
};

/** stdout es el canal del protocolo MCP en modo stdio: todo log va a stderr, siempre. */
export function log(message: string): void {
  process.stderr.write(`[webbot] ${message}\n`);
}
