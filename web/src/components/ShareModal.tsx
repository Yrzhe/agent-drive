import { useEffect, useState } from "react";
import type { DriveFile } from "@/types/drive";

export type ShareModalInput = {
  password?: string;
  maxDownloads?: number | null;
  expiresAt?: string | null;
};

export function ShareModal({
  target,
  onCancel,
  onCreate,
}: {
  target: DriveFile;
  onCancel: () => void;
  onCreate: (input: ShareModalInput) => void;
}) {
  const [password, setPassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword("");
    setMaxDownloads("");
    setExpiresAt("");
    setError(null);
  }, [target.id]);

  const submit = () => {
    setError(null);
    let max: number | null | undefined = null;
    if (maxDownloads.trim()) {
      const parsed = Number(maxDownloads);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Max downloads must be a positive integer.");
        return;
      }
      max = parsed;
    }

    let expiration: string | null | undefined = null;
    if (expiresAt) {
      const ms = new Date(expiresAt).getTime();
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        setError("Expiration time must be in the future.");
        return;
      }
      expiration = new Date(ms).toISOString();
    }

    onCreate({ password: password.trim() || undefined, maxDownloads: max, expiresAt: expiration });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">Create share link</h3>
        <p className="mt-1 text-sm text-slate-600">{target.path}</p>

        <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="share-password">Password (optional)</label>
        <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" id="share-password" onChange={(event) => setPassword(event.target.value)} placeholder="Leave blank for no password" type="password" value={password} />

        <label className="mt-3 block text-sm font-medium text-slate-700" htmlFor="share-max-downloads">Max downloads (optional)</label>
        <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" id="share-max-downloads" min={1} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="e.g. 10" type="number" value={maxDownloads} />

        <label className="mt-3 block text-sm font-medium text-slate-700" htmlFor="share-expires-at">Expiration time (optional)</label>
        <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" id="share-expires-at" onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} />

        {error ? <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" onClick={onCancel} type="button">Cancel</button>
          <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700" onClick={submit} type="button">Create link</button>
        </div>
      </div>
    </div>
  );
}
