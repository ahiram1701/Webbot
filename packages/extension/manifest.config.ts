import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json" with { type: "json" };

/**
 * Permisos: `scripting` para inyectar los content scripts bajo demanda (no se declara ningun
 * content script estatico, asi nada se ejecuta en paginas que el usuario no ha pedido tocar),
 * `alarms` como red de seguridad del keepalive del service worker, `storage` para el token,
 * la allowlist y los flujos guardados, y `sidePanel` para el chat desde el que se le pide trabajo.
 *
 * El panel sustituye al popup: un popup se cierra en cuanto se hace clic en la pagina, y el agente
 * hace clic en la pagina constantemente, asi que la conversacion se perderia de vista a cada paso.
 *
 * `host_permissions` pide <all_urls> porque el agente puede necesitar cualquier dominio, pero la
 * allowlist de la pagina de Opciones es la que decide de verdad donde se permite actuar.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Webbot",
  version: pkg.version,
  description: "Extrae texto, automatiza clics y publica en redes sociales. Se le pide desde su panel o por MCP.",
  minimum_chrome_version: "116",
  permissions: ["tabs", "scripting", "storage", "alarms", "sidePanel"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_title: "Webbot",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
});
