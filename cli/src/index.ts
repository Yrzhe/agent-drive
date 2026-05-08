#!/usr/bin/env node
import { Command } from "commander";

import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { syncPushCommand } from "./commands/sync-push.js";
import { whoamiCommand } from "./commands/whoami.js";

const program = new Command();

program
  .name("adrive")
  .description("Agent Drive CLI")
  .version("0.1.0");

program
  .command("login")
  .requiredOption("--url <url>", "Agent Drive deployment URL")
  .requiredOption("--token <token>", "Bearer token")
  .option("--token-type <type>", "Token type: agent_token or oauth_access_token", "agent_token")
  .description("Log in to Agent Drive and write local config")
  .action((options: { url: string; token: string; tokenType: string }) => run(() => loginCommand(options)));

program
  .command("logout")
  .description("Delete local Agent Drive config")
  .action(() => run(logoutCommand));

program
  .command("whoami")
  .description("Show current Agent Drive config and server info")
  .action(() => run(whoamiCommand));

const sync = program
  .command("sync")
  .description("Sync local bundles with Agent Drive");

sync
  .command("push")
  .requiredOption("--from <local>", "Local directory to push")
  .requiredOption("--to <cloud>", "Cloud bundle path")
  .option("--force", "Overwrite a bundle last pushed by another machine")
  .option("--dry-run", "Preview changes without uploading")
  .option("--max-size <size>", "Maximum single file size, such as 10MB")
  .option("--max-files <count>", "Maximum number of files")
  .description("Push a local directory bundle to Agent Drive")
  .action((options: { from: string; to: string; force?: boolean; dryRun?: boolean; maxSize?: string; maxFiles?: string }) => run(() => syncPushCommand(options)));

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program.parseAsync();
