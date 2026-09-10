import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Bridge } from "./bridge.js";
import { config, log } from "./config.js";
import { createWebbotMcpServer } from "./mcpServer.js";

/**
 * Entrypoint MCP por stdio: lo lanza el cliente (Claude Code, Claude Desktop...) como subproceso.
 * stdout es el canal del protocolo, asi que aqui nunca se escribe en el; todo log va a stderr.
 */
async function main(): Promise<void> {
  const bridge = new Bridge({
    port: config.bridgePort,
    host: config.bridgeHost,
    token: config.token,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  await bridge.start();

  const server = createWebbotMcpServer(bridge);
  await server.connect(new StdioServerTransport());
  log("MCP listo por stdio. Esperando a que la extension se conecte al puente.");

  const shutdown = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log(`fallo al arrancar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
