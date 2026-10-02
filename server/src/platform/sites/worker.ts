import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import app from "../../index";
import { createMcpRoutes } from "../../routes/mcp";
import { createSitesRuntime } from "./runtime";
import { transferRoutes } from "./transfers";
import { versionRoutes } from "./version-routes";
import type { SitesBindings, SitesEnv, SitesExecutionContext } from "./types";

const site = new Hono<SitesEnv>();
site.use("*", contextStorage());
site.use("*", async (c, next) => {
  if (!c.req.path.startsWith("/api/") && c.req.path !== "/mcp" && c.req.path !== "/mcp/") {
    await next();
    return;
  }
  try {
    c.set("platform", await createSitesRuntime(c, c.executionCtx));
    await next();
  } catch (error) {
    console.error("Agent Drive request unavailable", error instanceof Error ? error.message : "runtime_error");
    return c.json({ error: { code: "service_unavailable", message: "Agent Drive is unavailable. Please try again." } }, 503);
  }
});
site.get("/api/public/session", (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = c.get("platform").auth.user;
  return c.json({ user: user ? { id: user.id, email: user.email, name: user.name, image: user.image } : null, platform: "sites" });
});
site.route("/mcp", createMcpRoutes({ sitesIdentity: true }));
site.route("/api/public/transfer", transferRoutes);
site.route("/api/public/v1/files", versionRoutes as unknown as Hono<SitesEnv>);
site.route("/", app as unknown as Hono<SitesEnv>);
site.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path === "/mcp" || c.req.path.startsWith("/.well-known/")) return c.json({ error: "not_found" }, 404);
  if (c.req.path === "/signin-with-chatgpt" || c.req.path === "/signout-with-chatgpt" || c.req.path === "/callback") return c.text("Authentication is managed by Sites", 404);
  if (!c.env.ASSETS) return c.text("Site assets unavailable", 503);
  return c.env.ASSETS.fetch(c.req.raw);
});
export default {
  fetch(request: Request, env: SitesBindings, ctx: SitesExecutionContext): Promise<Response> | Response {
    return site.fetch(request, env, ctx as never);
  },
};
