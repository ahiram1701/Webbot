import { z } from "zod";

import { ExtractModeSchema, FieldSpecSchema, NetworkSchema, TargetSchema, type Command } from "@webbot/shared";

/**
 * Catalogo unico de herramientas. Lo consumen los dos cerebros posibles: el servidor MCP, que las
 * registra para un agente externo, y el bucle del panel, que se las describe al modelo. Estaban
 * escritas a mano dentro de mcpServer.ts; con dos consumidores, duplicarlas era garantizar que
 * acabaran diciendo cosas distintas.
 */
export interface WebbotTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  /** Raw shape de zod: es lo que pide registerTool, y de aqui sale tambien el JSON Schema. */
  shape: S;
  toCommand(args: z.infer<z.ZodObject<S>>): Command;
}

/** Deja escribir cada entrada con su shape concreto sin perder el tipo comun de la lista. */
function tool<S extends z.ZodRawShape>(definition: WebbotTool<S>): WebbotTool {
  return definition as unknown as WebbotTool;
}

const tabId = z.number().int().describe("Id de pestana (de webbot_list_tabs o webbot_open_tab).");

export const WEBBOT_TOOLS: WebbotTool[] = [
  tool({
    name: "webbot_list_tabs",
    description:
      "Lista las pestanas abiertas en Chrome con id, url, titulo y cual esta activa. Read-only. " +
      "Es el punto de partida: casi todo lo demas necesita un tabId.",
    shape: {},
    toCommand: () => ({ type: "browser.listTabs" }),
  }),

  tool({
    name: "webbot_open_tab",
    description: "Abre una pestana nueva en la URL indicada y espera a que cargue. Devuelve el tabId.",
    shape: {
      url: z.string().url(),
      active: z
        .boolean()
        .optional()
        .describe("true = pasa a primer plano. Por defecto false, trabaja en segundo plano."),
    },
    toCommand: ({ url, active }) => ({ type: "browser.openTab", url, active }),
  }),

  tool({
    name: "webbot_close_tab",
    description: "Cierra una pestana.",
    shape: { tabId },
    toCommand: ({ tabId: id }) => ({ type: "browser.closeTab", tabId: id }),
  }),

  tool({
    name: "webbot_navigate",
    description: "Navega una pestana existente a otra URL y espera a que termine de cargar.",
    shape: { tabId, url: z.string().url(), timeoutMs: z.number().int().positive().optional() },
    toCommand: ({ tabId: id, url, timeoutMs }) => ({ type: "browser.navigate", tabId: id, url, timeoutMs }),
  }),

  tool({
    name: "webbot_wait_for",
    description:
      "Espera a que aparezca un elemento en la pagina (util tras un clic que carga contenido por AJAX). " +
      "Falla con element_not_found si se agota el tiempo.",
    shape: { tabId, target: TargetSchema, timeoutMs: z.number().int().positive().optional() },
    toCommand: ({ tabId: id, target, timeoutMs }) => ({ type: "page.waitFor", tabId: id, target, timeoutMs }),
  }),

  tool({
    name: "webbot_extract",
    description:
      "Extrae el contenido de texto de una pestana. mode='readable' (por defecto) devuelve titulo, metadatos y " +
      "el texto limpio del articulo; 'full' todo el texto visible; 'selectors' solo los campos que pidas. " +
      "Si el dominio tiene perfil registrado se aplica solo y se indica en 'profile'.",
    shape: {
      tabId,
      mode: ExtractModeSchema.optional(),
      selectors: z
        .record(z.string(), FieldSpecSchema)
        .optional()
        .describe("Campos a medida, p. ej. {\"precio\":{\"css\":\".price\"},\"tags\":{\"css\":\".tag\",\"all\":true}}."),
      maxChars: z.number().int().positive().optional().describe("Corta el texto a esta longitud. Por defecto 100000."),
    },
    toCommand: ({ tabId: id, mode, selectors, maxChars }) => ({
      type: "page.extract",
      tabId: id,
      mode,
      selectors,
      maxChars,
    }),
  }),

  tool({
    name: "webbot_links",
    description: "Lista los enlaces de la pagina con su texto y href, opcionalmente filtrados.",
    shape: {
      tabId,
      contains: z.string().optional().describe("Filtra por subcadena en el href o en el texto."),
      sameOrigin: z.boolean().optional().describe("true = solo enlaces del mismo dominio."),
    },
    toCommand: ({ tabId: id, contains, sameOrigin }) => ({ type: "page.links", tabId: id, contains, sameOrigin }),
  }),

  tool({
    name: "webbot_outline",
    description:
      "Radiografia de los elementos interactivos de la pagina: rol, nombre accesible, texto, si es visible y un " +
      "selector sugerido para cada uno. USA ESTO ANTES del primer clic para saber que existe realmente en vez de " +
      "adivinar selectores. Si hay un dialogo o banner abierto lo devuelve en 'dialog': mientras este ahi, lo " +
      "demas de la lista no se puede pulsar.",
    shape: { tabId, maxNodes: z.number().int().positive().optional().describe("Por defecto 200.") },
    toCommand: ({ tabId: id, maxNodes }) => ({ type: "page.outline", tabId: id, maxNodes }),
  }),

  tool({
    name: "webbot_describe",
    description:
      "Inspecciona los elementos que encajan con un target, INCLUIDOS LOS OCULTOS. Es la herramienta para " +
      "averiguar por que algo no se deja pulsar: dice si cada coincidencia es visible y si esta deshabilitada. " +
      "Usala cuando un clic falle con element_not_found o element_not_visible, antes de reintentar a ciegas.",
    shape: { tabId, target: TargetSchema },
    toCommand: ({ tabId: id, target }) => ({ type: "page.describe", tabId: id, target }),
  }),

  tool({
    name: "webbot_screenshot",
    description:
      "Captura la parte visible de la pestana como PNG. Sirve para ver la distribucion (que tapa que, donde " +
      "esta algo) cuando webbot_outline no lo aclara; para leer texto es mejor webbot_extract. Trae la pestana " +
      "al primer plano, asi que no la pidas por costumbre.",
    shape: { tabId },
    toCommand: ({ tabId: id }) => ({ type: "page.screenshot", tabId: id }),
  }),

  tool({
    name: "webbot_click",
    description:
      "Hace clic en un elemento (boton, enlace, checkbox...). Lo desplaza a la vista y dispara un clic real. " +
      "Espera a que la pagina reaccione y devuelve en 'after' que provoco: url y titulo nuevos, los elementos " +
      "que aparecieron y desaparecieron, y el dialogo abierto si lo hay. NO hace falta un webbot_outline " +
      "detras: leer 'after' es mas barato y ademas refleja la pagina ya repintada.",
    shape: {
      tabId,
      target: TargetSchema,
      waitAfterMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe("Pausa EXTRA tras el clic. No suele hacer falta: ya se espera a que la pagina se asiente."),
    },
    toCommand: ({ tabId: id, target, waitAfterMs }) => ({ type: "page.click", tabId: id, target, waitAfterMs }),
  }),

  tool({
    name: "webbot_type",
    description:
      "Escribe texto en un input, textarea o contenteditable, disparando los eventos que esperan React/Vue " +
      "(no basta con asignar el valor). submit:true envia el formulario con Enter al terminar. " +
      "Con clear:true y text vacio limpia el campo, tambien en editores como los composers de Facebook y X. " +
      "Devuelve 'after' con lo que cambio en la pagina, igual que webbot_click.",
    shape: {
      tabId,
      target: TargetSchema,
      text: z.string(),
      clear: z.boolean().optional().describe("true = vacia el campo antes de escribir."),
      submit: z.boolean().optional(),
    },
    toCommand: ({ tabId: id, target, text, clear, submit }) => ({
      type: "page.type",
      tabId: id,
      target,
      text,
      clear,
      submit,
    }),
  }),

  tool({
    name: "webbot_scroll",
    description: "Desplaza la pagina. Util para disparar carga infinita antes de extraer.",
    shape: {
      tabId,
      direction: z.enum(["up", "down", "top", "bottom"]),
      amount: z.number().int().positive().optional().describe("Pixeles para up/down. Por defecto una pantalla."),
    },
    toCommand: ({ tabId: id, direction, amount }) => ({ type: "page.scroll", tabId: id, direction, amount }),
  }),

  tool({
    name: "webbot_post_social",
    description:
      "Publica un post en Facebook o X usando la sesion ya iniciada en el navegador del usuario. " +
      "PUBLICA DE VERDAD Y SIN CONFIRMACION: es una accion publica e irreversible sobre la cuenta real. " +
      "Pide permiso explicito al usuario antes de llamarla con dryRun:false. " +
      "Con dryRun:true rellena el composer, localiza el boton de publicar y se detiene sin pulsarlo, " +
      "devolviendo en 'account' la cuenta activa: usalo siempre antes de publicar. " +
      "Trae la pestana de la red al primer plano, porque en segundo plano Chrome congela la pagina.",
    shape: {
      network: NetworkSchema,
      text: z.string().min(1).describe("Texto del post. En X el limite practico son 280 caracteres."),
      dryRun: z.boolean().optional().describe("true = simula sin pulsar Publicar. Por defecto false."),
      expectedAccount: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Obligatorio con dryRun:false. Cuenta con la que debe salir el post, tal como la devolvio el dryRun en " +
            "'account': '@usuario' en X, nombre visible del perfil o pagina en Facebook. Si no coincide, se aborta.",
        ),
    },
    toCommand: ({ network, text, dryRun, expectedAccount }) => ({
      type: "social.post",
      network,
      text,
      dryRun,
      expectedAccount,
    }),
  }),

  tool({
    name: "webbot_flow_list",
    description: "Lista los flujos guardados en la extension con su descripcion y variables.",
    shape: {},
    toCommand: () => ({ type: "flow.list" }),
  }),

  tool({
    name: "webbot_flow_run",
    description:
      "Ejecuta un flujo guardado: una secuencia de pasos (navegar, esperar, clic, escribir, extraer) definida una " +
      "vez y reutilizable. Devuelve el resultado de cada paso.",
    shape: {
      name: z.string(),
      vars: z.record(z.string(), z.string()).optional().describe("Sustituye los marcadores {{var}} del flujo."),
    },
    toCommand: ({ name, vars }) => ({ type: "flow.run", name, vars }),
  }),
];

