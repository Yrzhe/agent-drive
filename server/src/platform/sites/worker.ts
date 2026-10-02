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
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  // Sites asset bindings may omit Wrangler's SPA fallback. Serve the entry point
  // for known frontend routes, including MCP browser upload links, while keeping
  // unknown assets and all API/auth routes honest 404s.
  const frontend = /^\/(?:upload|drive|guide|connect(?:\/authorize)?|bundles|trash|waitlist|admin|signup|spaces(?:\/[^/]+)?|s\/[^/]+)\/?$/u.test(c.req.path);
  if (asset.status === 404 && frontend && ["GET", "HEAD"].includes(c.req.method)) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw));
  }
  return asset;
});
export default {
  fetch(request: Request, env: SitesBindings, ctx: SitesExecutionContext): Promise<Response> | Response {
    return site.fetch(request, env, ctx as never);
  },
};
