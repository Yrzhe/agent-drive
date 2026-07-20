import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { PreviewModal } from "@/components/PreviewModal";
import { MemberManagementSection } from "@/components/spaces/MemberManagementSection";
import { useAccessStatus } from "@/hooks/useAccessStatus";
import { useAuth } from "@/hooks/useAuth";
import { spacesApi } from "@/hooks/useSpaces";
import { DriveApiError } from "@/lib/api-client";
import { driveApi } from "@/lib/drive-api";
import type { DriveFile } from "@/types/drive";
import { describeAudience } from "@/types/spaces";
import type { SpaceItemDisplay, SpaceMemoryHit, SpaceSummary } from "@/types/spaces";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const formatDate = (value: string) => new Date(value).toLocaleString();
const itemTypeLabel = (type: SpaceItemDisplay["itemType"]) => (type === "file" ? "File" : type === "folder" ? "Folder" : "Memory");

function spaceItemAsPreviewTarget(item: SpaceItemDisplay): DriveFile {
  // A minimal stub for PreviewModal — it only reads `id`/`name`/`path` for the initial
  // header before `loadPreview` (driveApi.previewFile) fills in real size/contentType.
  return {
    id: item.itemRef,
    name: item.name ?? item.itemRef,
    path: item.name ?? item.itemRef,
    parentPath: "/",
    isFolder: false,
    size: 0,
    contentType: null,
    createdAt: item.addedAt,
    updatedAt: item.addedAt,
  };
}

