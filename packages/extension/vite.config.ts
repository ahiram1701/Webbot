import { fileURLToPath } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";

import manifest from "./manifest.config.js";

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@webbot/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  build: {
    // El service worker de MV3 no admite `import()` dinamico de chunks externos: que Rollup no
    // trocee el bundle evita el clasico "Cannot use import statement outside a module".
    modulePreload: false,
    target: "chrome116",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
