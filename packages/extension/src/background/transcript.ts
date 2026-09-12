import type { AgentEvent } from "@webbot/shared";

/**
 * La conversacion tal como se pinta. Los eventos del servidor llegan como deltas, asi que alguien
 * tiene que plegarlos en entradas; se hace aqui para que el service worker (que guarda el historial
 * por si el panel se cierra) y el panel (que lo pinta en vivo) no acaben plegando distinto.
 */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning: string }
  | { kind: "tool"; callId: string; name: string; input: unknown; ok?: boolean; summary?: string }
  | {
      kind: "confirm";
      confirmId: string;
      network: string;
      text: string;
      account?: string;
      answered?: boolean;
      approved?: boolean;
    }
  | { kind: "error"; message: string; code?: string };

/** Devuelve una lista nueva: asi el panel puede comparar referencias para saber si repintar. */
export function applyEvent(transcript: TranscriptEntry[], event: AgentEvent): TranscriptEntry[] {
  const next = [...transcript];
  const last = next[next.length - 1];

  switch (event.type) {
    case "text":
    case "reasoning": {
      // Un turno del agente puede alternar razonamiento y texto; van juntos en la misma burbuja.
      const field = event.type === "text" ? "text" : "reasoning";
      if (last?.kind === "assistant") {
        next[next.length - 1] = { ...last, [field]: last[field] + event.delta };
      } else {
        next.push({ kind: "assistant", text: "", reasoning: "", [field]: event.delta } as TranscriptEntry);
      }
      return next;
    }
    case "tool":
      next.push({ kind: "tool", callId: event.callId, name: event.name, input: event.input });
      return next;
    case "toolResult": {
      // Se busca por callId y no por posicion: las llamadas en paralelo no vuelven en orden.
      const index = next.findIndex((entry) => entry.kind === "tool" && entry.callId === event.callId);
      if (index < 0) return next;
      next[index] = { ...(next[index] as TranscriptEntry & { kind: "tool" }), ok: event.ok, summary: event.summary };
      return next;
    }
    case "confirm":
      next.push({
        kind: "confirm",
        confirmId: event.confirmId,
        network: event.network,
        text: event.text,
        account: event.account,
      });
      return next;
    case "error":
      next.push({ kind: "error", message: event.message, code: event.code });
      return next;
    case "done":
      return next;
    default:
      return next;
  }
}

/** Marca respondida la tarjeta de confirmacion, para que no queden dos botones vivos. */
export function answerConfirm(transcript: TranscriptEntry[], confirmId: string, approved: boolean): TranscriptEntry[] {
  return transcript.map((entry) =>
    entry.kind === "confirm" && entry.confirmId === confirmId ? { ...entry, answered: true, approved } : entry,
  );
}
