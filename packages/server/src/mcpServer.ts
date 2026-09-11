import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ExtractModeSchema, FieldSpecSchema, NetworkSchema, TargetSchema, type Command } from "@webbot/shared";

import { Bridge, BridgeError } from "./bridge.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const payload =
    error instanceof BridgeError
      ? { error: error.message, code: error.code }
      : { error: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

const INSTRUCTIONS = [
  "Webbot conduce el Chrome del usuario a traves de una extension MV3: extrae texto, hace clic y escribe en paginas, y publica en Facebook/X.",
  "Flujo tipico: 1) webbot_list_tabs o webbot_open_tab para tener un tabId. 2) webbot_outline para VER que hay en la pagina y descubrir el selector del boton o campo. 3) webbot_click / webbot_type para actuar. 4) webbot_extract para leer el resultado.",
  "webbot_outline es la herramienta clave antes de interactuar: devuelve roles, textos y un selector sugerido por elemento. No adivines selectores, miralos primero.",
  "Los targets aceptan css, xpath, text, role o name y se combinan como AND; usa 'index' para desempatar.",
  "webbot_extract aplica automaticamente un perfil por dominio si existe; el campo 'selectors' de la llamada lo sobrescribe.",
  "webbot_post_social PUBLICA DE VERDAD, sin confirmacion. Haz siempre primero dryRun:true: devuelve en 'account' la cuenta con la que se publicaria (en Facebook puede ser una pagina y no el perfil). Confirma esa cuenta y el texto con el usuario, y solo entonces publica con dryRun:false pasando expectedAccount; sin el, o si no coincide, la publicacion se aborta sin tocar nada.",
  "Solo se puede actuar sobre dominios de la allowlist configurada en la extension; si un comando falla con domain_blocked, el usuario debe anadir el dominio en Opciones.",
].join(" ");

/**
 * Registra todas las tools contra el puente. Lo comparten el entrypoint stdio y el transporte HTTP,
 * de modo que ambos exponen exactamente la misma superficie.
 */
export function createWebbotMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "webbot", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const run = async (command: Command): Promise<ToolResult> => {
    try {
      return ok(await bridge.send(command));
    } catch (error) {
      return fail(error);
    }
  };

  const tabId = z.number().int().describe("Id de pestana (de webbot_list_tabs o webbot_open_tab).");

  // ---- Pestanas y navegacion ----

  server.registerTool(
    "webbot_list_tabs",
    {
      description:
        "Lista las pestanas abiertas en Chrome con id, url, titulo y cual esta activa. Read-only. " +
        "Es el punto de partida: casi todo lo demas necesita un tabId.",
      inputSchema: {},
    },
    () => run({ type: "browser.listTabs" }),
  );

  server.registerTool(
    "webbot_open_tab",
    {
      description: "Abre una pestana nueva en la URL indicada y espera a que cargue. Devuelve el tabId.",
      inputSchema: {
        url: z.string().url(),
        active: z.boolean().optional().describe("true = pasa a primer plano. Por defecto false, trabaja en segundo plano."),
      },
    },
    ({ url, active }) => run({ type: "browser.openTab", url, active }),
  );

  server.registerTool(
    "webbot_close_tab",
    { description: "Cierra una pestana.", inputSchema: { tabId } },
    ({ tabId: id }) => run({ type: "browser.closeTab", tabId: id }),
  );

  server.registerTool(
    "webbot_navigate",
    {
      description: "Navega una pestana existente a otra URL y espera a que termine de cargar.",
      inputSchema: { tabId, url: z.string().url(), timeoutMs: z.number().int().positive().optional() },
    },
    ({ tabId: id, url, timeoutMs }) => run({ type: "browser.navigate", tabId: id, url, timeoutMs }),
  );

  server.registerTool(
    "webbot_wait_for",
    {
      description:
        "Espera a que aparezca un elemento en la pagina (util tras un clic que carga contenido por AJAX). " +
        "Falla con element_not_found si se agota el tiempo.",
      inputSchema: { tabId, target: TargetSchema, timeoutMs: z.number().int().positive().optional() },
    },
    ({ tabId: id, target, timeoutMs }) => run({ type: "page.waitFor", tabId: id, target, timeoutMs }),
  );

  // ---- Extraccion ----

  server.registerTool(
    "webbot_extract",
    {
      description:
        "Extrae el contenido de texto de una pestana. mode='readable' (por defecto) devuelve titulo, metadatos y " +
        "el texto limpio del articulo; 'full' todo el texto visible; 'selectors' solo los campos que pidas. " +
        "Si el dominio tiene perfil registrado se aplica solo y se indica en 'profile'.",
      inputSchema: {
        tabId,
        mode: ExtractModeSchema.optional(),
        selectors: z
          .record(z.string(), FieldSpecSchema)
          .optional()
          .describe('Campos a medida, p. ej. {"precio":{"css":".price"},"tags":{"css":".tag","all":true}}.'),
        maxChars: z.number().int().positive().optional().describe("Corta el texto a esta longitud. Por defecto 100000."),
      },
    },
    ({ tabId: id, mode, selectors, maxChars }) => run({ type: "page.extract", tabId: id, mode, selectors, maxChars }),
  );

  server.registerTool(
    "webbot_links",
    {
      description: "Lista los enlaces de la pagina con su texto y href, opcionalmente filtrados.",
      inputSchema: {
        tabId,
        contains: z.string().optional().describe("Filtra por subcadena en el href o en el texto."),
        sameOrigin: z.boolean().optional().describe("true = solo enlaces del mismo dominio."),
      },
    },
    ({ tabId: id, contains, sameOrigin }) => run({ type: "page.links", tabId: id, contains, sameOrigin }),
  );

  server.registerTool(
    "webbot_outline",
    {
      description:
        "Radiografia de los elementos interactivos de la pagina: rol, nombre accesible, texto, si es visible y un " +
        "selector sugerido para cada uno. USA ESTO ANTES de webbot_click o webbot_type para saber que existe " +
        "realmente en la pagina en vez de adivinar selectores.",
      inputSchema: { tabId, maxNodes: z.number().int().positive().optional().describe("Por defecto 200.") },
    },
    ({ tabId: id, maxNodes }) => run({ type: "page.outline", tabId: id, maxNodes }),
  );

  server.registerTool(
    "webbot_screenshot",
    {
      description: "Captura la parte visible de la pestana activa como PNG en base64 (data URL).",
      inputSchema: { tabId },
    },
    ({ tabId: id }) => run({ type: "page.screenshot", tabId: id }),
  );

  // ---- Interaccion ----

  server.registerTool(
    "webbot_click",
    {
      description:
        "Hace clic en un elemento (boton, enlace, checkbox...). Lo desplaza a la vista y dispara un clic real. " +
        "Devuelve el elemento sobre el que actuo y la URL resultante por si la navegacion cambio.",
      inputSchema: {
        tabId,
        target: TargetSchema,
        waitAfterMs: z.number().int().min(0).max(30_000).optional().describe("Pausa tras el clic. Por defecto 500 ms."),
      },
    },
    ({ tabId: id, target, waitAfterMs }) => run({ type: "page.click", tabId: id, target, waitAfterMs }),
  );

  server.registerTool(
    "webbot_type",
    {
      description:
        "Escribe texto en un input, textarea o contenteditable, disparando los eventos que esperan React/Vue " +
        "(no basta con asignar el valor). submit:true envia el formulario con Enter al terminar. " +
        "Con clear:true y text:\"\" vacia el campo, tambien en editores como los composers de Facebook y X.",
      inputSchema: {
        tabId,
        target: TargetSchema,
        text: z.string(),
        clear: z.boolean().optional().describe("true = vacia el campo antes de escribir."),
        submit: z.boolean().optional(),
      },
    },
    ({ tabId: id, target, text, clear, submit }) => run({ type: "page.type", tabId: id, target, text, clear, submit }),
  );

  server.registerTool(
    "webbot_scroll",
    {
      description: "Desplaza la pagina. Util para disparar carga infinita antes de extraer.",
      inputSchema: {
        tabId,
        direction: z.enum(["up", "down", "top", "bottom"]),
        amount: z.number().int().positive().optional().describe("Pixeles para up/down. Por defecto una pantalla."),
      },
    },
    ({ tabId: id, direction, amount }) => run({ type: "page.scroll", tabId: id, direction, amount }),
  );

  // ---- Redes sociales ----

  server.registerTool(
    "webbot_post_social",
    {
      description:
        "Publica un post en Facebook o X usando la sesion ya iniciada en el navegador del usuario. " +
        "PUBLICA DE VERDAD Y SIN CONFIRMACION: es una accion publica e irreversible sobre la cuenta real. " +
        "Pide permiso explicito al usuario antes de llamarla con dryRun:false. " +
        "Con dryRun:true rellena el composer, localiza el boton de publicar y se detiene sin pulsarlo, " +
        "devolviendo en 'account' la cuenta activa: usalo siempre antes de publicar. " +
        "Trae la pestana de la red al primer plano, porque en segundo plano Chrome congela la pagina.",
      inputSchema: {
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
    },
    ({ network, text, dryRun, expectedAccount }) =>
      run({ type: "social.post", network, text, dryRun, expectedAccount }),
  );

  // ---- Flujos guardados ----

  server.registerTool(
    "webbot_flow_list",
    { description: "Lista los flujos guardados en la extension con su descripcion y variables.", inputSchema: {} },
    () => run({ type: "flow.list" }),
  );

  server.registerTool(
    "webbot_flow_run",
    {
      description:
        "Ejecuta un flujo guardado: una secuencia de pasos (navegar, esperar, clic, escribir, extraer) definida una " +
        "vez y reutilizable. Devuelve el resultado de cada paso.",
      inputSchema: {
        name: z.string(),
        vars: z.record(z.string(), z.string()).optional().describe("Sustituye los marcadores {{var}} del flujo."),
      },
    },
    ({ name, vars }) => run({ type: "flow.run", name, vars }),
  );

  server.registerTool(
    "webbot_status",
    {
      description:
        "Estado de la extension: si esta conectada, version, allowlist de dominios activa y cuantos flujos hay " +
        "guardados. Empieza por aqui si algo falla.",
      inputSchema: {},
    },
    async () => {
      if (!bridge.connected) {
        return ok({
          connected: false,
          bridgePort: bridge.port,
          hint: "La extension no esta conectada. Abre Chrome, revisa que Webbot este activa y que el token y el puerto de Opciones coincidan con el .env del servidor.",
        });
      }
      try {
        return ok({ connected: true, bridgePort: bridge.port, ...(await bridge.send({ type: "config.get" }) as object) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
