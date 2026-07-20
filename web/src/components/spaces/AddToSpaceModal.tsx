import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { spacesApi } from "@/hooks/useSpaces";
import { DriveApiError } from "@/lib/api-client";
import type { DriveFile } from "@/types/drive";
import type { SpaceSummary } from "@/types/spaces";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

// Only spaces where the caller can contribute (contributor/editor/creator) accept a new
// item — `assertSpaceRole(db, spaceId, callerId, "contributor")` on the server rejects a
// viewer. Filter here so the picker never offers a space that would 403.
const CAN_CONTRIBUTE = new Set<SpaceSummary["role"]>(["contributor", "editor", "creator"]);

export function AddToSpaceModal({ target, onCancel, onAdded }: { target: DriveFile; onCancel: () => void; onAdded: () => void }) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void spacesApi
      .listSpaces()
      .then((result) => {
        if (cancelled) return;
        // D4: the public commons never accepts folders (a folder expands to its whole live
        // subtree on read) — it's excluded from the picker outright when the target is a
        // folder, rather than offered and rejected by the server.
        const eligible = result.spaces.filter(
          (space) => CAN_CONTRIBUTE.has(space.role) && !(target.isFolder && space.visibility === "public"),
        );
        setSpaces(eligible);
        setSelectedSpaceId(eligible[0]?.id ?? null);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.isFolder]);

  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId) ?? null;
  const isPublicTarget = selectedSpace?.visibility === "public";

  const submit = async () => {
    if (!selectedSpaceId) return;
    setSubmitting(true);
    setError(null);
    try {
      await spacesApi.addItem(selectedSpaceId, target.isFolder ? "folder" : "file", target.path);
      onAdded();
    } catch (err) {
      if (err instanceof DriveApiError && err.code === "folders_not_allowed_in_public") {
        setError("The public commons only accepts files and memory, not folders — add individual files instead.");
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">Add to space</h3>
        <p className="mt-1 text-sm text-slate-600">
          {target.isFolder ? "Folder" : "File"}: {target.path}
        </p>

        {target.isFolder ? (
          <p className="mt-2 text-xs text-slate-500">
            The public commons isn't shown below — it only accepts files and memory, not folders.
          </p>
        ) : null}

        {loading ? (
          <p className="mt-4 text-sm text-slate-600">Loading your spaces...</p>
        ) : spaces.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">
            You don't have a space you can contribute to yet.{" "}
            <Link className="font-medium text-blue-700 underline underline-offset-2" to="/spaces">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-2">
            {spaces.map((space) => (
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50" key={space.id}>
                <input
                  checked={selectedSpaceId === space.id}
                  name="add-to-space-target"
                  onChange={() => {
                    setSelectedSpaceId(space.id);
                    setConfirmPublish(false);
                  }}
                  type="radio"
                  value={space.id}
                />
                <span className="text-slate-800">{space.name}</span>
                {space.visibility === "public" ? (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Public</span>
                ) : null}
                <span className="text-xs text-slate-500">({space.role})</span>
              </label>
            ))}
          </div>
        )}

        {selectedSpace ? (
          isPublicTarget ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <p className="font-medium">This is the public commons.</p>
              <p className="mt-1">
                Publishing this {target.isFolder ? "folder" : "file"} here makes it readable by EVERY active user of this
                drive — not just people you invite. It's a reference, not a copy, and you can withdraw it later, but until you
                do it's world-readable within this deployment.
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  checked={confirmPublish}
                  onChange={(event) => setConfirmPublish(event.target.checked)}
                  type="checkbox"
                />
                <span>I understand this becomes readable by everyone on this drive.</span>
              </label>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This is a reference, not a copy. Anyone with an <span className="font-medium">editor</span> role in the space can
              modify this real {target.isFolder ? "folder's" : "file's"} contents — changes reflect back here.
            </div>
          )
        ) : null}

        {error ? <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={submitting || !selectedSpaceId || (isPublicTarget && !confirmPublish)}
            onClick={() => {
              void submit();
            }}
            type="button"
          >
            {submitting ? "Adding..." : isPublicTarget ? "Publish" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