/** Para resolver por nombre lo que pide el modelo. */
export const WEBBOT_TOOLS_BY_NAME = new Map(WEBBOT_TOOLS.map((entry) => [entry.name, entry]));

/**
 * Alcance de la publicacion, comun a los dos cerebros. Va aparte de CONDUCIR porque no habla de
 * como moverse por la pagina sino de que esta y que no esta soportado, que es lo que evita que el
 * agente se invente un camino a mano.
 */
const ALCANCE_PUBLICAR =
  "webbot_post_social escribe en el muro o el perfil, y eso es TODO lo que sabe hacer: no comparte una publicacion que ya existe, no publica dentro de un grupo, no elige audiencia ni destinatarios. Si te piden algo de eso, dilo y para; no lo montes a mano con webbot_click por la interfaz. Publicar a base de clics se salta la comprobacion de con que cuenta se publica y, en el panel, la tarjeta con la que la persona aprueba: acabarias publicando sin que nadie te lo haya confirmado.";

/** Como se conduce la pagina. Igual para los dos cerebros. */
const CONDUCIR = [
  "Webbot conduce el Chrome del usuario a traves de una extension MV3: extrae texto, hace clic y escribe en paginas, y publica en Facebook/X.",
  "Flujo tipico: 1) webbot_list_tabs o webbot_open_tab para tener un tabId. 2) webbot_outline para VER que hay en la pagina y descubrir el selector del boton o campo. 3) webbot_click / webbot_type para actuar. 4) webbot_extract para leer el resultado.",
  "webbot_click, webbot_type y webbot_scroll esperan a que la pagina se asiente y devuelven en 'after' la url y el titulo nuevos, que elementos aparecieron y cuales desaparecieron, y el dialogo abierto si lo hay. Encadena leyendo ese 'after' en vez de repetir webbot_outline tras cada accion: gastas la mitad de pasos y ademas ves la pagina ya repintada.",
  "Si 'after.dialog' no es null hay una capa encima bloqueando la pagina (un banner de cookies, un modal): resuelvela primero pulsando algo de 'dialog.elements', porque hasta entonces lo demas no responde.",
  "Cuando un clic falle con element_not_found o element_not_visible, usa webbot_describe con ese mismo target antes de reintentar: ve tambien los elementos ocultos y dice si estan deshabilitados.",
  "webbot_outline es la herramienta clave antes de interactuar: devuelve roles, textos y un selector sugerido por elemento. No adivines selectores, miralos primero.",
  "Los targets aceptan css, xpath, text, role o name y se combinan como AND; usa 'index' para desempatar.",
  "webbot_extract aplica automaticamente un perfil por dominio si existe; el campo 'selectors' de la llamada lo sobrescribe.",
  "NO DIGAS QUE HICISTE ALGO QUE NO HICISTE. No afirmes que publicaste, compartiste, enviaste o guardaste nada si no tienes en este mismo turno el resultado de la herramienta que lo prueba: webbot_post_social devuelve posted:true solo cuando publico de verdad, y con dryRun:true devuelve posted:false porque no publico nada. Si una herramienta fallo, si la persona cancelo, o si simplemente no llegaste a llamarla, dilo tal cual. Quedarte a medias y decirlo es una respuesta correcta; dar por hecho lo que no paso, no.",
  "Solo se puede actuar sobre dominios de la allowlist configurada en la extension; si un comando falla con domain_blocked, el usuario debe anadir el dominio en Opciones.",
];

