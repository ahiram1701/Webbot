import { z } from "zod";

import {
  AGENT_MAX_STEPS,
  ErrorCodes,
  type AgentEvent,
  type AgentFrame,
  type Command,
  type Frame,
  type PanelContext,
  type RequestOrigin,
} from "@webbot/shared";

import { BridgeError } from "./bridge.js";
import {
  LlmError,
  NO_LLM_MESSAGE,
  type LlmConversation,
  type LlmImage,
  type LlmInput,
  type LlmProvider,
  type LlmToolResult,
} from "./llm/index.js";
import { webbotInstructions, WEBBOT_TOOLS, WEBBOT_TOOLS_BY_NAME } from "./tools.js";

/** Lo que el runner necesita del puente. Un interfaz asi de estrecho hace trivial falsearlo. */
export interface AgentBridge {
  send(command: Command, origin: RequestOrigin): Promise<unknown>;
  sendToExtension(frame: Frame): void;
}

/** Sin respuesta a una confirmacion, el run no puede quedarse colgado para siempre. */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
/**
 * Techo por turno del modelo. Generoso a proposito: hay proveedores que tardan un minuto en soltar
 * el primer byte. Lo que evita es que un proveedor que no contesta deje el run esperando para
 * siempre, sin mas salida que el boton Detener.
 */
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
/** Tope de lo que se le devuelve al modelo por herramienta: una extraccion entera lo ahoga. */
const MAX_RESULT_CHARS = 60_000;
/** Lo que se ensena en el panel junto a cada paso. */
const MAX_SUMMARY_CHARS = 300;

/**
 * La linea de la captura solo se dice si el modelo puede verla: invitarle a mirar una foto que no
 * le va a llegar es peor que no ofrecersela, porque gasta un paso y no aclara nada.
 */
function systemPrompt(vision: boolean): string {
  return [
    webbotInstructions("panel"),
    "Hablas directamente con la persona que usa este navegador a traves de un panel lateral de la extension, no con otro agente.",
    "Responde en el idioma en el que te escriban, en pocas frases y sin volcar JSON crudo: resume lo que encontraste.",
    "Cuando una herramienta falle, lee el codigo de error y corrige: element_not_found se arregla mirando la pagina con webbot_outline, domain_blocked lo resuelve la persona con el boton 'Permitir' que sale en el propio paso, asi que dile que dominio hace falta y no lo reintentes hasta que te lo diga.",
    "Cada mensaje puede venir precedido de la pestana que la persona tiene delante: 'esta pagina', 'aqui' o 'lo que estoy viendo' se refieren a ese tabId. Usalo directamente, sin volver a listar pestanas ni abrir una nueva. Si la pestana aparece como NO permitida, dilo y no lo intentes.",
    ...(vision
      ? [
          "Puedes VER la pagina: webbot_screenshot te devuelve la captura y te llega como imagen. Usala cuando el outline no te aclare la distribucion (que tapa que, donde esta algo) o cuando lleves dos intentos fallidos sobre el mismo elemento. Para leer texto sigue siendo mejor webbot_extract, y ojo: la captura trae la pestana al primer plano.",
        ]
      : []),
  ].join(" ");
}

interface PendingConfirm {
  confirmId: string;
  resolve(approved: boolean): void;
  timer: NodeJS.Timeout;
}

interface Run {
  conversation: LlmConversation;
  controller: AbortController;
  busy: boolean;
  cancelled: boolean;
  confirm: PendingConfirm | null;
}

export interface AgentRunner {
  handle(frame: AgentFrame): void;
  /** La extension se fue: lo que estuviera en marcha ya no le importa a nadie. */
  stopAll(): void;
  /**
   * Cambia el modelo de detras. Solo se llama al autenticarse una conexion nueva, cuando la
   * anterior ya disparo stopAll: cambiar de adaptador con una conversacion viva dejaria el
   * historial en un formato nativo que el nuevo no sabe leer.
   */
  use(next: LlmProvider | null, error: LlmError | null): void;
}

