import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { attachAgent } from "./attach.js";
import { Bridge } from "./bridge.js";
import { config, log } from "./config.js";
import { createWebbotMcpServer } from "./mcpServer.js";

/**
 * Entrypoint MCP por HTTP: para agentes que no lanzan subprocesos o que corren en otra maquina.
 * Cada peticion crea su propio server y transporte (modo sin sesion), igual que hace Polybot: es
 * barato y evita tener que gestionar el ciclo de vida de sesiones.
 */
async function main(): Promise<void> {
  const bridge = new Bridge({
    port: config.bridgePort,
    host: config.bridgeHost,
    token: config.token,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  await bridge.start();
  attachAgent(bridge);

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, extensionConnected: bridge.connected, bridgePort: bridge.port });
  });

  app.post("/mcp", async (req, res) => {
    const server = createWebbotMcpServer(bridge);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`error atendiendo /mcp: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.status(500).json({ error: "error interno del servidor MCP" });
    }
  });

  // El modo sin sesion no admite el canal SSE de servidor a cliente ni el cierre de sesion.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ error: "Usa POST /mcp (transporte streamable HTTP sin sesion)." });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(config.httpPort, config.httpHost, () => {
    log(`MCP por HTTP en http://${config.httpHost}:${config.httpPort}/mcp`);
    if (config.httpHost !== "127.0.0.1" && config.httpHost !== "localhost") {
      log(`AVISO: /mcp escucha en ${config.httpHost} y no pide token. Publicalo solo en loopback.`);
    }
  });
}

main().catch((error: unknown) => {
  log(`fallo al arrancar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
