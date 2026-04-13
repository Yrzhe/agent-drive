import { Hono } from "hono";

import { requireDualAuth } from "./middleware/auth";
import { activityRoutes } from "./routes/activity";
import { filesRoutes } from "./routes/files";
import { foldersRoutes } from "./routes/folders";
import { guideRoutes } from "./routes/guide";
import { publicSharesRoutes } from "./routes/public-shares";
import { sharesRoutes } from "./routes/shares";
import { webhooksRoutes } from "./routes/webhooks";

const app = new Hono();

app.use("/api/public/v1/*", requireDualAuth);
app.route("/api/public/v1/activity", activityRoutes);
app.route("/api/public/v1/files", filesRoutes);
app.route("/api/public/v1/folders", foldersRoutes);
app.route("/api/public/v1", sharesRoutes);
app.route("/api/public/v1/webhooks", webhooksRoutes);
app.route("/api/public/s", publicSharesRoutes);
app.route("/api/public", guideRoutes);

export default app;
