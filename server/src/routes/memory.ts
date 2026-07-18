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
    const memories = await listMemories(
      db,
      Number.isFinite(limitRaw) ? limitRaw : 20,
      Number.isFinite(offsetRaw) ? offsetRaw : 0
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
    const memories = await recallMemories(db, query, Number.isFinite(limitRaw) ? limitRaw : 10);
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
    const memory = await getMemory(db, id);
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
    const forgotten = await forgetMemory(db, id);
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
