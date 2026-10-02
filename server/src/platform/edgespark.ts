import type { PlatformRuntime } from "./types";

/** Keep SDK resolution inside the request, as required by EdgeSpark. */
export async function getPlatform(): Promise<PlatformRuntime> {
  const [runtime, http] = await Promise.all([import("edgespark"), import("edgespark/http")]);
  return { ...runtime, kind: "edgespark", auth: http.auth };
}
