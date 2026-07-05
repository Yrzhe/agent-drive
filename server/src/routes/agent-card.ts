import { Hono } from "hono";

import { buildAgentCard, getOrCreateAgentIdentity } from "../lib/agent-identity";
import { withErrorHandling } from "../lib/errors";
import { APP_VERSION } from "../lib/version";

export const agentCardRoutes = new Hono();

async function serveAgentCard(url: string): Promise<Response> {
  const { db, vars } = await import("edgespark");
  const origin = (vars.get("ALLOWED_ORIGIN") ?? new URL(url).origin).replace(/\/+$/u, "");
  const identity = await getOrCreateAgentIdentity(db);
  return Response.json(buildAgentCard(identity, origin, APP_VERSION), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}

// A2A originally specified /.well-known/agent.json; newer revisions use
// agent-card.json. Serve both so any client generation resolves.
agentCardRoutes.get(
  "/agent.json",
  withErrorHandling(async (c) => serveAgentCard(c.req.url))
);

agentCardRoutes.get(
  "/agent-card.json",
  withErrorHandling(async (c) => serveAgentCard(c.req.url))
);
