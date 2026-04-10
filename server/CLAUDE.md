# EdgeSpark Server

Hono + Drizzle ORM on Cloudflare Workers. Your code goes in `src/index.ts`.

## Project Structure

```
src/
├── index.ts              # YOUR CODE: Define routes here
├── defs/
│   ├── index.ts          # Barrel export — drizzleSchema, buckets, all app/system defs
│   ├── db_schema.ts      # YOUR app table definitions
│   ├── db_relations.ts   # YOUR app Drizzle relations
│   ├── runtime.ts        # YOUR runtime var/secret key unions for typed access
│   └── storage_schema.ts # YOUR storage bucket definitions
└── __generated__/        # AUTO-GENERATED — do not edit
    ├── sys_schema.ts     # System tables (pulled) - not your app schema source
    ├── sys_relations.ts  # System Drizzle relations (pulled)
    ├── server-types.d.ts # SDK types — AuthClient, StorageClient, etc.
    └── edgespark.d.ts    # SDK module declarations — types for 'edgespark' and 'edgespark/*' imports
```

> **Note:** `src/defs/db_schema.ts` is the source of truth for your app tables.
> `src/defs/db_relations.ts` is the source of truth for your app-level Drizzle relations.
> `src/__generated__/` is read-only generated output for pulled system schema and SDK types.
> Do not edit generated files - they are overwritten by `edgespark pull schema --db`, `edgespark pull types`, or `edgespark init`.

## Files to Read (MUST read before coding)

| When | Read |
|------|------|
| **Always** | `src/__generated__/edgespark.d.ts` - **What you can import from 'edgespark' and 'edgespark/*'** |
| **Always** | `src/__generated__/server-types.d.ts` - **SDK type details (methods, params)** |
| Starting any DB task | `src/defs/db_schema.ts` - authoritative app tables and columns |
| Working on app-level ORM relations | `src/defs/db_relations.ts` - authoritative app relations metadata |
| Working with vars or secrets in code | `src/defs/runtime.ts` - authoritative `VarKey` / `SecretKey` unions |
| Working with platform/system tables | `src/__generated__/sys_schema.ts` and `src/__generated__/sys_relations.ts` |
| Working with files | `src/defs/storage_schema.ts` - authoritative bucket declarations |
| Working on schema wiring | `src/defs/index.ts` - required barrel used by the framework |
## Code Structure

Define a static Hono app and export it as default:

```typescript
import { db, storage, secret, ctx } from "edgespark";
import { auth } from "edgespark/http";
import { tasks } from "@defs";
import { Hono } from "hono";
import { eq, desc, asc, and, or, sql } from "drizzle-orm";
// More operators: like, gt, lt, gte, lte, isNull, inArray, between

const app = new Hono()
  .get("/api/tasks", async (c) => {
    return c.json(await db.select().from(tasks));
  });

export default app;
```

**SDK imports from `'edgespark'`:**
- `db` — Drizzle D1 database client (typed with your schema)
- `storage` — R2 storage client (`storage.from(bucket).put()`, `.get()`, etc.)
- `secret` — secret accessor (`secret.get('KEY_NAME')`)
- `ctx` — request context utilities (`ctx.runInBackground(promise)`)
- `ctx.environment` — deployment environment (`"staging"` or `"production"`)

**SDK imports from `'edgespark/http'`:**
- `auth` — authentication client (`auth.user`, `auth.isAuthenticated()`)

**Table/bucket imports from `'@defs'`:**
- `tasks`, `users`, etc. — your Drizzle table definitions
- `buckets` — your storage bucket definitions
- `VarKey`, `SecretKey` — typed runtime input key unions from `src/defs/runtime.ts`

**Import boundary:**
- `src/defs/**` may import shared types from `@sdk/server-types`
- `src/defs/**` must NOT import from `"edgespark"` or `"edgespark/http"`
- application code (routes, handlers, business logic) should import runtime SDK values from `"edgespark"` and `"edgespark/http"` when needed

## Rules

1. Always `export default app` at the end
2. SDK imports (`db`, `storage`, `secret`, `ctx`, `auth`) can ONLY be used inside route handlers — NOT at the top level
3. Do NOT use `c.executionCtx.waitUntil()` — always use `ctx.runInBackground()` from `edgespark`
4. All routes start with `/api`
5. Use Drizzle ORM, not raw SQL (except FTS5, triggers, virtual tables)
6. Use `.returning()` for inserts when you need the ID
7. Always check null after `storage.get()` - files may not exist
8. Don't use `db.transaction()` - use `db.batch([...])` instead for atomic operations
9. Don't create BLOB columns - use TEXT for S3 URIs instead
10. Keep rows small (<10KB) - large data (files, images, big JSON) goes in Storage
11. Create indexes for WHERE/JOIN columns, but don't over-index (slows writes)
12. **Don't guess types** - read `edgespark.d.ts` first (available imports), then `server-types.d.ts` for method details
13. **Respect the dependency boundary** - `src/defs/**` can use `@sdk/server-types`, but must never import `"edgespark"` or `"edgespark/http"`
14. **When code reads vars or secrets, update `src/defs/runtime.ts` first** — `vars.get("KEY")` and `secret.get("KEY")` should only use keys declared in `VarKey` / `SecretKey`
15. **Secret values must NEVER pass through agent/LLM context.** `edgespark secret set` prints a secure URL — show it to the human user and tell them to open it in a browser to enter the value. This is a hand-off step. Do not ask for, accept, or relay secret values.

