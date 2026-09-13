import { z } from "zod";

/**
 * Version del protocolo del puente. La extension y el servidor deben coincidir.
 *
 * v2: social.post exige expectedAccount para publicar y las peticiones llevan su plazo. Se subio
 * para que una extension sin recargar, que ignoraria ambas protecciones, no llegue a conectarse.
 *
 * v3: la extension puede iniciar (tramas agent.*). Una extension sin recargar no entenderia los
 * eventos del agente y el panel se quedaria mudo, asi que mejor que no conecte y lo diga.
 */
export const PROTOCOL_VERSION = 3;
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
  z.object({ type: z.literal("page.describe"), tabId, target: TargetSchema }),
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

  z.object({
    type: z.literal("social.post"),
    network: NetworkSchema,
    text: z.string().min(1),
    dryRun: z.boolean().optional(),
    expectedAccount: z.string().min(1).optional(),
    groups: z.array(z.string()).optional().describe("Solo Facebook: grupos en los que compartir ademas del muro. Cada nombre selecciona como mucho uno."),
  }),

  z.object({ type: z.literal("flow.list") }),
  z.object({ type: z.literal("flow.run"), name: z.string(), vars: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("flow.save"), name: z.string(), steps: z.array(z.unknown()) }),

  z.object({ type: z.literal("config.get") }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];

// ---------------------------------------------------------------------------
// Agente en el panel
// ---------------------------------------------------------------------------

/** Tope de iteraciones de un run: un modelo confundido no puede dar vueltas para siempre. */
export const AGENT_MAX_STEPS = 30;

/**
 * La pestana que la persona tiene delante cuando escribe en el panel. Viaja con la instruccion para
 * que "esto" o "aqui" signifiquen algo sin que el modelo tenga que listar pestanas para adivinarlo.
 */
export const PanelContextSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  allowed: z.boolean().describe("Si el dominio esta en la allowlist de la extension."),
});
export type PanelContext = z.infer<typeof PanelContextSchema>;

/**
 * Lo que el servidor cuenta de si mismo al conectar. Sin esto, que no haya modelo configurado solo
 * se descubre mandando un mensaje y viendolo fallar, que es tarde y no se parece a un diagnostico.
 */
export const LlmStatusSchema = z.object({
  ready: z.boolean().describe("Si el panel puede ejecutar instrucciones."),
  model: z.string().optional().describe("Etiqueta del proveedor, p. ej. anthropic:claude-opus-5."),
  reason: z.string().optional().describe("Por que no hay modelo, en la frase que se le ensena a la persona."),
});
export type LlmStatus = z.infer<typeof LlmStatusSchema>;

/**
 * Modelo elegido desde Opciones, que gana al del .env del servidor. La CLAVE NO ESTA AQUI a
 * proposito: vive solo en el .env, porque chrome.storage.local lo lee cualquiera con acceso al
 * perfil y ademas tendria que viajar por el puente. El servidor empareja la eleccion con la clave
 * que ya tiene para ese proveedor.
 */
export const LlmChoiceSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
  baseUrl: z.string().optional().describe("Solo para openai: el endpoint compatible."),
  vision: z.boolean().optional(),
  thinking: z.boolean().optional(),
});
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

/**
 * Quien pidio el comando. Viaja con cada peticion para que el registro de la extension pueda decir
 * si algo lo hizo un agente externo o tu mismo desde el panel, que es la pregunta que se le hace.
 */
export const RequestOriginSchema = z.enum(["mcp", "panel", "cli"]);
export type RequestOrigin = z.infer<typeof RequestOriginSchema>;

