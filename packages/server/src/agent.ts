import { z } from "zod";

import {
  AGENT_MAX_STEPS,
  ErrorCodes,
  type AgentEvent,
  type AgentFrame,
  type Command,
  type Frame,
} from "@webbot/shared";

import { BridgeError } from "./bridge.js";
import { LlmError, type LlmConversation, type LlmInput, type LlmProvider, type LlmToolResult } from "./llm/index.js";
import { webbotInstructions, WEBBOT_TOOLS, WEBBOT_TOOLS_BY_NAME } from "./tools.js";

/** Lo que el runner necesita del puente. Un interfaz asi de estrecho hace trivial falsearlo. */
export interface AgentBridge {
  send(command: Command): Promise<unknown>;
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

const SYSTEM = [
  webbotInstructions("panel"),
  "Hablas directamente con la persona que usa este navegador a traves de un panel lateral de la extension, no con otro agente.",
  "Responde en el idioma en el que te escriban, en pocas frases y sin volcar JSON crudo: resume lo que encontraste.",
  "Cuando una herramienta falle, lee el codigo de error y corrige: element_not_found se arregla mirando la pagina con webbot_outline, domain_blocked lo tiene que resolver la persona anadiendo el dominio en Opciones.",
].join(" ");

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
}

function summarize(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}...` : flat;
}

/**
 * Serializa el resultado para el modelo. Una captura de pantalla se queda fuera: el data URL ocupa
 * cientos de kilobytes y por este camino el modelo no puede verla de todas formas.
 */
function serializeResult(command: Command, result: unknown): string {
  if (command.type === "page.screenshot" && result && typeof result === "object") {
    const { dataUrl, ...rest } = result as { dataUrl?: string };
    return JSON.stringify({ ...rest, dataUrl: dataUrl ? "[PNG omitido: no viaja al modelo]" : undefined });
  }
  const json = JSON.stringify(result ?? null);
  return json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}... [recortado]` : json;
}

export function createAgentRunner(
  bridge: AgentBridge,
  provider: LlmProvider | null,
  providerError: LlmError | null = null,
  turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
): AgentRunner {
  const runs = new Map<string, Run>();

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
      const result = await bridge.send(command);
      const content = serializeResult(command, result);
      emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: true, summary: summarize(content) });
      return { id: call.id, name: call.name, ok: true, content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof BridgeError ? error.code : undefined;
      const detail = code ? `${code}: ${message}` : message;
      emit(runId, { type: "toolResult", callId: call.id, name: call.name, ok: false, summary: summarize(detail) });
      return { id: call.id, name: call.name, ok: false, content: detail };
    }
  };

  const loop = async (runId: string, run: Run, prompt: string): Promise<void> => {
    let input: LlmInput = { kind: "user", text: prompt };

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

  const start = (runId: string, prompt: string): void => {
    if (!provider) {
      emit(runId, {
        type: "error",
        message:
          providerError?.message ??
          "El servidor no tiene modelo configurado: pon WEBBOT_LLM_PROVIDER, WEBBOT_LLM_MODEL y WEBBOT_LLM_API_KEY en su .env y reinicialo.",
        code: providerError?.code ?? ErrorCodes.LLM_NOT_CONFIGURED,
      });
      return;
    }

    const existing = runs.get(runId);
    if (existing?.busy) {
      emit(runId, { type: "error", message: "Ya hay una instruccion en marcha. Detenla antes de mandar otra." });
      return;
    }

    // El mismo runId continua la conversacion: el panel solo manda texto y el historial vive aqui.
    const run: Run = existing ?? {
      conversation: provider.start(SYSTEM, tools),
      controller: new AbortController(),
      busy: false,
      cancelled: false,
      confirm: null,
    };
    run.controller = new AbortController();
    run.cancelled = false;
    run.busy = true;
    runs.set(runId, run);

    void loop(runId, run, prompt)
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
          start(frame.runId, frame.prompt);
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
  };
}
