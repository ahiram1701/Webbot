import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import { DEFAULT_BRIDGE_PORT, DEFAULT_HTTP_PORT } from "@webbot/shared";

import type { LlmConfig } from "./llm/index.js";

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

/**
 * Configuracion del modelo que mueve el panel de la extension. Todo opcional a proposito: el
 * camino MCP no necesita modelo, asi que sin estas variables el servidor arranca igual y lo unico
 * que se queda sin agente es el panel, que lo dice con un mensaje en vez de fallar al arrancar.
 */
function llmConfig(): LlmConfig | null {
  const provider = process.env.WEBBOT_LLM_PROVIDER?.trim().toLowerCase() || "anthropic";
  if (provider !== "anthropic" && provider !== "openai") {
    log(`WEBBOT_LLM_PROVIDER='${provider}' no existe: usa 'anthropic' u 'openai'. El panel se queda sin agente.`);
    return null;
  }
  const apiKey =
    process.env.WEBBOT_LLM_API_KEY?.trim() ||
    (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY?.trim() : process.env.OPENAI_API_KEY?.trim()) ||
    "";
  const baseUrl = process.env.WEBBOT_LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.WEBBOT_LLM_MODEL?.trim() || (provider === "anthropic" ? "claude-opus-5" : "");

  // Un modelo local no pide clave, pero sin modelo no hay nada que llamar.
  if (!model) return null;
  if (provider === "anthropic" && !apiKey) return null;

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    thinking: (process.env.WEBBOT_LLM_THINKING?.trim().toLowerCase() || "adaptive") !== "off",
    timeoutMs: intFromEnv("WEBBOT_LLM_TIMEOUT_MS", 180_000),
  };
}

export const config = {
  get token(): string {
    return requiredToken();
  },
  llm: llmConfig(),
  bridgePort: intFromEnv("WEBBOT_BRIDGE_PORT", DEFAULT_BRIDGE_PORT),
  bridgeHost: process.env.WEBBOT_BRIDGE_HOST?.trim() || "127.0.0.1",
  httpPort: intFromEnv("WEBBOT_HTTP_PORT", DEFAULT_HTTP_PORT),
  /**
   * El endpoint /mcp no pide token: quien lo alcanza, conduce el navegador. Por eso el
   * transporte HTTP escucha solo en loopback salvo que se pida lo contrario, y lo unico que
   * lo pide es el contenedor, donde docker-compose publica los puertos ya atados a 127.0.0.1.
   */
  httpHost: process.env.WEBBOT_HTTP_HOST?.trim() || "127.0.0.1",
  requestTimeoutMs: intFromEnv("WEBBOT_REQUEST_TIMEOUT_MS", 30_000),
};

/** stdout es el canal del protocolo MCP en modo stdio: todo log va a stderr, siempre. */
export function log(message: string): void {
  process.stderr.write(`[webbot] ${message}\n`);
}
