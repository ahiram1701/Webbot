import { ErrorCodes } from "@webbot/shared";

import {
  LlmError,
  type LlmConversation,
  type LlmHandlers,
  type LlmInput,
  type LlmProvider,
  type LlmTool,
  type LlmToolCall,
  type LlmTurn,
} from "./types.js";

/**
 * Adaptador generico contra /chat/completions. Es el formato que hablan OpenAI, Groq, OpenRouter,
 * DeepSeek, Mistral, la capa de compatibilidad de Gemini, Ollama y LM Studio, asi que un solo
 * adaptador cubre todo lo que no es Anthropic: cambiar de proveedor es cambiar baseUrl y modelo.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  vision?: boolean;
  /** Solo para los tests. */
  fetchImpl?: FetchLike;
}

/** Un mensaje multimodal se manda por partes; el texto suelto sigue valiendo como string. */
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Una llamada a herramienta a medio montar: llega troceada entre varios chunks. */
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamOutcome {
  text: string;
  toolCalls: PartialToolCall[];
  finishReason: string | null;
}

/**
 * Lee el cuerpo SSE hasta `data: [DONE]`. Lo delicado son las tool_calls: el nombre y los
 * argumentos vienen partidos entre chunks, identificados solo por su `index`, asi que hay que
 * acumular y parsear el JSON al final, nunca por el camino.
 */
async function readStream(response: Response, handlers: LlmHandlers): Promise<StreamOutcome> {
  const body = response.body;
  if (!body) throw new LlmError("El proveedor no devolvio cuerpo en la respuesta.", ErrorCodes.LLM_ERROR);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | null = null;
  const partials = new Map<number, PartialToolCall>();

  const handleChunk = (raw: string): void => {
    if (raw === "[DONE]") return;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(raw);
    } catch {
      return; // comentarios de keepalive y demas ruido
    }
    if (chunk.error?.message) throw new LlmError(chunk.error.message, ErrorCodes.LLM_ERROR);

    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;
    if (delta.content) {
      text += delta.content;
      handlers.onText(delta.content);
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) handlers.onReasoning?.(reasoning);

    for (const [position, call] of (delta.tool_calls ?? []).entries()) {
      const index = call.index ?? position;
      const partial = partials.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) partial.id = call.id;
      if (call.function?.name) partial.name += call.function.name;
      if (call.function?.arguments) partial.arguments += call.function.arguments;
      partials.set(index, partial);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Los eventos SSE se separan por linea; el ultimo trozo puede venir a medias.
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) handleChunk(line.slice(5).trim());
      newline = buffer.indexOf("\n");
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) handleChunk(rest.slice(5).trim());

  return {
    text,
    toolCalls: [...partials.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    finishReason,
  };
}

async function translateHttpError(response: Response): Promise<LlmError> {
  const detail = await response.text().catch(() => "");
  const trimmed = detail.slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return new LlmError(
      `El proveedor rechazo la clave (${response.status}). Revisa WEBBOT_LLM_API_KEY en el .env del servidor.`,
      ErrorCodes.LLM_UNAUTHORIZED,
    );
  }
  return new LlmError(`El proveedor devolvio ${response.status}${trimmed ? `: ${trimmed}` : ""}.`, ErrorCodes.LLM_ERROR);
}

export function createOpenAiProvider(options: OpenAiOptions): LlmProvider {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    label: `openai:${options.model}`,
    vision: options.vision ?? false,
    start(system: string, tools: LlmTool[]): LlmConversation {
      const toolParams = tools.map((entry) => ({
        type: "function" as const,
        function: { name: entry.name, description: entry.description, parameters: entry.schema },
      }));
      const messages: ChatMessage[] = [{ role: "system", content: system }];

      return {
        async send(input: LlmInput, handlers: LlmHandlers, signal: AbortSignal): Promise<LlmTurn> {
          if (input.kind === "user") {
            messages.push({ role: "user", content: input.text });
          } else {
            // Aqui va un mensaje por llamada, no un bloque con todas: es lo que espera este formato.
            for (const result of input.results) {
              messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
              // Asimetria real con Anthropic, que admite la imagen dentro del tool_result:
              // /chat/completions solo acepta texto en un mensaje role:"tool", asi que la captura
              // tiene que ir detras como mensaje del usuario. Es la via estandar del formato.
              if (result.image) {
                messages.push({
                  role: "user",
                  content: [
                    { type: "text", text: `Captura devuelta por ${result.name}:` },
                    {
                      type: "image_url",
                      image_url: { url: `data:${result.image.mediaType};base64,${result.image.base64}` },
                    },
                  ],
                });
              }
            }
          }

          const response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: options.model,
              messages,
              stream: true,
              // Algunos proveedores rechazan una lista vacia, asi que el campo solo viaja si hay algo.
              ...(toolParams.length > 0 ? { tools: toolParams, tool_choice: "auto" } : {}),
            }),
            signal,
          });

          if (!response.ok) throw await translateHttpError(response);

          const outcome = await readStream(response, handlers);

          const toolCalls: LlmToolCall[] = [];
          for (const [position, call] of outcome.toolCalls.entries()) {
            let parsed: unknown = {};
            try {
              parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
            } catch {
              throw new LlmError(
                `El modelo mando argumentos ilegibles para '${call.name}': ${call.arguments.slice(0, 200)}`,
                ErrorCodes.LLM_ERROR,
              );
            }
            toolCalls.push({ id: call.id || `call_${position}`, name: call.name, input: parsed });
          }

          messages.push({
            role: "assistant",
            content: outcome.text || null,
            ...(toolCalls.length > 0
              ? {
                  tool_calls: toolCalls.map((call, position) => ({
                    id: call.id,
                    type: "function" as const,
                    function: { name: call.name, arguments: outcome.toolCalls[position]?.arguments ?? "{}" },
                  })),
                }
              : {}),
          });

          // Hay proveedores que no mandan finish_reason:"tool_calls"; si hay llamadas, mandan ellas.
          const stop: LlmTurn["stop"] =
            toolCalls.length > 0 ? "tools" : outcome.finishReason === "length" ? "length" : "end";
          return { text: outcome.text, toolCalls, stop };
        },
      };
    },
  };
}
