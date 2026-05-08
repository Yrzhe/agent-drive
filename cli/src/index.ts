#!/usr/bin/env node
import { Command } from "commander";

import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
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

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program.parseAsync();
