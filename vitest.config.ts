import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
      // Los tests que necesiten DOM lo piden por fichero con: // @vitest-environment jsdom
  },
});
