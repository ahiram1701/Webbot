import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Command } from "@webbot/shared";

import { Bridge, BridgeError } from "./bridge.js";
import { WEBBOT_INSTRUCTIONS, WEBBOT_TOOLS } from "./tools.js";

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

/**
 * Registra todas las tools contra el puente. Lo comparten el entrypoint stdio y el transporte HTTP,
 * de modo que ambos exponen exactamente la misma superficie. Las definiciones viven en tools.ts,
 * que comparte con el agente del panel.
 */
export function createWebbotMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "webbot", version: "0.1.0" }, { instructions: WEBBOT_INSTRUCTIONS });

  const run = async (command: Command): Promise<ToolResult> => {
    try {
      return ok(await bridge.send(command, "mcp"));
    } catch (error) {
      return fail(error);
    }
  };

  for (const entry of WEBBOT_TOOLS) {
    server.registerTool(
      entry.name,
      { description: entry.description, inputSchema: entry.shape },
      (args: Record<string, unknown>) => run(entry.toCommand(args)),
    );
  }

  // Fuera del catalogo: es la unica que mira el estado del puente en vez de mandarle un comando.
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
        return ok({ connected: true, bridgePort: bridge.port, ...((await bridge.send({ type: "config.get" }, "mcp")) as object) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
