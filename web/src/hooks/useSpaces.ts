/**
 * Shared Spaces P1 Task 8 — thin REST fetch helpers over `/api/public/v1/spaces/*`.
 *
 * Mirrors `lib/drive-api.ts`'s shape (plain async functions, no React state) so pages own
 * their own loading/error state exactly like DashboardPage/TrashPage already do. Contracts
 * read directly from `server/src/routes/spaces.ts` — see that file for the authoritative
 * request/response shapes and error codes (`space_forbidden`, `space_not_found`,
 * `not_your_resource`, `member_not_found`).
 */

import { apiFetchJson } from "@/lib/api-client";
import type {
  MemberRole,
  SpaceItemDisplay,
  SpaceItemType,
  SpaceMember,
  SpaceMemoryHit,
  SpaceSummary,
} from "@/types/spaces";

function itemsQuery(options?: { type?: SpaceItemType; limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  if (options?.type) params.set("type", options.type);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const spacesApi = {
  listSpaces: () => apiFetchJson<{ spaces: SpaceSummary[] }>("/api/public/v1/spaces"),

  createSpace: (name: string) =>
    apiFetchJson<{ space: SpaceSummary }>("/api/public/v1/spaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  getSpace: (spaceId: string) => apiFetchJson<{ space: SpaceSummary }>(`/api/public/v1/spaces/${spaceId}`),

  deleteSpace: (spaceId: string) =>
    apiFetchJson<{ deleted: boolean; id: string }>(`/api/public/v1/spaces/${spaceId}`, { method: "DELETE" }),

  listMembers: (spaceId: string) => apiFetchJson<{ members: SpaceMember[] }>(`/api/public/v1/spaces/${spaceId}/members`),

  inviteMember: (spaceId: string, email: string, role: MemberRole) =>
    apiFetchJson<{ member: SpaceMember }>(`/api/public/v1/spaces/${spaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  updateMemberRole: (spaceId: string, userId: string, role: MemberRole) =>
    apiFetchJson<{ member: SpaceMember }>(`/api/public/v1/spaces/${spaceId}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  removeMember: (spaceId: string, userId: string) =>
    apiFetchJson<{ removed: boolean; userId: string }>(`/api/public/v1/spaces/${spaceId}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  listItems: (spaceId: string, options?: { type?: SpaceItemType; limit?: number; offset?: number }) =>
    apiFetchJson<{ items: SpaceItemDisplay[]; limit: number; offset: number }>(
      `/api/public/v1/spaces/${spaceId}/items${itemsQuery(options)}`,
    ),

  addItem: (spaceId: string, itemType: SpaceItemType, ref: string) =>
    apiFetchJson<{ item: SpaceItemDisplay }>(`/api/public/v1/spaces/${spaceId}/items`, {
      method: "POST",
      body: JSON.stringify({ itemType, ref }),
    }),

  removeItem: (spaceId: string, itemId: string) =>
    apiFetchJson<{ removed: boolean; id: string }>(`/api/public/v1/spaces/${spaceId}/items/${itemId}`, {
      method: "DELETE",
    }),

  /**
   * Memory recall (`/api/public/v1/memory/search`) is not per-space scoped server-side — it
   * already returns the union of the caller's own memories plus every memory reachable via
   * ANY space they belong to (design §Read-path change). Callers narrow to "within this
   * space" by intersecting hits against this space's own `memory` item refs (see
   * SpaceViewPage) and fall back to showing the unfiltered global hits when that yields
   * nothing.
   */
  searchMemory: (query: string, limit = 10) =>
    apiFetchJson<{ query: string; memories: SpaceMemoryHit[]; count: number }>(
      `/api/public/v1/memory/search?${new URLSearchParams({ q: query, limit: String(limit) }).toString()}`,
    ),
};
