import { readConfig } from "../lib/config.js";
import { initializeMcp } from "../lib/mcp-client.js";

export async function whoamiCommand(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    throw new Error("Not logged in. Run: adrive login --url <URL> --token <TOKEN>");
  }

  const result = await initializeMcp({ url: config.url, token: config.token });
  console.log(`URL: ${config.url}`);
  console.log(`Machine ID: ${config.machineId}`);
  console.log(`Server: ${result.serverInfo.name} ${result.serverInfo.version}`);
  console.log(`Protocol: ${result.protocolVersion}`);
}