function summarize(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}...` : flat;
}

const DATA_URL = /^data:(image\/[a-z+]+);base64,(.+)$/i;

/**
 * Serializa el resultado para el modelo. La captura se saca del JSON siempre: el data URL ocupa
 * cientos de kilobytes y como texto no le dice nada a nadie. Si el proveedor ve imagenes, vuelve
 * aparte como imagen de verdad; si no, se queda en una nota y no se manda.
 */
function serializeResult(command: Command, result: unknown, vision: boolean): { content: string; image?: LlmImage } {
  if (command.type === "page.screenshot" && result && typeof result === "object") {
    const { dataUrl, ...rest } = result as { dataUrl?: string };
    const match = vision && dataUrl ? DATA_URL.exec(dataUrl) : null;
    const image = match?.[1] && match[2] ? { mediaType: match[1], base64: match[2] } : undefined;
    const png = image
      ? "[PNG adjunto]"
      : dataUrl
        ? "[PNG omitido: este modelo no ve imagenes]"
        : undefined;
    return { content: JSON.stringify({ ...rest, png }), image };
  }
  const json = JSON.stringify(result ?? null);
  return { content: json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}... [recortado]` : json };
}

/**
 * El panel sabe que pestana mira la persona, asi que se la cuenta al modelo antes de que piense.
 * Ahorra un webbot_list_tabs por turno y, sobre todo, hace que "esto" o "aqui" signifiquen algo.
 */
function withContext(prompt: string, context?: PanelContext): string {
  if (!context) return prompt;
  const estado = context.allowed ? "permitida" : "NO permitida: esta fuera de la allowlist";
  const titulo = context.title ? `, titulo "${context.title}"` : "";
  const cabecera = `[Pestana que la persona tiene delante: tabId ${context.tabId}, ${context.url}${titulo} (${estado})]`;
  return `${cabecera}\n\n${prompt}`;
}

