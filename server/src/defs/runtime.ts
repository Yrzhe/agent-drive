// Typed runtime input keys for app code.
// VarKey and SecretKey are string literal union types, not values or config storage.
// Add a key here before using vars.get("KEY") or secret.get("KEY") in code.
// Values still come from .env.local in local dev and remote vars/secrets in deployed envs.

export type VarKey =
  // | "API_BASE_URL"
  // | "GOOGLE_CLIENT_ID"
  never;

export type SecretKey =
  | "AGENT_TOKEN";
