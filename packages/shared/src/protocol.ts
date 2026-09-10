import { z } from "zod";

/** Version del protocolo del puente. La extension y el servidor deben coincidir. */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 8790;
export const DEFAULT_HTTP_PORT = 8791;

// ---------------------------------------------------------------------------
// Localizacion de elementos
// ---------------------------------------------------------------------------

/**
 * Como encontrar un elemento en la pagina. Se pueden combinar criterios: se aplican como AND
 * (p. ej. css:"button" + text:"Aceptar" = el boton cuyo texto contiene "Aceptar"). `index`
 * desempata cuando varios elementos encajan.
 */
export const TargetSchema = z
  .object({
    css: z.string().optional().describe("Selector CSS."),
    xpath: z.string().optional().describe("Expresion XPath. Alternativa a css."),
    text: z.string().optional().describe("Texto visible que debe contener el elemento (case-insensitive)."),
    role: z.string().optional().describe("Rol ARIA implicito o explicito, p. ej. button, link, textbox."),
    name: z.string().optional().describe("Nombre accesible (aria-label, title o texto), case-insensitive."),
    index: z.number().int().min(0).optional().describe("Cual de las coincidencias usar. Por defecto 0."),
  })
  .refine((t) => Boolean(t.css || t.xpath || t.text || t.role || t.name), {
    message: "El target necesita al menos uno de: css, xpath, text, role, name.",
  });
export type Target = z.infer<typeof TargetSchema>;

/** Como extraer un campo concreto de la pagina. */
export const FieldSpecSchema = z.object({
  css: z.string().optional(),
  xpath: z.string().optional(),
  attr: z.string().optional().describe("Atributo a leer. Por defecto el texto del elemento."),
  all: z.boolean().optional().describe("true = devuelve todas las coincidencias como array."),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const ExtractModeSchema = z.enum(["readable", "full", "selectors"]);
export type ExtractMode = z.infer<typeof ExtractModeSchema>;

export const NetworkSchema = z.enum(["facebook", "x"]);
export type Network = z.infer<typeof NetworkSchema>;

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

const tabId = z.number().int().describe("Id de pestana devuelto por browser.listTabs u browser.openTab.");

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser.listTabs") }),
  z.object({ type: z.literal("browser.openTab"), url: z.string().url(), active: z.boolean().optional() }),
  z.object({ type: z.literal("browser.closeTab"), tabId }),
  z.object({ type: z.literal("browser.navigate"), tabId, url: z.string().url(), timeoutMs: z.number().int().optional() }),

  z.object({ type: z.literal("page.waitFor"), tabId, target: TargetSchema, timeoutMs: z.number().int().optional() }),
  z.object({
    type: z.literal("page.extract"),
    tabId,
    mode: ExtractModeSchema.optional(),
    selectors: z.record(z.string(), FieldSpecSchema).optional(),
    maxChars: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("page.links"), tabId, contains: z.string().optional(), sameOrigin: z.boolean().optional() }),
  z.object({ type: z.literal("page.outline"), tabId, maxNodes: z.number().int().positive().optional() }),
  z.object({ type: z.literal("page.click"), tabId, target: TargetSchema, waitAfterMs: z.number().int().optional() }),
  z.object({
    type: z.literal("page.type"),
    tabId,
    target: TargetSchema,
    text: z.string(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("page.scroll"),
    tabId,
    direction: z.enum(["up", "down", "top", "bottom"]),
    amount: z.number().int().optional(),
  }),
  z.object({ type: z.literal("page.screenshot"), tabId }),

  z.object({ type: z.literal("social.post"), network: NetworkSchema, text: z.string().min(1), dryRun: z.boolean().optional() }),

  z.object({ type: z.literal("flow.list") }),
  z.object({ type: z.literal("flow.run"), name: z.string(), vars: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("flow.save"), name: z.string(), steps: z.array(z.unknown()) }),

  z.object({ type: z.literal("config.get") }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];

// ---------------------------------------------------------------------------
// Frames del puente WebSocket
// ---------------------------------------------------------------------------

export const ErrorShapeSchema = z.object({ message: z.string(), code: z.string().optional() });
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export const FrameSchema = z.discriminatedUnion("kind", [
  /** extension -> servidor, primer frame tras conectar. */
  z.object({ kind: z.literal("hello"), token: z.string(), version: z.number().int(), agent: z.string().optional() }),
  /** servidor -> extension, acepta el hello. */
  z.object({ kind: z.literal("welcome"), version: z.number().int() }),
  /** servidor -> extension. */
  z.object({ kind: z.literal("request"), id: z.string(), command: CommandSchema }),
  /** extension -> servidor. */
  z.object({
    kind: z.literal("response"),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: ErrorShapeSchema.optional(),
  }),
  /** Mantiene vivo el service worker de MV3 y detecta cortes. */
  z.object({ kind: z.literal("ping"), t: z.number() }),
  z.object({ kind: z.literal("pong"), t: z.number() }),
]);
export type Frame = z.infer<typeof FrameSchema>;

export type RequestFrame = Extract<Frame, { kind: "request" }>;
export type ResponseFrame = Extract<Frame, { kind: "response" }>;

/** Codigos de error que el servidor traduce a mensajes utiles para el agente. */
export const ErrorCodes = {
  NOT_CONNECTED: "not_connected",
  TIMEOUT: "timeout",
  DOMAIN_BLOCKED: "domain_blocked",
  ELEMENT_NOT_FOUND: "element_not_found",
  TAB_NOT_FOUND: "tab_not_found",
  COMPOSER_NOT_FOUND: "composer_not_found",
  POST_BUTTON_DISABLED: "post_button_disabled",
  BAD_REQUEST: "bad_request",
} as const;
