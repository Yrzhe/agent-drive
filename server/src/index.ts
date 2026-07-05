import { Hono } from "hono";

import { requireDualAuth } from "./middleware/auth";
import { activityRoutes } from "./routes/activity";
import { agentCardRoutes } from "./routes/agent-card";
import { bundlesRoutes } from "./routes/bundles";
import { filesRoutes } from "./routes/files";
import { foldersRoutes } from "./routes/folders";
import { guideRoutes } from "./routes/guide";
import { mcpRoutes } from "./routes/mcp";
import { memoryRoutes } from "./routes/memory";
import { oauthRoutes } from "./routes/oauth";
import { oauthDiscoveryRoutes } from "./routes/oauth-discovery";
import { publicSharesRoutes } from "./routes/public-shares";
import { sharesRoutes } from "./routes/shares";
import { webhooksRoutes } from "./routes/webhooks";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.route("/api/public/.well-known", oauthDiscoveryRoutes);
app.route("/api/public/.well-known", agentCardRoutes);
app.route("/api/public/mcp", mcpRoutes);
app.route("/api/public/oauth", oauthRoutes);
app.use("/api/public/v1/*", requireDualAuth);
app.route("/api/public/v1/activity", activityRoutes);
app.route("/api/public/v1/bundles", bundlesRoutes);
app.route("/api/public/v1/files", filesRoutes);
app.route("/api/public/v1/folders", foldersRoutes);
app.route("/api/public/v1/memory", memoryRoutes);
app.route("/api/public/v1", sharesRoutes);
app.route("/api/public/v1/webhooks", webhooksRoutes);
app.route("/api/public/s", publicSharesRoutes);
app.route("/api/public", guideRoutes);

export default app;
