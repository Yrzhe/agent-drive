import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "dist");
const web = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: path.join(root, "web"), env: { ...process.env, VITE_PLATFORM: "sites" }, stdio: "inherit",
});
if (web.status !== 0) process.exit(web.status || 1);
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "server"), { recursive: true });
await cp(path.join(root, "web/dist"), path.join(output, "client"), { recursive: true });
await build({
  entryPoints: [path.join(root, "server/src/platform/sites/worker.ts")],
  outfile: path.join(output, "server/index.js"),
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  external: ["node:async_hooks"], minify: false, sourcemap: false,
  alias: {
    "@platform": path.join(root, "server/src/platform/sites/context.ts"),
    "@users": path.join(root, "server/src/platform/sites/users.ts"),
    "@defs": path.join(root, "server/src/platform/sites/defs.ts"),
  },
});
const wrangler = {
  name: "agent-drive-sites", main: "index.js", compatibility_date: "2026-08-06", compatibility_flags: ["nodejs_compat"],
  assets: { directory: "../client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: "agent-drive", database_id: "local-preview" }],
  r2_buckets: [{ binding: "BUCKET", bucket_name: "agent-drive" }],
};
await writeFile(path.join(output, "server/wrangler.json"), JSON.stringify(wrangler, null, 2) + "\n");
await cp(path.join(root, "platforms/chatgpt-sites/drizzle"), path.join(output, "drizzle"), { recursive: true });
let manifest;
try { manifest = JSON.parse(await readFile(path.join(root, ".openai/hosting.json"), "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  manifest = JSON.parse(await readFile(path.join(root, "platforms/chatgpt-sites/.openai/hosting.json"), "utf8"));
}
await mkdir(path.join(output, ".openai"), { recursive: true });
await writeFile(path.join(output, ".openai/hosting.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Built Sites Worker, SPA, hosting manifest and D1 migrations in dist/");