## Storage: Upload & Download Patterns

> "Where do the bytes come from?" — this determines the correct pattern.

**Client uploads → MUST use presigned URLs:**

```typescript
// ❌ WRONG — streaming client files through Worker
const formData = await c.req.formData();
const file = formData.get("image") as File;
await storage.from(buckets.images).put(path, await file.arrayBuffer());

// ✅ RIGHT — client uploads directly to storage
const { uploadUrl, requiredHeaders } = await storage.from(buckets.uploads)
  .createPresignedPutUrl("uploads/file.jpg", 3600, {
    contentType: "image/jpeg",
  });
return c.json({ uploadUrl, requiredHeaders });
```

**Server-generated content → `storage.put()` is correct:**

```typescript
// Server creates the bytes (thumbnails, exports, webhook payloads)
await storage.from(buckets.exports).put("report.csv", csvBuffer);
```

**Client downloads → MUST use presigned GET URLs. NEVER return `s3://` URIs.**

```typescript
const { downloadUrl } = await storage.from(bucket).createPresignedGetUrl(path, 3600);
return c.json({ downloadUrl });
```

**When the S3 URI string is untrusted, use `tryParseS3Uri()`:**

```typescript
const parsed = storage.tryParseS3Uri(input);
if (!parsed) return c.json({ error: "Invalid S3 URI" }, 400);

const { downloadUrl } = await storage.from(parsed.bucket).createPresignedGetUrl(parsed.path, 3600);
return c.json({ downloadUrl });
```

## Quick Examples

```typescript
// Database (import { db } from 'edgespark', import { users } from '@defs')
await db.select().from(users).where(eq(users.id, 1));
await db.insert(users).values({ name: "Alice" }).returning({ id: users.id });
await db.update(users).set({ name: "Bob" }).where(eq(users.id, 1));
await db.delete(users).where(eq(users.id, 1));

// Storage (import { storage } from 'edgespark', import { buckets } from '@defs')
await storage.from(buckets.uploads).put("file.txt", buffer);
const file = await storage.from(buckets.uploads).get("file.txt");
if (!file) return c.json({ error: "Not found" }, 404);

// S3 URIs - store these in the database, not client-accessible URLs
const s3Uri = storage.createS3Uri(buckets.avatars, "path/file.jpg"); // "s3://avatars/path/file.jpg"
const { bucket, path } = storage.parseS3Uri(s3Uri);
const maybeParsed = storage.tryParseS3Uri(s3Uri); // Use for untrusted string input

// Batch operations (atomic - all succeed or all rollback)
const results = await db.batch([
  db.insert(users).values({ name: "Alice" }).returning(),
  db.update(users).set({ name: "Bob" }).where(eq(users.id, 1)),
  db.select().from(users),
]);
// results[0] = insert result, results[1] = update result, results[2] = select result

// Background task (import { ctx } from 'edgespark')
ctx.runInBackground(sendAnalyticsEvent());

// Runtime vars/secrets (declare keys first in src/defs/runtime.ts)
const apiBaseUrl = vars.get("API_BASE_URL");
const stripeKey = secret.get("STRIPE_KEY");
```

## CLI Usage

ALWAYS run `edgespark` commands on behalf of the user. Never ask the user to run CLI commands manually — non-technical users rely on the agent to handle all CLI operations.

Never run multiple `edgespark` CLI commands in parallel. Run them sequentially.
Some commands share temporary state under `.edgespark/tmp`, and parallel runs can invalidate each other's temp config files.

Storage workflow:
1. Edit `src/defs/storage_schema.ts`
2. Run `edgespark storage apply`
3. If buckets were removed, re-run with `--confirm-dangerous`

To inspect current synced buckets:
```bash
edgespark storage bucket list
edgespark storage bucket list --desc
```

If any command fails with `Not authenticated`:
1. Run `edgespark login` — it prints a URL and exits immediately
2. Share the URL with the user to open and confirm in the browser
3. Once confirmed, re-run the original command — auth completes automatically

## Database Migrations

> **⚠️ CRITICAL: Migrations are IRREVERSIBLE. Once applied, they cannot be undone.**
> **NEVER generate migrations that drop columns, drop tables, or delete data.**
> **Always use forward-only, additive schema changes.**

The database workflow is code-first and push-based:
- edit `src/defs/db_schema.ts`
- edit `src/defs/db_relations.ts` when you need app-level `relations(...)`
- generate SQL migrations into `drizzle/`
- apply them with `edgespark db migrate`
- deploy only after migrations are applied