export function createAgentRunner(
  bridge: AgentBridge,
  provider: LlmProvider | null,
  providerError: LlmError | null = null,
  turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): AgentRunner {
  const runs = new Map<string, Run>();
  // Mutables porque Opciones puede elegir otro modelo: la referencia cambia, el bucle no.
  let current = provider;
  let currentError = providerError;

  const tools = WEBBOT_TOOLS.map((entry) => ({
    name: entry.name,
    description: entry.description,
    schema: z.toJSONSchema(z.object(entry.shape)),
  }));

  const emit = (runId: string, event: AgentEvent): void => {
    bridge.sendToExtension({ kind: "agent.event", runId, event });
  };

  /** Pide permiso al panel y espera. Devuelve false si el usuario dice que no o si se agota. */
  const askConfirmation = (runId: string, run: Run, command: Command & { type: "social.post" }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const confirmId = `${runId}-${Date.now()}`;
      const timer = setTimeout(() => {
        run.confirm = null;
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      run.confirm = {
        confirmId,
        timer,
        resolve: (approved) => {
          clearTimeout(timer);
          run.confirm = null;
          resolve(approved);
        },
      };
      emit(runId, {
        type: "confirm",
        confirmId,
        network: command.network,
        text: command.text,
        account: command.expectedAccount,
        groups: command.groups,
      });
    });

  const runTool = async (
    runId: string,
    run: Run,
    call: { id: string; name: string; input: unknown },
  ): Promise<LlmToolResult> => {
    const entry = WEBBOT_TOOLS_BY_NAME.get(call.name);
    if (!entry) {
      return { id: call.id, name: call.name, ok: false, content: `No existe la herramienta '${call.name}'.` };
    }

    const parsed = z.object(entry.shape).safeParse(call.input ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = `${issue?.path.join(".") ?? ""} ${issue?.message ?? "argumentos invalidos"}`.trim();
      emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: false, summary: detail });
      return { id: call.id, name: call.name, ok: false, content: `Argumentos invalidos: ${detail}` };
    }

    const command = entry.toCommand(parsed.data);
    emit(runId, { type: "tool", callId: call.id, name: call.name, input: parsed.data });

    // Unica puerta manual: publicar de verdad es publico e irreversible.
    if (command.type === "social.post" && command.dryRun !== true) {
      const approved = await askConfirmation(runId, run, command);
      if (!approved) {
        const detail = "La persona cancelo la publicacion desde el panel.";
        emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: false, summary: detail });
        return { id: call.id, name: call.name, ok: false, content: `${detail} No la reintentes sin que te lo pida.` };
      }
    }

    if (run.cancelled) {
      return { id: call.id, name: call.name, ok: false, content: "Ejecucion detenida por la persona." };
    }

    try {
      const result = await bridge.send(command, "panel");
      const { content, image } = serializeResult(command, result, current?.vision ?? false);
      emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: true, summary: summarize(content) });
      return { id: call.id, name: call.name, ok: true, content, image };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof BridgeError ? error.code : undefined;
      const detail = code ? `${code}: ${message}` : message;
      emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: false, summary: summarize(detail), code });
      return { id: call.id, name: call.name, ok: false, content: detail };
    }
  };

  const loop = async (runId: string, run: Run, prompt: string, context?: PanelContext): Promise<void> => {
    let input: LlmInput = { kind: "user", text: withContext(prompt, context) };

    for (let step = 1; step <= AGENT_MAX_STEPS; step += 1) {
      // Dos motivos para abortar, y hay que distinguirlos: detener es del usuario y no merece
      // mensaje de error; agotar el plazo si, porque el proveedor se quedo callado.
      const expired = AbortSignal.timeout(turnTimeoutMs);
      let turn;
      try {
        turn = await run.conversation.send(
          input,
          {
            onText: (delta) => emit(runId, { type: "text", delta }),
            onReasoning: (delta) => emit(runId, { type: "reasoning", delta }),
          },
          AbortSignal.any([run.controller.signal, expired]),
        );
      } catch (error) {
        if (run.cancelled) return;
        if (expired.aborted) {
          throw new LlmError(
            `El modelo no respondio en ${Math.round(turnTimeoutMs / 1_000)} s. Puede ir saturado; ` +
              "reintenta o usa un modelo mas rapido en WEBBOT_LLM_MODEL.",
            ErrorCodes.LLM_ERROR,
          );
        }
        throw error;
      }
      if (run.cancelled) return;

      if (turn.toolCalls.length === 0) {
        emit(runId, { type: "done", steps: step });
        return;
      }

      const results: LlmToolResult[] = [];
      for (const call of turn.toolCalls) {
        results.push(await runTool(runId, run, call));
        if (run.cancelled) return;
      }
      input = { kind: "toolResults", results };
    }

    emit(runId, {
      type: "error",
      message: `El agente dio ${AGENT_MAX_STEPS} pasos sin terminar y se detuvo. Prueba a pedirselo por partes.`,
      code: ErrorCodes.AGENT_MAX_STEPS,
    });
  };

  const start = (runId: string, prompt: string, context?: PanelContext): void => {
    if (!current) {
      emit(runId, {
        type: "error",
        message: currentError?.message ?? NO_LLM_MESSAGE,
        code: currentError?.code ?? ErrorCodes.LLM_NOT_CONFIGURED,
      });
      return;
    }
    const activo = current;

    const existing = runs.get(runId);
    if (existing?.busy) {
      emit(runId, { type: "error", message: "Ya hay una instruccion en marcha. Detenla antes de mandar otra." });
      return;
    }

    // El mismo runId continua la conversacion: el panel solo manda texto y el historial vive aqui.
    const run: Run = existing ?? {
      conversation: activo.start(systemPrompt(activo.vision), tools),
      controller: new AbortController(),
      busy: false,
      cancelled: false,
      confirm: null,
    };
    run.controller = new AbortController();
    run.cancelled = false;
    run.busy = true;
    runs.set(runId, run);

    void loop(runId, run, prompt, context)
      .catch((error: unknown) => {
        if (run.cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof LlmError ? error.code : ErrorCodes.LLM_ERROR;
        emit(runId, { type: "error", message, code });
      })
      .finally(() => {
        run.busy = false;
      });
  };

  const cancel = (runId: string): void => {
    const run = runs.get(runId);
    if (!run) return;
    run.cancelled = true;
    run.confirm?.resolve(false);
    run.controller.abort();
    if (run.busy) {
      emit(runId, { type: "error", message: "Detenido a peticion tuya.", code: ErrorCodes.AGENT_CANCELLED });
    }
    run.busy = false;
  };

  return {
    handle(frame: AgentFrame): void {
      switch (frame.kind) {
        case "agent.start":
          start(frame.runId, frame.prompt, frame.context);
          return;
        case "agent.cancel":
          cancel(frame.runId);
          return;
        case "agent.confirm": {
          const run = runs.get(frame.runId);
          if (run?.confirm?.confirmId === frame.confirmId) run.confirm.resolve(frame.approved);
          return;
        }
        default:
          return;
      }
    },
    stopAll(): void {
      for (const runId of [...runs.keys()]) cancel(runId);
      runs.clear();
    },
    use(next: LlmProvider | null, error: LlmError | null): void {
      current = next;
      currentError = error;
      // Las conversaciones vivas las guarda el adaptador viejo en su formato: no son portables.
      runs.clear();
    },
  };
}
