import { afterAll, beforeEach, describe, expect, it } from "vitest";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, seedOwner, useSession } from "./edge-runtime";

/**
 * Shared Spaces P1 Task 2 — REST CRUD for `/api/public/v1/spaces/*`.
 * (brief: .superpowers/sdd/task-2-brief.md; design: docs/implementation/2026-07-19-shared-spaces-design.md)
 *
 * OWNER_EMAIL is deliberately left unset in these tests (legacy trust-any access-gate
 * mode — see access-control.integration.test.ts) so every session resolves `active`
 * without allowlist bookkeeping; that plumbing is covered elsewhere and isn't what these
 * tests are about. `seedOwner` here just registers a user's id/email in the platform
 * auth-user table so invite-by-email lookups can resolve them — it isn't owner-specific.
 */
describe("spaces CRUD + membership REST (P1 Task 2)", () => {
  const USER_A = { id: "user-a", email: "alice@x.test" };
  const USER_B = { id: "user-b", email: "bob@x.test" };
  const USER_C = { id: "user-c", email: "carol@x.test" };

  function seedUsers(): void {
    seedOwner({ id: USER_A.id, email: USER_A.email });
    seedOwner({ id: USER_B.id, email: USER_B.email });
    seedOwner({ id: USER_C.id, email: USER_C.email });
  }

  async function createSpace(name = "Team KB"): Promise<{ id: string }> {
    const res = await app.request("/api/public/v1/spaces", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { space: { id: string } }).space;
  }

  async function inviteMember(spaceId: string, email: string, role = "contributor"): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, role }),
    });
  }

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await app.request("/api/public/v1/spaces");
    expect(res.status).toBe(401);
  });

  it("creator creates a space, sees it in GET /, and its role is 'creator'", async () => {
    seedUsers();
    useSession(USER_A);

    const space = await createSpace("My Space");
    expect(space).toMatchObject({ name: "My Space", visibility: "invite", creatorId: USER_A.id, role: "creator", memberCount: 1, itemCount: 0 });

    const listRes = await app.request("/api/public/v1/spaces");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { spaces: { id: string; role: string }[] };
    expect(listBody.spaces).toHaveLength(1);
    expect(listBody.spaces[0]).toMatchObject({ id: space.id, role: "creator" });
  });

  it("rejects space creation with a missing/blank name", async () => {
    seedUsers();
    useSession(USER_A);

    const res = await app.request("/api/public/v1/spaces", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("GET / returns [] for a user with no spaces", async () => {
    seedUsers();
    useSession(USER_C);

    const res = await app.request("/api/public/v1/spaces");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ spaces: [] });
  });

  it("creator invites user B by email → B sees the space in their own GET /, with role 'contributor'", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const inviteRes = await inviteMember(space.id, USER_B.email, "contributor");
    expect(inviteRes.status).toBe(201);
    const inviteBody = (await inviteRes.json()) as { member: { userId: string; email: string; role: string } };
    expect(inviteBody.member).toMatchObject({ userId: USER_B.id, email: USER_B.email, role: "contributor" });

    useSession(USER_B);
    const listRes = await app.request("/api/public/v1/spaces");
    const listBody = (await listRes.json()) as { spaces: { id: string; role: string; memberCount: number }[] };
    expect(listBody.spaces).toHaveLength(1);
    expect(listBody.spaces[0]).toMatchObject({ id: space.id, role: "contributor", memberCount: 2 });
  });

  it("inviting an unknown email returns 404 user_not_found and does not create a user", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await inviteMember(space.id, "ghost@nowhere.test", "viewer");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("user_not_found");
  });

  it("a non-member's GET /:id is 404, not 403 (does not confirm the space exists)", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    useSession(USER_C);
    const res = await app.request(`/api/public/v1/spaces/${space.id}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("space_not_found");
  });

  it("GET /:id for an unknown id also returns 404 space_not_found", async () => {
    seedUsers();
    useSession(USER_A);
    const res = await app.request("/api/public/v1/spaces/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("a member (not the creator) sees the space's full meta on GET /:id", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace("Shared KB");
    await inviteMember(space.id, USER_B.email, "viewer");

    useSession(USER_B);
    const res = await app.request(`/api/public/v1/spaces/${space.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { space: Record<string, unknown> };
    expect(body.space).toMatchObject({ id: space.id, name: "Shared KB", role: "viewer", memberCount: 2 });
  });

  it("a non-creator member gets 403 space_forbidden inviting a new member", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "editor");

    useSession(USER_B);
    const res = await inviteMember(space.id, USER_C.email, "viewer");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("space_forbidden");
  });

  it("a non-creator member gets 403 space_forbidden deleting the space", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "editor");

    useSession(USER_B);
    const res = await app.request(`/api/public/v1/spaces/${space.id}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("space_forbidden");
  });

  it("a plain non-member gets 403 space_forbidden (not 404) attempting creator-only mutations", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    useSession(USER_C);
    const res = await app.request(`/api/public/v1/spaces/${space.id}`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("removing the creator via DELETE /:id/members/:userId is refused with 400", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_A.id}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("inviting the creator by their own email is refused with 400", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await inviteMember(space.id, USER_A.email, "editor");
    expect(res.status).toBe(400);
  });

  it("changing the creator's role via PATCH is refused with 400", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_A.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(res.status).toBe(400);
  });

  it("creator can list members, including the synthesized creator row", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { userId: string; role: string; email: string | null }[] };
    expect(body.members).toHaveLength(2);
    const byId = Object.fromEntries(body.members.map((m) => [m.userId, m]));
    expect(byId[USER_A.id]).toMatchObject({ role: "creator", email: USER_A.email });
    expect(byId[USER_B.id]).toMatchObject({ role: "viewer", email: USER_B.email });
  });

  it("a viewer member can list members (read access), but a non-member cannot", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    useSession(USER_B);
    const okRes = await app.request(`/api/public/v1/spaces/${space.id}/members`);
    expect(okRes.status).toBe(200);

    useSession(USER_C);
    const forbiddenRes = await app.request(`/api/public/v1/spaces/${space.id}/members`);
    expect(forbiddenRes.status).toBe(403);
  });

  it("creator can change a member's role via PATCH", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_B.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ role: "editor" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { role: string } };
    expect(body.member.role).toBe("editor");
  });

  it("PATCH on a userId that isn't a member returns 404 member_not_found", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_C.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("member_not_found");
  });

  it("creator can remove a member, who then loses GET /:id access (404)", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    const removeRes = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_B.id}`, { method: "DELETE" });
    expect(removeRes.status).toBe(200);
    expect(await removeRes.json()).toEqual({ removed: true, userId: USER_B.id });

    useSession(USER_B);
    const getRes = await app.request(`/api/public/v1/spaces/${space.id}`);
    expect(getRes.status).toBe(404);
  });

  it("DELETE on a userId that isn't a member returns 404 member_not_found", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_C.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("member_not_found");
  });

  it("re-inviting an existing member updates their role instead of erroring (upsert)", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    const secondInvite = await inviteMember(space.id, USER_B.email, "editor");
    expect(secondInvite.status).toBe(201);

    const membersRes = await app.request(`/api/public/v1/spaces/${space.id}/members`);
    const body = (await membersRes.json()) as { members: { userId: string; role: string }[] };
    const bRow = body.members.find((m) => m.userId === USER_B.id);
    expect(bRow?.role).toBe("editor");
  });

  it("DELETE /:id (creator) removes the space and its members — the space disappears from B's list too", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    const deleteRes = await app.request(`/api/public/v1/spaces/${space.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ deleted: true, id: space.id });

    const listA = await app.request("/api/public/v1/spaces");
    expect(await listA.json()).toEqual({ spaces: [] });

    useSession(USER_B);
    const listB = await app.request("/api/public/v1/spaces");
    expect(await listB.json()).toEqual({ spaces: [] });

    const getRes = await app.request(`/api/public/v1/spaces/${space.id}`);
    expect(getRes.status).toBe(404);
  });

  it("a bearer token with write:drive can create a space bound to its own userId", async () => {
    seedUsers();
    runtime.secrets.set("AGENT_TOKEN", "spaces-agent-token");
    runtime.vars.set("AGENT_TOKEN_SCOPES", "read:drive write:drive path:/");
    // The legacy global AGENT_TOKEN binds to the deployment owner (resolveOwnerUserId);
    // with OWNER_EMAIL unset that resolves to null — no user identity to attribute a
    // space's creatorId to, so it must be rejected rather than silently creating an
    // ownerless space (spaces.creatorId is NOT NULL).
    const res = await app.request("/api/public/v1/spaces", {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: "Bearer spaces-agent-token" },
      body: JSON.stringify({ name: "Agent Space" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("identity_required");
  });
});
