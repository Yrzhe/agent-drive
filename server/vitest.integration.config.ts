import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function here(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      { find: "@defs", replacement: here("./src/defs/index.ts") },
      { find: /^edgespark\/http$/u, replacement: here("./test/integration/stubs/edgespark-http.ts") },
      { find: /^edgespark$/u, replacement: here("./test/integration/stubs/edgespark.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
  },
});
