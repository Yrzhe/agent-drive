# agent-drive

Agent-native private cloud drive built on EdgeSpark (Cloudflare Workers + D1 + R2).
See `README.md`, `CLAUDE.md`, `server/CLAUDE.md`, and `web/CLAUDE.md` for product and coding details.

## Cursor Cloud specific instructions

Three independent components, each with its own `package.json` (install per-directory):

| Component | Path | Runs in cloud VM? | Lint / Test / Build |
|-----------|------|-------------------|---------------------|
| `adrive` CLI | `cli/` | Yes (fully local) | `npm run check` (tsc), `npm test` (vitest), `npm run build` |
| Web SPA | `web/` | Yes (Vite dev server) | `npm run lint`, `npm run typecheck`, `npm run build`, `npm run dev` |
| EdgeSpark server | `server/` | No (typecheck only) | `npm run typecheck` |

Non-obvious caveats:

- **The `server/` Worker cannot be built/run/deployed in this environment.** It targets the proprietary EdgeSpark platform; the `edgespark` CLI is not on the public npm registry, and `db migrate` / `storage apply` / `deploy` all require remote platform auth (browser login). Only `npm run typecheck` works locally. Code imports the virtual `edgespark` / `edgespark/http` modules, typed via `server/src/__generated__/*.d.ts` (do not edit generated files or `drizzle/`).
- **`web` dev server proxies `/api` → `http://localhost:8787`** (see `web/vite.config.ts`), which is the EdgeSpark server that does not run locally. So pages that fetch data/auth (Dashboard, Guide, Bundles, Trash) will show load errors, but **client-side-only pages render fully** — notably `/connect` (MCP connector wizard with live scope picker + path validation). Use `/connect` for backend-free UI verification.
- **`adrive` CLI live commands need a deployed instance.** `adrive login` / `whoami` / `sync` all call the remote MCP endpoint, so they fail without a real Agent Drive URL. The CLI's logic is covered by its vitest suite (`cli/ npm test`), which runs fully offline.
- **`web` lint currently reports 2 pre-existing violations** (`src/pages/ConnectSetupPage.tsx` no-control-regex, `src/vite-env.d.ts` unused type param). These are in committed code, not setup issues.
- `web`/`server` lockfiles are gitignored (regenerated on install); only `cli/package-lock.json` is committed.
