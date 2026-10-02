import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@platform": fileURLToPath(new URL("./src/platform/edgespark.ts", import.meta.url)),
      "@users": fileURLToPath(new URL("./src/platform/users.ts", import.meta.url)),
      "@defs": fileURLToPath(new URL("./src/defs/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
