import { getContext } from "hono/context-storage";
import type { PlatformRuntime } from "../types";
import type { SitesEnv } from "./types";

/** AsyncLocalStorage-backed Hono context; never store a visitor in a global. */
export async function getPlatform(): Promise<PlatformRuntime> {
  const runtime = getContext<SitesEnv>().get("platform");
  if (!runtime) throw new Error("Sites request context is unavailable");
  return runtime;
}