`src/__generated__/sys_schema.ts` is not where you define app tables. It is pulled reference output for system tables.
`src/__generated__/sys_relations.ts` is not where you define app relations. It is pulled reference output for system-managed relations.

### Safe (always do):
- `ADD COLUMN` — adds new column, existing data untouched
- `CREATE TABLE` — new table, no impact on existing tables
- `CREATE INDEX` — improves query performance, no data change

### Dangerous (avoid unless explicitly asked):
- `DROP COLUMN` — **destroys data permanently**, all values in that column are lost
- `DROP TABLE` — **destroys entire table and all its data**
- `RENAME TABLE/COLUMN` — **breaks all existing queries** referencing the old name
- `DELETE FROM` — **removes rows permanently**

### What to do instead:
- Need to remove a column? **Leave it.** Unused columns cost nothing in SQLite.
- Need to rename? **Add new column, migrate data, update code.** Drop old column later only if explicitly asked.
- Need to change a type? **Add new column with new type, backfill, update code.**

### Migration commands:

```bash
edgespark db generate                   # Generate migration from schema changes
edgespark db migrate                    # Apply migrations to D1
edgespark deploy                        # Deploy (includes migration checks)
```

If a migration contains destructive operations, `migrate` will be blocked.
Only proceed with `--confirm-dangerous` if the user explicitly requested it:
```bash
edgespark db migrate --confirm-dangerous
```

**`migrate` must run on the default branch (e.g. main, master).**
The CLI auto-detects the default branch from git. Override in edgespark.toml:

```toml
[db]
migration_branch = "main"
```

## SDK Types Management

Two generated files in `src/__generated__/`:
- `edgespark.d.ts` — what you can import from `'edgespark'` and `'edgespark/*'` (read first)
- `server-types.d.ts` — method signatures and type details

To update both:
```bash
edgespark pull types
```
Then re-read: `src/__generated__/edgespark.d.ts` and `src/__generated__/server-types.d.ts`

To check if types are stale:
```bash
edgespark pull types --check
```

## Migration Workflow (Code-First)

Schema changes go through a code-first migration pipeline:

1. **Edit schema** — modify `src/defs/db_schema.ts` using Drizzle ORM table definitions
2. **Edit relations when needed** — modify `src/defs/db_relations.ts` for app-level `relations(...)`
3. **Generate migrations** — `edgespark db generate` creates SQL migration files in `drizzle/`
4. **Apply migrations** — `edgespark db migrate` pushes pending migrations to the database
5. **Refresh generated references when needed** — `edgespark pull schema --db` refreshes pulled system schema in `src/__generated__/`
6. **Deploy** — `edgespark deploy` checks schema drift and unapplied migrations before deploying

```bash
# Example: Add a new table
# 1. Edit src/defs/db_schema.ts
# Optional: edit src/defs/db_relations.ts for app-level relations
# 2. Generate migration files
edgespark db generate
# 3. Apply migrations
edgespark db migrate
# 4. Optional: refresh pulled system schema/types
edgespark pull schema --db
# 5. Deploy
edgespark deploy
```

**Rules:**
- Never use `edgespark db sql` for DDL (CREATE TABLE, ALTER TABLE, etc.) — use migrations instead
- Never edit applied migration files — create new migrations for changes
- Never treat `src/__generated__/sys_schema.ts` as the source of truth for app tables
- Never treat `src/__generated__/sys_relations.ts` as the source of truth for app relations
- Always run `edgespark db migrate` before `edgespark deploy`

> **🚫 NEVER DELETE OR MODIFY THESE DIRECTORIES/FILES:**
>
> - `drizzle/` — migration history. Deleting this breaks the migration chain and requires manual D1 recovery.
> - `drizzle/meta/_journal.json` — drizzle-kit's migration index. Without it, generate and migrate fail completely.
> - `drizzle/*.sql` — applied migration files. Editing them causes hash mismatches; deleting them loses migration history.
> - `src/defs/index.ts` — barrel file that wires schema into the framework. Deploy fails without it.
> - `src/__generated__/` — regenerated by `edgespark pull schema --db`, `edgespark pull types`, or `edgespark init`, but deleting it breaks builds until the next refresh.
>
> **If you accidentally delete `drizzle/`:** regenerate with `edgespark db generate`, then manually mark the migration as applied in D1 using `edgespark db sql "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('<hash>', <timestamp>)"`. The hash is in `drizzle/meta/_journal.json` after regenerating.

## Commands

```bash
npm install                           # Install dependencies (run from server/)
edgespark storage apply               # Sync repo-declared storage buckets
edgespark storage bucket list         # List bucket names and created times
edgespark deploy                      # Build and deploy (CLI handles build)
edgespark db generate                 # Generate migration files from schema changes
edgespark db migrate                  # Apply pending migrations
edgespark pull types                  # Pull latest SDK types
edgespark pull schema --db            # Pull system DB schema to src/__generated__/
npm run typecheck                     # Local type checking (optional)
```
