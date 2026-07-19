import { useCallback, useEffect, useState } from "react";
import { spacesApi } from "@/hooks/useSpaces";
import type { MemberRole, SpaceMember } from "@/types/spaces";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const MEMBER_ROLES: readonly MemberRole[] = ["viewer", "contributor", "editor"];

/**
 * Creator-only member management for a space. Rendered only when the caller's resolved
 * role for this space is "creator" (see SpaceViewPage) — the server enforces the same gate
 * on every mutation here (`assertSpaceRole(db, spaceId, callerId, "creator")`), so this
 * component never needs to re-derive permissions beyond hiding controls for the creator's
 * own row (the server rejects changing/removing the creator, see `space_members` routes).
 */
export function MemberManagementSection({ spaceId, creatorId, onChanged }: { spaceId: string; creatorId: string; onChanged: () => void }) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await spacesApi.listMembers(spaceId);
      setMembers(result.members);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markBusy = (userId: string, busy: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setInviteError(null);
    try {
      await spacesApi.inviteMember(spaceId, email, inviteRole);
      setInviteEmail("");
      await refresh();
      onChanged();
    } catch (err) {
      setInviteError(getErrorMessage(err));
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (member: SpaceMember, role: MemberRole) => {
    markBusy(member.userId, true);
    setRowErrors((current) => ({ ...current, [member.userId]: undefined }));
    try {
      await spacesApi.updateMemberRole(spaceId, member.userId, role);
      await refresh();
    } catch (err) {
      setRowErrors((current) => ({ ...current, [member.userId]: getErrorMessage(err) }));
    } finally {
      markBusy(member.userId, false);
    }
  };

  const handleRemove = async (member: SpaceMember) => {
    if (!window.confirm(`Remove ${member.email ?? member.userId} from this space? Their contributed items will also be removed from it.`)) return;
    markBusy(member.userId, true);
    setRowErrors((current) => ({ ...current, [member.userId]: undefined }));
    try {
      await spacesApi.removeMember(spaceId, member.userId);
      await refresh();
      onChanged();
    } catch (err) {
      setRowErrors((current) => ({ ...current, [member.userId]: getErrorMessage(err) }));
    } finally {
      markBusy(member.userId, false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Members</h2>

      <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
        ⚠ Items in this space are shared by reference, not copied. Anyone with the <span className="font-semibold">editor</span> role
        can modify the files and notes you contribute to this space — those are your real files, and their edits apply directly to
        them.
      </div>

      {error ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-100">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Added</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="px-3 py-4 text-slate-600" colSpan={4}>Loading...</td></tr>
            ) : members.length === 0 ? (
              <tr><td className="px-3 py-4 text-slate-500" colSpan={4}>No members yet.</td></tr>
            ) : (
              members.map((member) => {
                const isCreator = member.userId === creatorId;
                const busy = busyIds.has(member.userId);
                const rowError = rowErrors[member.userId];
                return (
                  <tr className="border-b border-slate-100" key={member.userId}>
                    <td className="px-3 py-2 text-slate-800">{member.email ?? member.userId}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {isCreator ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">creator</span>
                      ) : (
                        <select
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-800 disabled:opacity-50"
                          disabled={busy}
                          onChange={(event) => { void handleRoleChange(member, event.target.value as MemberRole); }}
                          value={member.role}
                        >
                          {MEMBER_ROLES.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{new Date(member.addedAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {!isCreator ? (
                          <button
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => { void handleRemove(member); }}
                            type="button"
                          >
                            Remove
                          </button>
                        ) : null}
                        {rowError ? <span className="text-xs text-red-600">{rowError}</span> : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <h3 className="mb-2 text-sm font-medium text-slate-900">Invite a member</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500"
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="Existing user's email"
            type="email"
            value={inviteEmail}
          />
          <select
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
            onChange={(event) => setInviteRole(event.target.value as MemberRole)}
            value={inviteRole}
          >
            {MEMBER_ROLES.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <button
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={inviting || !inviteEmail.trim()}
            onClick={() => { void handleInvite(); }}
            type="button"
          >
            {inviting ? "Inviting..." : "Invite"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Invites only work for an existing Agent Drive account — the invited user is added immediately, with no accept step.
        </p>
        {inviteError ? <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{inviteError}</p> : null}
      </div>
    </section>
  );
}
