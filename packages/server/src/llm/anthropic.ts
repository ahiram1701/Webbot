import Anthropic from "@anthropic-ai/sdk";

import { ErrorCodes } from "@webbot/shared";

import {
  LlmError,
  type LlmConversation,
  type LlmHandlers,
  type LlmInput,
  type LlmProvider,
  type LlmTool,
  type LlmTurn,
} from "./types.js";

/** Con streaming no hay riesgo de timeout HTTP, asi que el tope es solo una red de seguridad. */
const MAX_TOKENS = 64_000;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** El razonamiento adaptativo devuelve 400 en los Claude anteriores a la familia 4.6. */
  thinking: boolean;
  /** Solo para los tests: un cliente ya construido. */
  client?: Anthropic;
}

/** Traduce los errores del SDK a algo accionable; un stack en el panel no ayuda a nadie. */
function translate(error: unknown): LlmError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError(
      "Anthropic rechazo la clave. Revisa WEBBOT_LLM_API_KEY (o ANTHROPIC_API_KEY) en el .env del servidor.",
      ErrorCodes.LLM_UNAUTHORIZED,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError("Anthropic esta limitando las peticiones. Espera un momento y reintenta.", ErrorCodes.LLM_ERROR);
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError(`Anthropic devolvio ${error.status ?? "un error"}: ${error.message}`, ErrorCodes.LLM_ERROR);
  }
  if (error instanceof Error) return new LlmError(error.message, ErrorCodes.LLM_ERROR);
  return new LlmError(String(error), ErrorCodes.LLM_ERROR);
}

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  return {
    label: `anthropic:${options.model}`,
    start(system: string, tools: LlmTool[]): LlmConversation {
      const toolParams = tools.map((entry) => ({
        name: entry.name,
        description: entry.description,
        input_schema: entry.schema as Anthropic.Tool["input_schema"],
      }));
      // El historial se guarda en formato nativo: los bloques de razonamiento vuelven intactos.
      const messages: Anthropic.MessageParam[] = [];

      return {
        async send(input: LlmInput, handlers: LlmHandlers, signal: AbortSignal): Promise<LlmTurn> {
          if (input.kind === "user") {
            messages.push({ role: "user", content: input.text });
          } else {
            messages.push({
              role: "user",
              content: input.results.map((result) => ({
                type: "tool_result" as const,
                tool_use_id: result.id,
                content: result.content,
                is_error: !result.ok,
              })),
            });
          }

          let message: Anthropic.Message;
          try {
            const stream = client.messages.stream(
              {
                model: options.model,
                max_tokens: MAX_TOKENS,
                system,
                tools: toolParams,
                messages,
                ...(options.thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
              },
              { signal },
            );
            stream.on("text", (delta) => handlers.onText(delta));
            stream.on("thinking", (delta) => handlers.onReasoning?.(delta));
            message = await stream.finalMessage();
          } catch (error) {
            throw translate(error);
          }

          messages.push({ role: "assistant", content: message.content });

          let text = "";
          const toolCalls: LlmTurn["toolCalls"] = [];
          for (const block of message.content) {
            if (block.type === "text") text += block.text;
            else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
          }

          if (message.stop_reason === "refusal") {
            const category = (message as { stop_details?: { category?: string | null } }).stop_details?.category;
            throw new LlmError(
              `El modelo declino la peticion${category ? ` (${category})` : ""}.`,
              ErrorCodes.LLM_ERROR,
            );
          }

          const stop =
            message.stop_reason === "tool_use" ? "tools" : message.stop_reason === "max_tokens" ? "length" : "end";
          return { text, toolCalls, stop };
        },
      };
    },
  };
}
