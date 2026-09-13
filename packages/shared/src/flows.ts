import { z } from "zod";

import { ExtractModeSchema, FieldSpecSchema, NetworkSchema, TargetSchema } from "./protocol.js";

/**
 * Un flujo es una secuencia de pasos guardada en la extension: se define una vez y el agente la
 * invoca por nombre en lugar de reconstruir la misma cadena de comandos cada vez.
 *
 * Todos los campos de texto admiten marcadores {{variable}} que se sustituyen con las `vars` de la
 * llamada, de modo que un mismo flujo sirve para distintas entradas.
 */
export const FlowStepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("open"), url: z.string(), active: z.boolean().optional() }),
  z.object({ do: z.literal("navigate"), url: z.string() }),
  z.object({ do: z.literal("waitFor"), target: TargetSchema, timeoutMs: z.number().int().positive().optional() }),
  z.object({ do: z.literal("click"), target: TargetSchema, waitAfterMs: z.number().int().min(0).optional() }),
  z.object({
    do: z.literal("type"),
    target: TargetSchema,
    text: z.string(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  z.object({
    do: z.literal("scroll"),
    direction: z.enum(["up", "down", "top", "bottom"]),
    amount: z.number().int().positive().optional(),
  }),
  z.object({
    do: z.literal("extract"),
    mode: ExtractModeSchema.optional(),
    selectors: z.record(z.string(), FieldSpecSchema).optional(),
    as: z.string().optional().describe("Nombre con el que devolver este resultado."),
  }),
  z.object({
    do: z.literal("post"),
    network: NetworkSchema,
    text: z.string(),
    dryRun: z.boolean().optional(),
    expectedAccount: z.string().optional().describe("Obligatorio para publicar de verdad: cuenta con la que debe salir."),
    groups: z.array(z.string()).optional().describe("Solo Facebook: grupos en los que compartir ademas del muro. Cada nombre selecciona como mucho uno."),
  }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(0).max(60_000) }),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSchema = z.object({
  description: z.string().optional(),
  steps: z.array(FlowStepSchema).min(1),
});
export type Flow = z.infer<typeof FlowSchema>;

/** Sustituye los marcadores {{nombre}} por su valor. Los que no tengan valor se dejan intactos. */
export function interpolate(text: string, vars: Record<string, string> = {}): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => vars[name] ?? match);
}

/** Aplica `interpolate` recursivamente a todas las cadenas de un paso. */
export function interpolateStep(step: FlowStep, vars: Record<string, string> = {}): FlowStep {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return interpolate(value, vars);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    }
    return value;
  };
  return walk(step) as FlowStep;
}
