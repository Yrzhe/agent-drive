# agent-drive

Fullstack EdgeSpark project.

## Structure

- `server/` — Hono API on Cloudflare Workers (see server/CLAUDE.md)
- `web/` — React SPA via Vite (see web/CLAUDE.md)
- `skill/` — Distributable agent skill (SKILL.md + references/), the agent-facing manual for this product
- `configs/` — Project config files (auth)
- `edgespark.toml` — Project configuration

## Agent-Facing Surfaces (MANDATORY sync on every feature)

This product's primary users are agents. Every feature change that adds, removes, or alters an endpoint, MCP tool, scope, or behavior MUST update the matching agent-facing surfaces in the same PR — an undocumented capability does not exist for an agent:

| Surface | File | What it is |
|---|---|---|
| llms.txt | `web/public/llms.txt` | Plain-text index of every machine entry point, served at `/llms.txt` |
| Guide endpoint | `server/src/routes/guide.ts` | `GET /api/public/guide` — JSON guide; `agentSurfaces` section lists MCP tools, REST areas, auth |
| Skill | `skill/SKILL.md` + `skill/references/*.md` | The distributable manual agents install; add a reference module for each feature area |
| API docs | `docs/api/*.md` + `docs/api/README.md` index | Endpoint contracts, scopes, error codes |
| README | `README.md` endpoint tables | Human + agent quick reference |
| CHANGELOG | `CHANGELOG.md` | Keep a Changelog format, every feature |

Also check: default scope strings (`read:drive write:drive share:create read:memory write:memory path:/`) are quoted in several docs — grep for the old string when scopes change. After deploy, if `src/defs/runtime.ts` gained a var/secret key, set it online (`edgespark var set` / `edgespark secret set`) or deploy is blocked. The single-owner boundary is armed by the `OWNER_EMAIL` var (owner's login email; unset = legacy trust-any-session) — set it online after deploying. Storage limits use `MAX_FILE_BYTES` (default 500MB) and `MAX_TOTAL_BYTES` (default 5GB) vars — `0` = unlimited; unset = the default.

Definition of done for any feature: code + tests green + all six surfaces above updated + deployed + smoke-tested against production (unauth 401s, plus an authed happy path when a token is available via `drive.json` → `envFile`; never print the token).

## Setup

Install dependencies in each directory separately:

```bash
cd server && npm install
cd ../web && npm install
```

## Commands

```bash
edgespark deploy        # build + deploy to platform (run from project root)
```

## EdgeSpark CLI

- **Always run `edgespark <command> --help` before using a command you are unsure about.** Do not guess flags or arguments.
- Run `edgespark` commands on behalf of the user; do not ask the user to run them manually.
- If an `edgespark` command returns a URL, code, or prompt that must be completed by the human owner outside the agent, show it to the user exactly and tell them what to do next. Do not hide it.
- Never run multiple `edgespark` CLI commands in parallel. Run them sequentially.
- If a command fails with "Not authenticated", run `edgespark login`. It prints a URL — show it to the user to open in their browser. Once they approve, re-run the original command.
- `edgespark secret set` prints a secure URL for the user to enter secret values in the browser. Secret values must never pass through agent context or LLM APIs.

## EdgeSpark Skill References

If you have the `building-edgespark-apps` skill installed, use its references:

- **Always** check `dev-workflow.md` for development workflows (database, storage, auth, vars, secrets, deploy)
- **Always** check `server-patterns.md` when writing server-side code
- **Always** check `web-patterns.md` when writing frontend code with `@edgespark/web`
- **Always** check `auth-patterns.md` when configuring auth providers (OAuth, email/password)
