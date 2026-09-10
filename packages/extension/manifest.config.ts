import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json" with { type: "json" };

/**
 * Permisos: `scripting` para inyectar los content scripts bajo demanda (no se declara ningun
 * content script estatico, asi nada se ejecuta en paginas que el usuario no ha pedido tocar),
 * `alarms` como red de seguridad del keepalive del service worker y `storage` para el token,
 * la allowlist y los flujos guardados.
 *
 * `host_permissions` pide <all_urls> porque el agente puede necesitar cualquier dominio, pero la
 * allowlist de la pagina de Opciones es la que decide de verdad donde se permite actuar.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Webbot",
  version: pkg.version,
  description: "Extrae texto, automatiza clics y publica en redes sociales, controlado por un agente IA via MCP.",
  minimum_chrome_version: "116",
  permissions: ["tabs", "scripting", "storage", "alarms"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Webbot",
  },
  options_page: "src/options/index.html",
});
