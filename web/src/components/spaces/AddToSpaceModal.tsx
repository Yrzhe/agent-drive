import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { spacesApi } from "@/hooks/useSpaces";
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void spacesApi
      .listSpaces()
      .then((result) => {
        if (cancelled) return;
        const eligible = result.spaces.filter((space) => CAN_CONTRIBUTE.has(space.role));
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
  }, []);

  const submit = async () => {
    if (!selectedSpaceId) return;
    setSubmitting(true);
    setError(null);
    try {
      await spacesApi.addItem(selectedSpaceId, target.isFolder ? "folder" : "file", target.path);
      onAdded();
    } catch (err) {
      setError(getErrorMessage(err));
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

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This is a reference, not a copy. Anyone with an <span className="font-medium">editor</span> role in the space can modify
          this real {target.isFolder ? "folder's" : "file's"} contents — changes reflect back here.
        </div>

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
                  onChange={() => setSelectedSpaceId(space.id)}
                  type="radio"
                  value={space.id}
                />
                <span className="text-slate-800">{space.name}</span>
                <span className="text-xs text-slate-500">({space.role})</span>
              </label>
            ))}
          </div>
        )}

        {error ? <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={submitting || !selectedSpaceId}
            onClick={() => {
              void submit();
            }}
            type="button"
          >
            {submitting ? "Adding..." : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
