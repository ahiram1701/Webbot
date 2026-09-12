/**
 * Capa neutra de modelo. El bucle del agente solo conoce estos tipos, asi que anadir un proveedor
 * es escribir un adaptador, no tocar el bucle.
 *
 * La conversacion tiene estado a proposito: cada adaptador guarda el historial **en su formato
 * nativo** en vez de traducir ida y vuelta desde una forma comun. Asi el de Anthropic conserva sus
 * bloques de razonamiento para devolverlos tal cual en el turno siguiente, y el de OpenAI conserva
 * sus mensajes role:"tool", uno por llamada.
 */

/** Herramienta tal como se le describe al modelo. `schema` es JSON Schema. */
export interface LlmTool {
  name: string;
  description: string;
  schema: unknown;
}

export interface LlmToolResult {
  id: string;
  name: string;
  ok: boolean;
  /** El resultado ya serializado: los adaptadores no inventan formato. */
  content: string;
}

export type LlmInput = { kind: "user"; text: string } | { kind: "toolResults"; results: LlmToolResult[] };

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Por que termino el turno. `tools` es el unico que continua el bucle. */
export type LlmStop = "end" | "tools" | "refusal" | "length";

export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
  stop: LlmStop;
}

export interface LlmHandlers {
  onText(delta: string): void;
  /** Solo lo llaman los proveedores que exponen su razonamiento. */
  onReasoning?(delta: string): void;
}

export interface LlmConversation {
  send(input: LlmInput, handlers: LlmHandlers, signal: AbortSignal): Promise<LlmTurn>;
}

export interface LlmProvider {
  /** Para ensenarlo en el panel: "anthropic:claude-opus-5". */
  readonly label: string;
  start(system: string, tools: LlmTool[]): LlmConversation;
}

/** Error del proveedor ya traducido a algo que el panel pueda ensenar tal cual. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
