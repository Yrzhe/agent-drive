import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: ["./src/defs/db_schema.ts", "./src/platform/sites/schema.ts"],
  out: "../platforms/chatgpt-sites/drizzle",
  dialect: "sqlite",
});
