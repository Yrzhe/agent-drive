import { deleteConfig } from "../lib/config.js";

export async function logoutCommand(): Promise<void> {
  await deleteConfig();
  console.log("Logged out");
}