/**
 * Publicar es lo unico que cambia segun quien pregunte, y por eso no puede ser texto compartido.
 *
 * Por MCP hay una persona leyendo la conversacion, asi que el permiso se pide por escrito. En el
 * panel hay una tarjeta con botones que para el bucle antes de tocar nada, asi que pedirlo ademas
 * por escrito deja al agente esperando un "si" que la persona ya no tiene que escribir: el ensayo
 * completo enseño justo eso, un dryRun seguido de una pregunta y ninguna tarjeta.
 */
const PUBLICAR_MCP =
  "webbot_post_social PUBLICA DE VERDAD, sin confirmacion. Haz siempre primero dryRun:true: devuelve en 'account' la cuenta con la que se publicaria (en Facebook puede ser una pagina y no el perfil). Confirma esa cuenta y el texto con el usuario, y solo entonces publica con dryRun:false pasando expectedAccount; sin el, o si no coincide, la publicacion se aborta sin tocar nada.";

const PUBLICAR_PANEL =
  "webbot_post_social publica de verdad cuando dryRun no es true. Haz siempre primero dryRun:true: devuelve en 'account' la cuenta con la que saldria (en Facebook puede ser una pagina y no el perfil). Despues llama OTRA VEZ con dryRun:false y expectedAccount con esa cuenta, sin preguntar nada por escrito: al hacerlo, el panel ensena automaticamente una tarjeta con el texto y la cuenta, y la persona decide ahi con dos botones. No le pidas que escriba 'si' ni esperes su respuesta en el chat, porque no va a llegar; si le pides permiso por escrito la publicacion se queda a medias.";

/** `audience` decide como se pide permiso para publicar, que es lo unico que difiere. */
export function webbotInstructions(audience: "mcp" | "panel"): string {
  const publicar = audience === "mcp" ? PUBLICAR_MCP : PUBLICAR_PANEL;
  return [...CONDUCIR.slice(0, -1), publicar, ALCANCE_PUBLICAR, CONDUCIR[CONDUCIR.length - 1]].join(" ");
}

/** Las que ve un agente externo por MCP. */
export const WEBBOT_INSTRUCTIONS = webbotInstructions("mcp");
