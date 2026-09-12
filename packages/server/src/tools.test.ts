import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CommandSchema } from "@webbot/shared";

import { WEBBOT_TOOLS, WEBBOT_TOOLS_BY_NAME } from "./tools.js";

/** Argumentos validos de ejemplo por herramienta, para comprobar que el comando que sale encaja. */
const SAMPLES: Record<string, unknown> = {
  webbot_list_tabs: {},
  webbot_open_tab: { url: "https://example.com/", active: true },
  webbot_close_tab: { tabId: 7 },
  webbot_navigate: { tabId: 7, url: "https://example.com/otra" },
  webbot_wait_for: { tabId: 7, target: { css: ".listo" } },
  webbot_extract: { tabId: 7, mode: "readable" },
  webbot_links: { tabId: 7, contains: "docs" },
  webbot_outline: { tabId: 7, maxNodes: 50 },
  webbot_screenshot: { tabId: 7 },
  webbot_click: { tabId: 7, target: { text: "Aceptar" } },
  webbot_type: { tabId: 7, target: { css: "input" }, text: "hola", submit: true },
  webbot_scroll: { tabId: 7, direction: "down" },
  webbot_post_social: { network: "x", text: "hola", dryRun: true },
  webbot_flow_list: {},
  webbot_flow_run: { name: "buscar", vars: { tema: "zod" } },
};

/**
 * Las tools estaban escritas a mano dentro del servidor MCP; al extraerlas a un catalogo que ahora
 * comparten dos cerebros, lo que hay que blindar es que ninguna se quede por el camino y que todas
 * sigan produciendo un comando que el protocolo acepte.
 */
describe("catalogo de herramientas", () => {
  it("expone exactamente las herramientas que el servidor MCP registraba", () => {
    expect([...WEBBOT_TOOLS_BY_NAME.keys()].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it("no repite nombres", () => {
    expect(WEBBOT_TOOLS_BY_NAME.size).toBe(WEBBOT_TOOLS.length);
  });

  for (const entry of WEBBOT_TOOLS) {
    it(`${entry.name} produce un comando valido`, () => {
      const args = z.object(entry.shape).parse(SAMPLES[entry.name]);
      const parsed = CommandSchema.safeParse(entry.toCommand(args));
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    });

    it(`${entry.name} se puede describir como JSON Schema`, () => {
      // Es como llegan al modelo: si zod no lo sabe convertir, el agente se queda sin la herramienta.
      const schema = z.toJSONSchema(z.object(entry.shape)) as { type?: string; properties?: object };
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(entry.shape).sort());
      expect(entry.description.trim()).not.toBe("");
    });
  }
});
