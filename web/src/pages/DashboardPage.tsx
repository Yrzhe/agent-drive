import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { FileTable } from "@/components/FileTable";
import { PreviewModal } from "@/components/PreviewModal";
import { ShareModal, type ShareModalInput } from "@/components/ShareModal";
import { UploadZone, type UploadProgress } from "@/components/UploadZone";
import { useAuth } from "@/hooks/useAuth";
import { DriveApiError } from "@/lib/api-client";
import { driveApi } from "@/lib/drive-api";
import { normalizePath } from "@/lib/path-utils";
import type { DriveFile, ShareLink, ShareStats } from "@/types/drive";

const formatDate = (value: string) => new Date(value).toLocaleString();
const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const shareTargetLabel = (share: ShareLink) => `${share.type === "folder" ? "Folder" : "File"}: ${share.targetName}`;

export default function DashboardPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPath = useMemo(() => normalizePath(searchParams.get("path") ?? "/"), [searchParams]);
  const setCurrentPath = useCallback((path: string) => {
    const normalized = normalizePath(path);
    setSearchParams(normalized === "/" ? {} : { path: normalized }, { replace: false });
  }, [setSearchParams]);
  const [entries, setEntries] = useState<DriveFile[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DriveFile[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<DriveFile | null>(null);
  const [previewTarget, setPreviewTarget] = useState<DriveFile | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [expandedShareStats, setExpandedShareStats] = useState<Record<string, boolean>>({});
  const [shareStatsById, setShareStatsById] = useState<Record<string, ShareStats | undefined>>({});
  const [loadingShareStats, setLoadingShareStats] = useState<Record<string, boolean>>({});
  const [shareStatsErrors, setShareStatsErrors] = useState<Record<string, string | undefined>>({});
  const expandedShareStatsRef = useRef(expandedShareStats);
  const shareStatsByIdRef = useRef(shareStatsById);
  const loadingShareStatsRef = useRef(loadingShareStats);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const isSearchActive = debouncedSearchQuery.trim().length > 0;
  const displayedEntries = isSearchActive ? searchResults : entries;
  expandedShareStatsRef.current = expandedShareStats;
  shareStatsByIdRef.current = shareStatsById;
  loadingShareStatsRef.current = loadingShareStats;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

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

  const refreshVisibleEntries = useCallback(async () => {
    if (debouncedSearchQuery) {
      const result = await driveApi.searchFiles(debouncedSearchQuery);
      setSearchResults(result.files);
      return;
    }
    await refreshFiles(currentPath);
  }, [currentPath, debouncedSearchQuery, refreshFiles]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshFiles(currentPath);
  }, [isAuthenticated, currentPath, refreshFiles]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [currentPath, debouncedSearchQuery]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshShares();
  }, [isAuthenticated, refreshShares]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!debouncedSearchQuery) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    void driveApi.searchFiles(debouncedSearchQuery).then((result) => {
      if (cancelled) return;
      setSearchResults(result.files);
      setErrorMessage(null);
    }).catch((error) => {
      if (cancelled) return;
      setSearchResults([]);
      setErrorMessage(getErrorMessage(error));
    }).finally(() => {
      if (!cancelled) setSearching(false);
    });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery, isAuthenticated]);

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
      await refreshVisibleEntries();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [currentPath, refreshVisibleEntries, uploadSingleFile]);

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
      await refreshVisibleEntries();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [currentPath, refreshVisibleEntries, uploadSingleFile]);

  const handleCreateFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    try {
      await driveApi.createFolder(name.trim(), currentPath);
      await refreshVisibleEntries();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleRename = async (entry: DriveFile) => {
    const name = window.prompt("Enter a new name", entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      await driveApi.renameFile(entry.id, { name: name.trim() });
      await refreshVisibleEntries();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleDelete = async (entry: DriveFile) => {
    const confirmText = entry.isFolder ? `Delete folder "${entry.name}" and everything inside?` : `Delete file "${entry.name}"?`;
    if (!window.confirm(confirmText)) return;
    try {
      await driveApi.deleteFile(entry.id);
      setSelectedIds((current) => {
        if (!current.has(entry.id)) return current;
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
      await Promise.all([refreshVisibleEntries(), refreshShares()]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleToggleSelect = useCallback((id: string, next: boolean) => {
    setSelectedIds((current) => {
      const updated = new Set(current);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  }, []);

  const handleToggleSelectAll = useCallback((next: boolean) => {
    if (!next) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(displayedEntries.map((entry) => entry.id)));
  }, [displayedEntries]);

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected item${ids.length === 1 ? "" : "s"}? Folders include all their contents.`)) return;
    setBulkBusy(true);
    try {
      const result = await driveApi.deleteFiles(ids);
      setSelectedIds(new Set());
      if (result.failures.length > 0) {
        setErrorMessage(`${result.trashedFiles + result.trashedFolders} moved to trash, ${result.failures.length} failed: ${result.failures.map((f) => f.message).slice(0, 3).join("; ")}`);
      } else {
        setErrorMessage(null);
      }
      await Promise.all([refreshVisibleEntries(), refreshShares()]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkMove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const target = window.prompt(`Move ${ids.length} item${ids.length === 1 ? "" : "s"} to which folder path?`, currentPath);
    if (target === null) return;
    const parentPath = normalizePath(target.trim() || "/");
    setBulkBusy(true);
    try {
      const result = await driveApi.moveFiles(ids, parentPath);
      setSelectedIds(new Set());
      if (result.failures.length > 0) {
        setErrorMessage(`${result.moved} moved, ${result.failures.length} failed: ${result.failures.map((f) => f.message).slice(0, 3).join("; ")}`);
      } else {
        setErrorMessage(null);
      }
      await Promise.all([refreshVisibleEntries(), refreshShares()]);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleCreateShare = async (input: ShareModalInput) => {
    if (!shareTarget) return;
    try {
      const expiresIn = input.expiresAt ? Math.max(1, Math.round((new Date(input.expiresAt).getTime() - Date.now()) / 1000)) : undefined;
      const apiInput = {
        password: input.password,
        maxDownloads: input.maxDownloads ?? undefined,
        expiresIn: expiresIn ?? undefined,
      };
      const payload = shareTarget.isFolder ? { ...apiInput, folderPath: shareTarget.path } : { ...apiInput, fileId: shareTarget.id };
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
      setExpandedShareStats((current) => {
        const next = { ...current };
        delete next[shareId];
        return next;
      });
      setShareStatsById((current) => {
        const next = { ...current };
        delete next[shareId];
        return next;
      });
      await refreshShares();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const loadPreview = useCallback((fileId: string) => driveApi.previewFile(fileId), []);

  const handleOpenFolder = useCallback((entry: DriveFile) => {
    if (!entry.isFolder) return;
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchResults([]);
    setCurrentPath(entry.path);
  }, [setCurrentPath]);

  const handleToggleShareStats = useCallback(async (shareId: string) => {
    const nextExpanded = !expandedShareStatsRef.current[shareId];
    setExpandedShareStats((current) => ({ ...current, [shareId]: nextExpanded }));
    if (!nextExpanded || shareStatsByIdRef.current[shareId] || loadingShareStatsRef.current[shareId]) return;

    setLoadingShareStats((current) => ({ ...current, [shareId]: true }));
    setShareStatsErrors((current) => ({ ...current, [shareId]: undefined }));
    try {
      const stats = await driveApi.getShareStats(shareId);
      setShareStatsById((current) => ({ ...current, [shareId]: stats }));
    } catch (error) {
      setShareStatsErrors((current) => ({ ...current, [shareId]: getErrorMessage(error) }));
    } finally {
      setLoadingShareStats((current) => ({ ...current, [shareId]: false }));
    }
  }, []);

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      window.alert("Share link copied.");
    } catch {
      window.prompt("Copy failed. Please copy manually:", url);
    }
  };

  if (authLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div></main>;
  if (!isAuthenticated) return <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16"><AuthLoginPanel redirectTo="/drive" /></main>;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div><h1 className="text-xl font-semibold text-slate-900">Agent Drive Dashboard</h1><p className="text-sm text-slate-600">Current user: {user?.email ?? user?.name ?? "Unknown"}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-400 focus:border-blue-500"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search files and folders"
              type="search"
              value={searchQuery}
            />
            <Link className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700" to="/connect"><span aria-hidden="true">+</span> Connect AI Agent</Link>
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/bundles">Synced bundles</Link>
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/trash">Trash</Link>
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/guide">Open Guide</Link>
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">Sign out</button>
          </div>
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
              <input className="hidden" onChange={(event) => { void handleUploadFolder(event.target.files ? Array.from(event.target.files) : []); event.target.value = ""; }} ref={folderInputRef} type="file" webkitdirectory="" />
            </div>
          </div>

          <UploadZone uploading={uploading} progress={uploadProgress} onFilesSelected={(f) => { void handleUploadFiles(f); }} onFolderSelected={(f) => { void handleUploadFolder(f); }} />
          {errorMessage ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div> : null}
          {!loadingFiles && !isSearchActive && entries.length === 0 ? (
            <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              First time? <Link className="font-medium underline underline-offset-2" to="/connect">Connect your AI agent →</Link>
            </div>
          ) : null}
          {isSearchActive ? (
            <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              Showing search results for <span className="font-medium">{debouncedSearchQuery}</span>. Clear the search box to return to <span className="font-medium">{currentPath}</span>.
            </div>
          ) : null}
          {selectedIds.size > 0 ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              <div>{selectedIds.size} selected</div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                  disabled={bulkBusy}
                  onClick={() => { void handleBulkMove(); }}
                  type="button"
                >
                  Move…
                </button>
                <button
                  className="rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                  disabled={bulkBusy}
                  onClick={() => { void handleBulkDelete(); }}
                  type="button"
                >
                  Delete
                </button>
                <button
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                  disabled={bulkBusy}
                  onClick={() => setSelectedIds(new Set())}
                  type="button"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : null}
          <FileTable
            entries={displayedEntries}
            loading={isSearchActive ? searching : loadingFiles}
            onDelete={(entry) => { void handleDelete(entry); }}
            onOpenFolder={handleOpenFolder}
            onPreview={(entry) => setPreviewTarget(entry)}
            onRename={(entry) => { void handleRename(entry); }}
            onShare={(entry) => setShareTarget(entry)}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            selectedIds={selectedIds}
          />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Share links</h2>
          {loadingShares ? <p className="text-sm text-slate-600">Loading share links...</p> : shares.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">No share links yet.</p>
              <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                First time? <Link className="font-medium underline underline-offset-2" to="/connect">Connect your AI agent →</Link>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {shares.map((share) => {
                const stats = shareStatsById[share.id];
                const fileBreakdown = stats?.fileBreakdown ?? [];
                const ipBreakdown = stats?.ipBreakdown ?? [];
                const userAgentBreakdown = stats?.userAgentBreakdown ?? [];
                return (
                <div className="rounded-xl border border-slate-200 p-3" key={share.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1 text-sm">
                      <div className="font-medium text-slate-900">{shareTargetLabel(share)}</div>
                      <div className="text-slate-600">{share.shareUrl} {share.hasPassword ? "· Password protected" : ""}</div>
                      <div className="text-xs text-slate-500">Downloads {share.downloadCount}{share.maxDownloads ? ` / ${share.maxDownloads}` : ""}{share.expiresAt ? ` · Expires ${formatDate(share.expiresAt)}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" to={`/s/${share.id}`}>Open</Link>
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => { void handleToggleShareStats(share.id); }} type="button">
                        {expandedShareStats[share.id] ? "Hide Stats" : "Stats"}
                      </button>
                      <button className="rounded bg-slate-900 px-2 py-1 text-xs text-white" onClick={() => { void handleCopy(share.shareUrl); }} type="button">Copy Link</button>
                      <button className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => { void handleDeleteShare(share.id); }} type="button">Delete</button>
                    </div>
                  </div>
                  {expandedShareStats[share.id] ? (
                    <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                      {loadingShareStats[share.id] ? <div>Loading stats...</div> : shareStatsErrors[share.id] ? <div className="text-red-600">{shareStatsErrors[share.id]}</div> : stats ? (
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-x-6 gap-y-1">
                            <span>Total downloads: <span className="font-medium text-slate-900">{stats?.totalDownloads ?? 0}</span></span>
                            <span>Total accesses: <span className="font-medium text-slate-900">{stats?.totalAccesses ?? 0}</span></span>
                            <span>First accessed: <span className="font-medium text-slate-900">{stats?.firstAccessed ? formatDate(stats.firstAccessed) : "Never"}</span></span>
                            <span>Last accessed: <span className="font-medium text-slate-900">{stats?.lastAccessed ? formatDate(stats.lastAccessed) : "Never"}</span></span>
                            <span>Last download: <span className="font-medium text-slate-900">{stats?.lastDownload ? formatDate(stats.lastDownload) : "Never"}</span></span>
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div>
                              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Top IPs</div>
                              <div className="space-y-1">
                                {ipBreakdown.length > 0 ? ipBreakdown.map((item) => (
                                  <div className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1" key={`${share.id}-ip-${item.ip}`}>
                                    <span className="truncate text-slate-800">{item.ip}</span>
                                    <span className="text-xs text-slate-500">{item.count ?? 0}</span>
                                  </div>
                                )) : <div className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500">No IP data</div>}
                              </div>
                            </div>
                            <div>
                              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Top User Agents</div>
                              <div className="space-y-1">
                                {userAgentBreakdown.length > 0 ? userAgentBreakdown.map((item) => (
                                  <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1" key={`${share.id}-ua-${item.userAgent}`}>
                                    <span className="min-w-0 truncate text-slate-800" title={item.userAgent}>{item.userAgent}</span>
                                    <span className="shrink-0 text-xs text-slate-500">{item.count ?? 0}</span>
                                  </div>
                                )) : <div className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500">No user agent data</div>}
                              </div>
                            </div>
                            {share.type === "folder" ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">File Downloads</div>
                                <div className="space-y-1">
                                  {fileBreakdown.length > 0 ? fileBreakdown.map((item) => (
                                    <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1" key={`${share.id}-file-${item.fileId}`}>
                                      <span className="min-w-0 truncate text-slate-800">{item.filename}</span>
                                      <span className="shrink-0 text-xs text-slate-500">{item.downloads ?? 0}</span>
                                    </div>
                                  )) : <div className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500">No file download data</div>}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : <div>No stats yet.</div>}
                    </div>
                  ) : null}
                </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {shareTarget ? <ShareModal onCancel={() => setShareTarget(null)} onCreate={(input) => { void handleCreateShare(input); }} target={shareTarget} /> : null}
      {previewTarget ? <PreviewModal loadPreview={loadPreview} onClose={() => setPreviewTarget(null)} target={previewTarget} /> : null}
    </main>
  );
}
