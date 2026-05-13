import { readConfig } from "../lib/config.js";
import { initializeMcp } from "../lib/mcp-client.js";

export async function whoamiCommand(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    throw new Error("Not logged in. Run: adrive login --url <URL>");
  }

  const result = await initializeMcp(config);
  console.log(`URL: ${config.url}`);
  console.log(`Machine ID: ${config.machineId}`);
  console.log(`Token type: ${config.tokenType}`);
  if (config.scope) console.log(`Scope: ${config.scope}`);
  console.log(`Server: ${result.serverInfo.name} ${result.serverInfo.version}`);
  console.log(`Protocol: ${result.protocolVersion}`);
}
