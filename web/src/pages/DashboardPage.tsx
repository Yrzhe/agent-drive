import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { FileTable } from "@/components/FileTable";
import { ShareModal, type ShareModalInput } from "@/components/ShareModal";
import { UploadZone, type UploadProgress } from "@/components/UploadZone";
import { useAuth } from "@/hooks/useAuth";
import { DriveApiError } from "@/lib/api-client";
import { driveApi } from "@/lib/drive-api";
import type { DriveFile, ShareLink } from "@/types/drive";

const formatDate = (value: string) => new Date(value).toLocaleString();
const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const shareTargetLabel = (share: ShareLink) => `${share.type === "folder" ? "Folder" : "File"}: ${share.targetName}`;

export default function DashboardPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<DriveFile[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<DriveFile | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const refreshFiles = useCallback(async (path: string) => {
    setLoadingFiles(true);
    try {
      const result = await driveApi.listFiles(path);
      setEntries(result.files);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  const refreshShares = useCallback(async () => {
    setLoadingShares(true);
    try {
      const result = await driveApi.listShares();
      setShares(result.shares);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setLoadingShares(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshFiles(currentPath);
  }, [isAuthenticated, currentPath, refreshFiles]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshShares();
  }, [isAuthenticated, refreshShares]);

  const uploadSingleFile = useCallback(async (file: File, targetPath: string) => {
    setUploadProgress({ filename: file.name, percent: 0 });
    const ticket = await driveApi.requestUpload({ filename: file.name, contentType: file.type || "application/octet-stream", size: file.size, path: targetPath });
    if (!ticket.uploadUrl.startsWith("mock://")) {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", ticket.uploadUrl);
        for (const [key, value] of Object.entries(ticket.requiredHeaders)) {
          xhr.setRequestHeader(key, value);
        }
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress({ filename: file.name, percent: Math.round((event.loaded / event.total) * 100) });
          }
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new DriveApiError(`Upload failed (${xhr.status})`, xhr.status, "UPLOAD_FAILED")));
        xhr.onerror = () => reject(new DriveApiError("Upload network error", 0, "UPLOAD_FAILED"));
        xhr.send(file);
      });
    }
    setUploadProgress({ filename: file.name, percent: 100 });
    await driveApi.completeUpload(ticket.fileId, file.name, targetPath);
  }, []);

  const handleUploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setErrorMessage(null);
    try {
      for (const file of files) {
        await uploadSingleFile(file, currentPath);
      }
      await refreshFiles(currentPath);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [currentPath, refreshFiles, uploadSingleFile]);

  const handleUploadFolder = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setErrorMessage(null);
    try {
      for (const file of files) {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const parts = relativePath.split("/");
        const fileName = parts.pop() || file.name;
        const subPath = parts.length > 0 ? `${currentPath === "/" ? "" : currentPath}/${parts.join("/")}` : currentPath;
        await uploadSingleFile(new File([file], fileName, { type: file.type }), subPath);
      }
      await refreshFiles(currentPath);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [currentPath, refreshFiles, uploadSingleFile]);

  const handleCreateFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    try {
      await driveApi.createFolder(name.trim(), currentPath);
      await refreshFiles(currentPath);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleRename = async (entry: DriveFile) => {
    const name = window.prompt("Enter a new name", entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      await driveApi.renameFile(entry.id, { name: name.trim() });
      await refreshFiles(currentPath);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleDelete = async (entry: DriveFile) => {
    const confirmText = entry.isFolder ? `Delete folder "${entry.name}" and everything inside?` : `Delete file "${entry.name}"?`;
    if (!window.confirm(confirmText)) return;
    try {
      await driveApi.deleteFile(entry.id);
      await Promise.all([refreshFiles(currentPath), refreshShares()]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleCreateShare = async (input: ShareModalInput) => {
    if (!shareTarget) return;
    try {
      const payload = shareTarget.isFolder ? { ...input, folderPath: shareTarget.path } : { ...input, fileId: shareTarget.id };
      await driveApi.createShare(payload);
      await refreshShares();
      setShareTarget(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleDeleteShare = async (shareId: string) => {
    if (!window.confirm("Delete this share link?")) return;
    try {
      await driveApi.deleteShare(shareId);
      await refreshShares();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      window.alert("Share link copied.");
    } catch {
      window.prompt("Copy failed. Please copy manually:", url);
    }
  };

  if (authLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div></main>;
  if (!isAuthenticated) return <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16"><AuthLoginPanel /></main>;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div><h1 className="text-xl font-semibold text-slate-900">Agent Drive Dashboard</h1><p className="text-sm text-slate-600">Current user: {user?.email ?? user?.name ?? "Unknown"}</p></div>
          <div className="flex items-center gap-2"><Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/guide">Open Guide</Link><button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">Sign out</button></div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Breadcrumbs currentPath={currentPath} onNavigate={setCurrentPath} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">{driveApi.isMockMode ? "Mock mode" : "Live API mode"}</span>
              <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" onClick={() => { void handleCreateFolder(); }} type="button">New Folder</button>
              <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700" onClick={() => fileInputRef.current?.click()} type="button">Upload Files</button>
              <button className="rounded-lg border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50" onClick={() => folderInputRef.current?.click()} type="button">Upload Folder</button>
              <input className="hidden" multiple onChange={(event) => { void handleUploadFiles(event.target.files ? Array.from(event.target.files) : []); event.target.value = ""; }} ref={fileInputRef} type="file" />
              {/* @ts-expect-error webkitdirectory is non-standard */}
              <input className="hidden" onChange={(event) => { void handleUploadFolder(event.target.files ? Array.from(event.target.files) : []); event.target.value = ""; }} ref={folderInputRef} type="file" webkitdirectory="" />
            </div>
          </div>

          <UploadZone uploading={uploading} progress={uploadProgress} onFilesSelected={(f) => { void handleUploadFiles(f); }} onFolderSelected={(f) => { void handleUploadFolder(f); }} />
          {errorMessage ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div> : null}
          <FileTable entries={entries} loading={loadingFiles} onDelete={(entry) => { void handleDelete(entry); }} onOpenFolder={(entry) => setCurrentPath(entry.path)} onRename={(entry) => { void handleRename(entry); }} onShare={(entry) => setShareTarget(entry)} />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Share links</h2>
          {loadingShares ? <p className="text-sm text-slate-600">Loading share links...</p> : shares.length === 0 ? <p className="text-sm text-slate-500">No share links yet.</p> : (
            <div className="space-y-2">
              {shares.map((share) => (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3" key={share.id}>
                  <div className="space-y-1 text-sm">
                    <div className="font-medium text-slate-900">{shareTargetLabel(share)}</div>
                    <div className="text-slate-600">{share.shareUrl} {share.hasPassword ? "· Password protected" : ""}</div>
                    <div className="text-xs text-slate-500">Downloads {share.downloadCount}{share.maxDownloads ? ` / ${share.maxDownloads}` : ""}{share.expiresAt ? ` · Expires ${formatDate(share.expiresAt)}` : ""}</div>
                  </div>
                  <div className="flex items-center gap-2"><Link className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" to={`/s/${share.id}`}>Open</Link><button className="rounded bg-slate-900 px-2 py-1 text-xs text-white" onClick={() => { void handleCopy(share.shareUrl); }} type="button">Copy Link</button><button className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => { void handleDeleteShare(share.id); }} type="button">Delete</button></div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {shareTarget ? <ShareModal onCancel={() => setShareTarget(null)} onCreate={(input) => { void handleCreateShare(input); }} target={shareTarget} /> : null}
    </main>
  );
}