export default function SpaceViewPage() {
  const { id: spaceId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const { status: accessStatus, loading: accessLoading, error: accessError, refetch: accessRefetch } = useAccessStatus();

  const [space, setSpace] = useState<SpaceSummary | null>(null);
  const [spaceLoading, setSpaceLoading] = useState(true);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [spaceNotFound, setSpaceNotFound] = useState(false);

  const [items, setItems] = useState<SpaceItemDisplay[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set());
  const [itemActionErrors, setItemActionErrors] = useState<Record<string, string | undefined>>({});

  const [openFolderItem, setOpenFolderItem] = useState<SpaceItemDisplay | null>(null);
  const [folderFiles, setFolderFiles] = useState<DriveFile[]>([]);
  const [folderFilesLoading, setFolderFilesLoading] = useState(false);
  const [folderFilesError, setFolderFilesError] = useState<string | null>(null);

  const [previewTarget, setPreviewTarget] = useState<DriveFile | null>(null);

  const [memoryQuery, setMemoryQuery] = useState("");
  const [memorySearching, setMemorySearching] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryResults, setMemoryResults] = useState<SpaceMemoryHit[]>([]);
  const [memoryScopedToSpace, setMemoryScopedToSpace] = useState(false);

  const [deletingSpace, setDeletingSpace] = useState(false);

  const refreshSpace = useCallback(async () => {
    if (!spaceId) return;
    setSpaceLoading(true);
    try {
      const result = await spacesApi.getSpace(spaceId);
      setSpace(result.space);
      setSpaceError(null);
      setSpaceNotFound(false);
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) {
        setSpaceNotFound(true);
      } else {
        setSpaceError(getErrorMessage(error));
      }
    } finally {
      setSpaceLoading(false);
    }
  }, [spaceId]);

  const refreshItems = useCallback(async () => {
    if (!spaceId) return;
    setItemsLoading(true);
    try {
      const result = await spacesApi.listItems(spaceId);
      setItems(result.items);
      setItemsError(null);
    } catch (error) {
      setItemsError(getErrorMessage(error));
    } finally {
      setItemsLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    if (!isAuthenticated || !spaceId) return;
    void refreshSpace();
    void refreshItems();
  }, [isAuthenticated, spaceId, refreshSpace, refreshItems]);

  const markItemBusy = (id: string, busy: boolean) =>
    setBusyItemIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const canRemoveItem = useCallback(
    (item: SpaceItemDisplay) => {
      if (!space) return false;
      if (space.role === "editor" || space.role === "creator") return true;
      if (space.role === "contributor") return item.contributedBy === user?.id;
      return false;
    },
    [space, user?.id],
  );

  const handleRemoveItem = async (item: SpaceItemDisplay) => {
    if (!spaceId) return;
    if (!window.confirm(`Remove "${item.name ?? item.itemRef}" from this space? This does not delete the underlying ${itemTypeLabel(item.itemType).toLowerCase()}.`)) return;
    markItemBusy(item.id, true);
    setItemActionErrors((current) => ({ ...current, [item.id]: undefined }));
    try {
      await spacesApi.removeItem(spaceId, item.id);
      await Promise.all([refreshItems(), refreshSpace()]);
    } catch (error) {
      setItemActionErrors((current) => ({ ...current, [item.id]: getErrorMessage(error) }));
    } finally {
      markItemBusy(item.id, false);
    }
  };

  const openFolder = async (item: SpaceItemDisplay) => {
    setOpenFolderItem(item);
    setFolderFiles([]);
    setFolderFilesLoading(true);
    setFolderFilesError(null);
    try {
      // The REST surface exposes a shared folder's DESCENDANT LEAF FILES (via the read-path
      // union in fileReadableFilter), but never the shared folder row itself to a non-owner
      // member (accessibleFileIds only ever contains leaf file ids under a contributed
      // folder, design: lib/spaces.ts `expandFolderItemToFileIds`). So there's no endpoint
      // to resolve this folder item's own absolute path. Best-effort client-side match: pull
      // every file reachable via any space membership and keep the ones whose directory path
      // contains this folder's name as a path segment. This can over/under-match if multiple
      // shared folders share a name — acceptable for a P1 flat/attributed model, but not a
      // real folder browser.
      const result = await driveApi.listFiles("/", { recursive: true });
      const folderName = item.name ?? "";
      const matches = folderName
        ? result.files.filter((file) => {
            if (file.isFolder) return false;
            const segments = file.path.split("/").filter(Boolean);
            const dirSegments = segments.slice(0, -1);
            return dirSegments.includes(folderName);
          })
        : [];
      setFolderFiles(matches);
    } catch (error) {
      setFolderFilesError(getErrorMessage(error));
    } finally {
      setFolderFilesLoading(false);
    }
  };

  const handleMemorySearch = async () => {
    const query = memoryQuery.trim();
    if (!query) return;
    setMemorySearching(true);
    setMemoryError(null);
    try {
      const result = await spacesApi.searchMemory(query, 20);
      const spaceMemoryRefs = new Set(items.filter((item) => item.itemType === "memory").map((item) => item.itemRef));
      const scoped = result.memories.filter((memory) => spaceMemoryRefs.has(memory.id));
      if (scoped.length > 0) {
        setMemoryResults(scoped);
        setMemoryScopedToSpace(true);
      } else {
        // Recall within the space if available, else fall back to the caller's global
        // (own + all-spaces) recall results — there's no per-space recall REST endpoint.
        setMemoryResults(result.memories);
        setMemoryScopedToSpace(false);
      }
    } catch (error) {
      setMemoryError(getErrorMessage(error));
    } finally {
      setMemorySearching(false);
    }
  };

  const handleDeleteSpace = async () => {
    if (!spaceId || !space) return;
    if (!window.confirm(`Delete space "${space.name}"? Members lose access; contributed files and memory are not deleted.`)) return;
    setDeletingSpace(true);
    try {
      await spacesApi.deleteSpace(spaceId);
      navigate("/spaces");
    } catch (error) {
      setSpaceError(getErrorMessage(error));
      setDeletingSpace(false);
    }
  };

  const fileItems = useMemo(() => items.filter((item) => item.itemType !== "memory"), [items]);
  const memoryItems = useMemo(() => items.filter((item) => item.itemType === "memory"), [items]);

  if (authLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div></main>;
  if (!isAuthenticated) return <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16"><AuthLoginPanel redirectTo={`/spaces/${spaceId ?? ""}`} /></main>;
  if (accessLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking access status...</div></main>;
  if (!accessStatus) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">{accessError ? (<><p>{accessError}</p><button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={accessRefetch} type="button">Retry</button></>) : "Checking access status..."}</div></main>;
  if (accessStatus === "pending" || accessStatus === "suspended") return <Navigate replace to="/waitlist" />;
  if (!spaceId) return <Navigate replace to="/spaces" />;

  if (spaceNotFound) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-3xl space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">
          <p>Space not found, or you're not a member of it.</p>
          <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" to="/spaces">← Back to Spaces</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{spaceLoading ? "Loading space..." : space?.name ?? "Space"}</h1>
            <p className="text-sm text-slate-600">
              {space ? `Your role: ${space.role} · ${describeAudience(space.memberCount)} · ${space.itemCount} item${space.itemCount === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/spaces">← All spaces</Link>
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/drive">Back to Drive</Link>
            {space?.role === "creator" ? (
              <button
                className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                disabled={deletingSpace}
                onClick={() => { void handleDeleteSpace(); }}
                type="button"
              >
                {deletingSpace ? "Deleting..." : "Delete space"}
              </button>
            ) : null}
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">Sign out</button>
          </div>
        </header>

        {spaceError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{spaceError}</div> : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">Items</h2>
          <p className="mb-3 text-sm text-slate-500">
            A flat, attributed list of every file, folder, and memory shared into this space. Files and folders are added from
            the "Add to space" action in your Drive.
          </p>
          {itemsError ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{itemsError}</div> : null}
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Contributed by</th>
                  <th className="px-3 py-2 font-medium">Added</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {itemsLoading ? (
                  <tr><td className="px-3 py-4 text-slate-600" colSpan={5}>Loading items...</td></tr>
                ) : fileItems.length === 0 ? (
                  <tr><td className="px-3 py-4 text-slate-500" colSpan={5}>No files or folders shared into this space yet.</td></tr>
                ) : (
                  fileItems.map((item) => {
                    const busy = busyItemIds.has(item.id);
                    const rowError = itemActionErrors[item.id];
                    return (
                      <tr className="border-b border-slate-100" key={item.id}>
                        <td className="px-3 py-2 text-slate-800">
                          {item.itemType === "folder" ? "📁 " : "📄 "}
                          {item.name ?? <span className="italic text-slate-400">(deleted)</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{itemTypeLabel(item.itemType)}</td>
                        <td className="px-3 py-2 text-slate-600" title={item.contributedBy}>{item.contributedBy === user?.id ? "You" : item.contributedBy}</td>
                        <td className="px-3 py-2 text-slate-600">{formatDate(item.addedAt)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {item.itemType === "folder" ? (
                              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => { void openFolder(item); }} type="button">Open</button>
                            ) : item.name ? (
                              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setPreviewTarget(spaceItemAsPreviewTarget(item))} type="button">Preview</button>
                            ) : null}
                            {canRemoveItem(item) ? (
                              <button
                                className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                                disabled={busy}
                                onClick={() => { void handleRemoveItem(item); }}
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

          {openFolderItem ? (
            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">📁 {openFolderItem.name}</h3>
                <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setOpenFolderItem(null)} type="button">Close</button>
              </div>
              <p className="mb-2 text-xs text-slate-500">
                Files whose path is inside a folder named "{openFolderItem.name}". Nested sub-folder structure isn't shown for
                shared folders — this is a flat listing of files reachable through this space.
              </p>
              {folderFilesLoading ? (
                <p className="text-sm text-slate-600">Loading folder contents...</p>
              ) : folderFilesError ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{folderFilesError}</p>
              ) : folderFiles.length === 0 ? (
                <p className="text-sm text-slate-500">No files found in this folder.</p>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  <table className="min-w-full text-sm">
                    <tbody>
                      {folderFiles.map((file) => (
                        <tr className="border-b border-slate-100" key={file.id}>
                          <td className="py-1.5 pr-4 text-slate-800">{file.path}</td>
                          <td className="py-1.5 pr-4 text-slate-600">{formatDate(file.updatedAt)}</td>
                          <td className="py-1.5">
                            <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setPreviewTarget(file)} type="button">Preview</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Memory</h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500"
              onChange={(event) => setMemoryQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleMemorySearch();
              }}
              placeholder="Search memory..."
              type="search"
              value={memoryQuery}
            />
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-50"
              disabled={memorySearching || !memoryQuery.trim()}
              onClick={() => { void handleMemorySearch(); }}
              type="button"
            >
              {memorySearching ? "Searching..." : "Search"}
            </button>
          </div>
          {memoryError ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{memoryError}</div> : null}
          {memoryResults.length > 0 ? (
            <>
              <p className="mt-3 text-xs text-slate-500">
                {memoryScopedToSpace ? "Results contributed to this space:" : "No matches contributed to this space — showing your other accessible memories:"}
              </p>
              <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                {memoryResults.map((memory) => (
                  <div className="rounded-lg border border-slate-200 p-2 text-sm" key={memory.id}>
                    {memory.key ? <div className="font-medium text-slate-900">{memory.key}</div> : null}
                    <div className="text-slate-700">{memory.content}</div>
                    {memory.tags.length > 0 ? <div className="mt-1 text-xs text-slate-500">Tags: {memory.tags.join(", ")}</div> : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {memoryItems.length > 0 ? (
            <p className="mt-3 text-xs text-slate-500">{memoryItems.length} memory item{memoryItems.length === 1 ? "" : "s"} shared into this space.</p>
          ) : null}
        </section>

        {space?.role === "creator" ? (
          <MemberManagementSection
            creatorId={space.creatorId}
            onChanged={() => { void refreshSpace(); }}
            spaceId={spaceId}
          />
        ) : null}
      </div>

      {previewTarget ? (
        <PreviewModal loadPreview={(fileId) => driveApi.previewFile(fileId)} onClose={() => setPreviewTarget(null)} target={previewTarget} />
      ) : null}
    </main>
  );
}
