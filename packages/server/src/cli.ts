import { Bridge } from "./bridge.js";
import { config, log } from "./config.js";
import type { Command } from "@webbot/shared";

/**
 * Smoke test manual del puente, sin necesidad de un agente MCP. Levanta el mismo puente que el
 * servidor MCP, espera a que la extension se conecte y ejecuta un solo comando.
 *
 * Ojo: usa el mismo puerto que `npm run mcp`, asi que ejecuta uno u otro, no los dos a la vez.
 */
const USAGE = `
Uso: npm run cli -- <comando> [args]

  status                        Estado de la extension (allowlist, flujos, version)
  tabs                          Lista las pestanas abiertas
  open <url>                    Abre una pestana y devuelve su tabId
  outline <tabId>               Elementos interactivos de la pagina
  extract <tabId> [modo]        Extrae texto (readable | full)
  links <tabId> [contiene]      Lista los enlaces
  click <tabId> <texto>         Hace clic en el elemento cuyo texto coincida
  type <tabId> <css> <texto>    Escribe en el campo indicado
  post <x|facebook> <texto>     Publica (simulado; anade --real para publicar de verdad)
`.trim();

function parseCommand(argv: string[]): Command | null {
  const [name, ...rest] = argv;
  const asTabId = (value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) throw new Error("Falta el tabId (mira `npm run cli -- tabs`).");
    return parsed;
  };

  switch (name) {
    case "status":
      return { type: "config.get" };
    case "tabs":
      return { type: "browser.listTabs" };
    case "open":
      if (!rest[0]) throw new Error("Falta la url.");
      return { type: "browser.openTab", url: rest[0], active: true };
    case "outline":
      return { type: "page.outline", tabId: asTabId(rest[0]) };
    case "extract":
      return { type: "page.extract", tabId: asTabId(rest[0]), mode: rest[1] === "full" ? "full" : "readable" };
    case "links":
      return { type: "page.links", tabId: asTabId(rest[0]), contains: rest[1] };
    case "click":
      if (!rest[1]) throw new Error("Falta el texto del elemento.");
      return { type: "page.click", tabId: asTabId(rest[0]), target: { text: rest[1] } };
    case "type":
      if (!rest[1] || rest[2] === undefined) throw new Error("Uso: type <tabId> <css> <texto>.");
      return { type: "page.type", tabId: asTabId(rest[0]), target: { css: rest[1] }, text: rest.slice(2).join(" ") };
    case "post": {
      const network = rest[0];
      if (network !== "x" && network !== "facebook") throw new Error("La red debe ser 'x' o 'facebook'.");
      const real = rest.includes("--real");
      const text = rest.slice(1).filter((arg) => arg !== "--real").join(" ");
      if (!text) throw new Error("Falta el texto del post.");
      return { type: "social.post", network, text, dryRun: !real };
    }
    default:
      return null;
  }
}

/** Espera a que la extension aparezca en el puente, con un aviso util si no llega. */
async function waitForExtension(bridge: Bridge, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!bridge.connected) {
    if (Date.now() > deadline) {
      throw new Error(
        "La extension no se conecto en 20 s. Comprueba que Chrome esta abierto, que Webbot esta cargada " +
          "en chrome://extensions y que el token de Opciones coincide con WEBBOT_TOKEN.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  let command: Command | null;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!command) {
    console.log(USAGE);
    return;
  }

  const bridge = new Bridge({
    port: config.bridgePort,
    host: config.bridgeHost,
    token: config.token,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  await bridge.start();
  log("esperando a la extension...");
  try {
    await waitForExtension(bridge);
    const result = await bridge.send(command);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

void main();
