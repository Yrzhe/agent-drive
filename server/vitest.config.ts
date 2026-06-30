import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@defs": fileURLToPath(new URL("./src/defs/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
