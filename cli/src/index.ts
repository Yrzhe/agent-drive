#!/usr/bin/env node
import { Command } from "commander";

import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { mcpStdioCommand } from "./commands/mcp-stdio.js";
import { syncHistoryCommand } from "./commands/sync-history.js";
import { syncListCommand } from "./commands/sync-list.js";
import { syncPullCommand } from "./commands/sync-pull.js";
import { syncPushCommand } from "./commands/sync-push.js";
import { subscribeCommand } from "./commands/subscribe.js";
import { syncRollbackCommand } from "./commands/sync-rollback.js";
import { whoamiCommand } from "./commands/whoami.js";

const program = new Command();

program
  .name("adrive")
  .description("Agent Drive CLI")
  .version("0.1.0");

program
  .command("login")
  .requiredOption("--url <url>", "Agent Drive deployment URL")
  .option("--token <token>", "Bearer token for non-interactive login")
  .option("--token-type <type>", "Token type: agent_token or oauth_access_token", "agent_token")
  .option("--no-browser", "Print the OAuth URL without opening a browser")
  .option("--scope <scope>", "OAuth scope to request", "read:drive write:drive share:create")
  .description("Log in to Agent Drive and write local config")
  .action((options: { url: string; token?: string; tokenType: string; browser?: boolean; scope?: string }) => run(() => loginCommand({ ...options, noBrowser: options.browser === false })));

program
  .command("logout")
  .description("Delete local Agent Drive config")
  .action(() => run(logoutCommand));

program
  .command("whoami")
  .description("Show current Agent Drive config and server info")
  .action(() => run(whoamiCommand));

const mcp = program
  .command("mcp")
  .description("MCP transport bridges");

mcp
  .command("stdio")
  .description("Bridge stdio JSON-RPC to the remote HTTP MCP endpoint")
  .action(() => run(mcpStdioCommand));

const sync = program
  .command("sync")
  .description("Sync local bundles with Agent Drive");

sync
  .command("list")
  .argument("[cloud-prefix]", "Cloud prefix to search", "/")
  .option("--json", "Output raw manifest JSON array")
  .description("List synced bundles under a cloud prefix")
  .action((prefix: string | undefined, options: { json?: boolean }) => run(() => syncListCommand(prefix, options)));

sync
  .command("pull")
  .requiredOption("--from <cloud>", "Cloud bundle path")
  .requiredOption("--to <local>", "Local directory to restore into")
  .option("--force", "Overwrite local changes without prompting")
  .option("--dry-run", "Preview changes without downloading")
  .description("Pull an Agent Drive bundle to a local directory")
  .action((options: { from: string; to: string; force?: boolean; dryRun?: boolean }) => run(() => syncPullCommand(options)));

sync
  .command("push")
  .requiredOption("--from <local>", "Local directory to push")
  .requiredOption("--to <cloud>", "Cloud bundle path")
  .option("--force", "Bypass version ETag check (ifMatch: '*')")
  .option("--dry-run", "Preview changes without uploading")
  .option("--max-size <size>", "Maximum single file size, such as 10MB")
  .option("--max-files <count>", "Maximum number of files")
  .description("Push a local directory bundle to Agent Drive")
  .action((options: { from: string; to: string; force?: boolean; dryRun?: boolean; maxSize?: string; maxFiles?: string }) => run(() => syncPushCommand(options)));

sync
  .command("history")
  .argument("<cloud-prefix>", "Cloud bundle path")
  .option("--json", "Output raw JSON")
  .option("--limit <count>", "Max number of versions to list (default 50, max 200)")
  .description("List historical versions of a bundle")
  .action((prefix: string, options: { json?: boolean; limit?: string }) => run(() => syncHistoryCommand(prefix, options)));

sync
  .command("rollback")
  .argument("<cloud-prefix>", "Cloud bundle path")
  .requiredOption("--to <versionId>", "Target versionId (dv_*) to restore")
  .option("--yes", "Skip the confirmation prompt")
  .option("--force", "Skip the confirmation prompt (alias of --yes)")
  .description("Restore a prior manifest as a new version (pointer-only)")
  .action((prefix: string, options: { to: string; yes?: boolean; force?: boolean }) => run(() => syncRollbackCommand(prefix, options)));

program
  .command("subscribe")
  .argument("<url>", "Public bundle URL: https://host/api/public/b/<id>/current")
  .requiredOption("--to <local>", "Local directory to download into")
  .option("--no-verify", "Skip Ed25519 signature verification against the publisher's Agent Card")
  .description("Download a published bundle anonymously; re-run to pull updates")
  .action((url: string, options: { to: string; verify?: boolean }) => run(() => subscribeCommand(url, options)));

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program.parseAsync();