/**
 * Lo que el servidor cuenta al panel mientras trabaja. El panel pinta cada evento segun llega, asi
 * que `text` y `reasoning` son deltas, no el mensaje entero.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reasoning"), delta: z.string() }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("tool"), callId: z.string(), name: z.string(), input: z.unknown() }),
  /** `code` deja al panel reaccionar al tipo de fallo sin tener que leer el texto del resumen. */
  z.object({
    type: z.literal("toolResult"),
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    code: z.string().optional(),
  }),
  /** Publicacion de verdad: el bucle se para aqui hasta que llegue un agent.confirm. */
  z.object({
    type: z.literal("confirm"),
    confirmId: z.string(),
    network: NetworkSchema,
    text: z.string(),
    account: z.string().optional(),
    /**
     * Grupos en los que se compartira ademas del muro. Va en la tarjeta a proposito: aprobar
     * "publicar en Facebook" sin saber que ademas sale en cinco grupos no es aprobarlo.
     */
    groups: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("done"), steps: z.number().int() }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ---------------------------------------------------------------------------
// Frames del puente WebSocket
// ---------------------------------------------------------------------------

export const ErrorShapeSchema = z.object({ message: z.string(), code: z.string().optional() });
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

export const FrameSchema = z.discriminatedUnion("kind", [
  /** extension -> servidor, primer frame tras conectar. */
  /**
   * `llm` es como se cambia de modelo desde Opciones: viaja en el hello y no en una trama aparte
   * porque el servidor tiene que haberlo aplicado antes de contestar con el welcome, que es donde
   * anuncia con que modelo se quedo. Cambiarlo en Opciones reconecta, y asi no hay que inventar
   * ni un canal de push ni que pasa con una conversacion a medias con otro modelo detras.
   */
  z.object({
    kind: z.literal("hello"),
    token: z.string(),
    version: z.number().int(),
    agent: z.string().optional(),
    llm: LlmChoiceSchema.optional(),
  }),
  /** servidor -> extension, acepta el hello y se presenta. */
  z.object({ kind: z.literal("welcome"), version: z.number().int(), llm: LlmStatusSchema.optional() }),
  /** servidor -> extension. */
  z.object({
    kind: z.literal("request"),
    id: z.string(),
    command: CommandSchema,
    origin: RequestOriginSchema.optional(),
    /**
     * Cuanto va a esperar el servidor. La extension lo convierte en un plazo limite para que una
     * accion irreversible que llegue tarde (pestana congelada, pagina lenta) se aborte en vez de
     * ejecutarse cuando ya nadie espera la respuesta.
     */
    timeoutMs: z.number().int().positive().optional(),
  }),
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

  /**
   * Unica direccion en la que manda la extension: el panel pide ejecutar una instruccion y el
   * servidor le devuelve eventos. Las herramientas que el modelo decida usar bajan despues como
   * tramas `request` normales, asi que la allowlist y los plazos se aplican igual que siempre.
   *
   * `context` es opcional a proposito y no sube PROTOCOL_VERSION: una extension sin recargar
   * simplemente no lo manda y el servidor sigue funcionando como hasta ahora. Los saltos a v2 y v3
   * existen porque una extension vieja se saltaria protecciones o se quedaria muda; esto no.
   */
  z.object({
    kind: z.literal("agent.start"),
    runId: z.string(),
    prompt: z.string().min(1),
    context: PanelContextSchema.optional(),
  }),
  z.object({ kind: z.literal("agent.cancel"), runId: z.string() }),
  z.object({ kind: z.literal("agent.confirm"), runId: z.string(), confirmId: z.string(), approved: z.boolean() }),
  z.object({ kind: z.literal("agent.event"), runId: z.string(), event: AgentEventSchema }),
]);
export type Frame = z.infer<typeof FrameSchema>;

export type RequestFrame = Extract<Frame, { kind: "request" }>;
export type ResponseFrame = Extract<Frame, { kind: "response" }>;
/** Las que manda la extension por iniciativa propia. */
export type AgentFrame = Extract<Frame, { kind: `agent.${string}` }>;

/** Codigos de error que el servidor traduce a mensajes utiles para el agente. */
export const ErrorCodes = {
  NOT_CONNECTED: "not_connected",
  TIMEOUT: "timeout",
  DOMAIN_BLOCKED: "domain_blocked",
  ELEMENT_NOT_FOUND: "element_not_found",
  ELEMENT_NOT_VISIBLE: "element_not_visible",
  TAB_NOT_FOUND: "tab_not_found",
  COMPOSER_NOT_FOUND: "composer_not_found",
  POST_BUTTON_DISABLED: "post_button_disabled",
  COMPOSER_TEXT_MISMATCH: "composer_text_mismatch",
  ACCOUNT_REQUIRED: "account_required",
  ACCOUNT_MISMATCH: "account_mismatch",
  TAB_HIDDEN: "tab_hidden",
  DEADLINE_EXCEEDED: "deadline_exceeded",
  BAD_REQUEST: "bad_request",
  /** El panel pidio algo pero el servidor no tiene modelo configurado en su .env. */
  LLM_NOT_CONFIGURED: "llm_not_configured",
  LLM_UNAUTHORIZED: "llm_unauthorized",
  LLM_ERROR: "llm_error",
  AGENT_MAX_STEPS: "agent_max_steps",
  AGENT_CANCELLED: "agent_cancelled",
} as const;

/**
 * Publicar en Facebook encadena abrir el dialogo, escribir, avanzar de pantalla y confirmar: en el
 * peor caso pasa de los 30 s del timeout general. Los comandos que pueden publicar esperan mas.
 */
export const SOCIAL_POST_TIMEOUT_MS = 90_000;

/** Plazo que el servidor concede a un comando. */
export function timeoutFor(command: Command, baseMs: number): number {
  const canPost = command.type === "social.post" || command.type === "flow.run";
  return canPost ? Math.max(baseMs, SOCIAL_POST_TIMEOUT_MS) : baseMs;
}
