import { Hono } from "hono";

import { getRequestActor, logEvent } from "../lib/activity";
import { ApiError, withErrorHandling } from "../lib/errors";
import {
  forgetMemory,
  getMemoryIndexStatus,
  getMemory,
  listMemories,
  recallMemories,
  rememberMemory,
  rebuildMemoryIndex,
  toMemoryObject,
} from "../lib/memory";
import { memoryReadableFilter } from "../lib/spaces";
import type { AppEnv } from "../types";

export const memoryRoutes = new Hono<AppEnv>();

function toApiError(error: unknown): unknown {
  if (error instanceof Error && error.message.startsWith("invalid_params:")) {
    return new ApiError(400, "validation_error", error.message.slice("invalid_params:".length));
  }
  return error;
}

memoryRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      key?: unknown;
      tags?: unknown;
      source?: unknown;
    };
    const { db } = await import("edgespark");
    try {
      const { memory, created } = await rememberMemory(db, {
        content: typeof body.content === "string" ? body.content : "",
        key: typeof body.key === "string" ? body.key : null,
        tags: body.tags,
        source: typeof body.source === "string" ? body.source : null,
        ownerId: c.get("ownerId") ?? null,
      });
      await logEvent(db, {
        ownerId: c.get("ownerId") ?? null,
        eventType: created ? "memory.created" : "memory.updated",
        targetType: "memory",
        targetId: memory.id,
        actor: await getRequestActor(),
        metadata: { key: memory.key, tags: memory.tags },
      });
      return c.json({ memory, created }, created ? 201 : 200);
    } catch (error) {
      throw toApiError(error);
    }
  })
);

memoryRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const offsetRaw = Number(c.req.query("offset") ?? "0");
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    // Read-path union: own rows PLUS memories reachable via this caller's space memberships
    // (design §Read-path change). Reduces to the strict owner filter when the caller has no
    // spaces, so non-members stay fully #30-isolated.
    const readable = await memoryReadableFilter(db, ownerId);
    const memories = await listMemories(
      db,
      Number.isFinite(limitRaw) ? limitRaw : 20,
      Number.isFinite(offsetRaw) ? offsetRaw : 0,
      ownerId,
      readable
    );
    return c.json({ memories, count: memories.length });
  })
);

memoryRoutes.get(
  "/search",
  withErrorHandling(async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (!query) throw new ApiError(400, "validation_error", "q query param is required");
    const limitRaw = Number(c.req.query("limit") ?? "10");
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    // FTS recall widens to the union of the caller's own memories + memory ids reachable via
    // spaces, applied to the joined rows so foreign private memories never rank in.
    const readable = await memoryReadableFilter(db, ownerId);
    const memories = await recallMemories(db, query, Number.isFinite(limitRaw) ? limitRaw : 10, ownerId, readable);
    return c.json({ query, memories, count: memories.length });
  })
);

memoryRoutes.get(
  "/index-status",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    return c.json(await getMemoryIndexStatus(db));
  })
);

memoryRoutes.post(
  "/rebuild-index",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const rebuilt = await rebuildMemoryIndex(db);
    return c.json({ rebuilt });
  })
);

memoryRoutes.get(
  "/:id",
  withErrorHandling(async (c) => {
    const id = c.req.param("id");
    if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    // Read-path union: own memory OR one reachable via a space membership (design §Read-path
    // change). Non-members collapse to the strict owner filter → same 404 as full isolation.
    const readable = await memoryReadableFilter(db, ownerId);
    const memory = await getMemory(db, id, ownerId, readable);
    if (!memory) throw new ApiError(404, "memory_not_found", "Memory not found");
    return c.json({ memory: toMemoryObject(memory) });
  })
);

memoryRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    const id = c.req.param("id");
    if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
    const { db } = await import("edgespark");
    const forgotten = await forgetMemory(db, id, c.get("ownerId") ?? null);
    if (!forgotten) throw new ApiError(404, "memory_not_found", "Memory not found");
    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "memory.deleted",
      targetType: "memory",
      targetId: forgotten.id,
      actor: await getRequestActor(),
      metadata: { key: forgotten.key },
    });
    return c.json({ forgotten });
  })
);
