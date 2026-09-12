import { ErrorCodes } from "@webbot/shared";

import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiProvider } from "./openai.js";
import { LlmError, type LlmProvider } from "./types.js";

export * from "./types.js";
export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAiProvider } from "./openai.js";

export interface LlmConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl: string;
  thinking: boolean;
}

/**
 * Devuelve null en vez de lanzar cuando no hay nada configurado: el camino MCP no necesita modelo
 * y el servidor tiene que arrancar igual. Quien se queda sin agente es el panel, y se lo decimos.
 */
export function createProvider(config: LlmConfig | null): LlmProvider | null {
  if (!config) return null;
  if (config.provider === "anthropic") {
    if (!config.apiKey) {
      throw new LlmError(
        "Falta la clave del modelo: pon WEBBOT_LLM_API_KEY (o ANTHROPIC_API_KEY) en el .env del servidor.",
        ErrorCodes.LLM_NOT_CONFIGURED,
      );
    }
    return createAnthropicProvider({ apiKey: config.apiKey, model: config.model, thinking: config.thinking });
  }
  // Un modelo local (Ollama, LM Studio) no pide clave, asi que aqui solo hace falta la URL.
  return createOpenAiProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });
}
