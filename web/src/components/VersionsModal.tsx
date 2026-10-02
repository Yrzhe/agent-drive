import { useCallback, useEffect, useState } from "react";
import { apiFetchJson } from "@/lib/api-client";
import { uploadBlob } from "@/lib/upload";
import type { DriveFile, UploadTicket } from "@/types/drive";

type Version = { id: string; name: string; size: number; contentType: string | null; createdAt: string; current: boolean };
export function VersionsModal({ file, onClose, onChange }: { file: DriveFile; onClose: () => void; onChange: () => void }) {
  const [rows, setRows] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const base = `/api/public/v1/files/${encodeURIComponent(file.id)}/versions`;
  const refresh = useCallback(async () => {
    const data = await apiFetchJson<{ versions: Version[] }>(`${base}?limit=50`);
    setRows(data.versions);
    setHasMore(data.versions.length === 50);
  }, [base]);
  useEffect(() => { void refresh().catch((e: Error) => setError(e.message)); }, [refresh]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); await refresh(); onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : "Version operation failed"); }
    finally { setBusy(false); setProgress(null); }
  }
  const upload = (blob: File) => action(async () => {
    const ticket = await apiFetchJson<UploadTicket & { sessionId: string }>(`${base}/upload`, { method: "POST", body: JSON.stringify({ size: blob.size, contentType: blob.type || "application/octet-stream" }) });
    await uploadBlob(ticket, blob, setProgress);
    await apiFetchJson(`${base}/complete`, { method: "POST", body: JSON.stringify({ sessionId: ticket.sessionId }) });
  });
  const download = (version: Version) => action(async () => {
    const { downloadUrl } = await apiFetchJson<{ downloadUrl: string }>(`${base}/${encodeURIComponent(version.id)}/download`);
    const a = document.createElement("a"); a.href = downloadUrl; a.download = version.name; a.rel = "noreferrer"; a.click();
  });
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div role="dialog" aria-modal="true" aria-label="File versions" className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">Versions · {file.name}</h3><button type="button" disabled={busy} onClick={onClose} className="rounded border px-3 py-1">Close</button></div>
      <p className="mt-2 text-sm text-slate-600">Updating keeps the same file and latest share links. Fixed links retain their original bytes. History uses storage quota; purging the file removes its history.</p>
      <label className="mt-4 block text-sm font-medium">Upload a new version<input disabled={busy} type="file" className="mt-2 block w-full text-sm" onChange={(e) => { const blob = e.target.files?.[0]; if (blob) void upload(blob); e.target.value = ""; }} /></label>
      {progress !== null ? <p className="mt-2 text-sm">Uploading {progress}%</p> : null}
      {error ? <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 max-h-80 overflow-y-auto"><ul className="divide-y">
        {rows.map((v) => <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
          <div><p>{new Date(v.createdAt).toLocaleString()} {v.current ? "· Current" : ""}</p><p className="text-xs text-slate-500">{v.name} · {v.size.toLocaleString()} bytes</p></div>
          <div className="flex gap-2"><button disabled={busy} className="rounded border px-2 py-1" onClick={() => { void download(v); }}>Download</button>
          {!v.current ? <button disabled={busy} className="rounded border px-2 py-1" onClick={() => { void action(async () => { await apiFetchJson(`${base}/${encodeURIComponent(v.id)}/restore`, { method: "POST" }); }); }}>Restore</button> : null}</div>
        </li>)}
      </ul></div>
      {hasMore ? <button disabled={busy} className="mt-2 text-sm text-blue-700" onClick={() => { setBusy(true); void apiFetchJson<{ versions: Version[] }>(`${base}?limit=50&offset=${rows.length}`).then((data) => { setRows((old) => [...old, ...data.versions]); setHasMore(data.versions.length === 50); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>Show more versions</button> : null}
    </div>
  </div>;
}
