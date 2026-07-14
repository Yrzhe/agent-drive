import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { useAuth } from "@/hooks/useAuth";
import { driveApi } from "@/lib/drive-api";
import { normalizePath } from "@/lib/path-utils";
import type { DriveFile } from "@/types/drive";

type ManifestFile = {
  path?: string;
  size?: number;
  hash?: string;
};

type BundleManifest = {
  machineId?: string;
  pushedAt?: string;
  hash?: string;
  fileCount?: number;
  totalSize?: number;
  files?: ManifestFile[];
  [key: string]: unknown;
};

type BundleRow = {
  path: string;
  name: string;
  manifestPath: string;
  manifest?: BundleManifest;
  manifestError?: string;
  files: ManifestFile[];
};

type LoadState =
  | { kind: "idle" | "loading" }
  | { kind: "loaded"; bundles: BundleRow[] }
  | { kind: "error"; message: string };

const CLI_GUIDE_URL = "https://github.com/Yrzhe/agent-drive/tree/main/cli";
const PAGE_SIZE = 500;

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function formatDate(input?: string): string {
  if (!input) return "-";
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? input : date.toLocaleString();
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function shortHash(hash?: string): string {
  if (!hash) return "-";
  return hash.length > 8 ? `${hash.slice(0, 6)}..` : hash;
}

function fileListForBundle(bundlePath: string, manifest: BundleManifest | undefined, allFiles: DriveFile[]): ManifestFile[] {
  if (manifest?.files && Array.isArray(manifest.files)) {
    return manifest.files.filter((file): file is ManifestFile => typeof file === "object" && file !== null);
  }

  return allFiles
    .filter((file) => !file.isFolder && file.path.startsWith(`${bundlePath === "/" ? "" : bundlePath}/`) && file.name !== "manifest.json")
    .map((file) => ({ path: file.path, size: file.size }));
}

function validateManifest(input: unknown): BundleManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("manifest.json must contain a JSON object.");
  }
  return input as BundleManifest;
}

async function listAllFiles(): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await driveApi.listFiles("/", { recursive: true, limit: PAGE_SIZE, offset });
    files.push(...result.files);
    if (result.files.length < PAGE_SIZE) break;
  }
  return files;
}

async function loadBundles(): Promise<BundleRow[]> {
  const allFiles = await listAllFiles();
  const manifestFiles = allFiles.filter((file) => !file.isFolder && file.name === "manifest.json");
  const rows = await Promise.all(manifestFiles.map(async (file): Promise<BundleRow | null> => {
    const bundlePath = parentPath(file.path);
    try {
      const current = await driveApi.getBundleCurrent(bundlePath);
      if (!current.currentVersion) return null;
      const result = await driveApi.getBundleManifest(bundlePath, current.currentVersion.versionId);
      const manifest = validateManifest(result.manifest);
      return {
        path: bundlePath,
        name: bundlePath,
        manifestPath: file.path,
        manifest,
        files: fileListForBundle(bundlePath, manifest, allFiles),
      };
    } catch (error) {
      return {
        path: bundlePath,
        name: bundlePath,
        manifestPath: file.path,
        manifestError: error instanceof Error ? error.message : "Could not read manifest.json.",
        files: fileListForBundle(bundlePath, undefined, allFiles),
      };
    }
  }));

  return rows.filter((row): row is BundleRow => row !== null).sort((a, b) => {
    const aTime = a.manifest?.pushedAt ? new Date(a.manifest.pushedAt).getTime() : 0;
    const bTime = b.manifest?.pushedAt ? new Date(b.manifest.pushedAt).getTime() : 0;
    return bTime - aTime || a.path.localeCompare(b.path);
  });
}

function dashboardPathLink(bundlePath: string, filePath?: string): string {
  if (!filePath) return "/";
  const fullPath = filePath.startsWith("/") ? normalizePath(filePath) : normalizePath(`${bundlePath}/${filePath}`);
  return `/?${new URLSearchParams({ path: parentPath(fullPath) }).toString()}`;
}

function BundleDetails({ bundle }: { bundle: BundleRow }) {
  const manifest = bundle.manifest;
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      {bundle.manifestError ? <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{bundle.manifestError}</div> : null}
      <div className="grid gap-3 text-sm md:grid-cols-5">
        <div><div className="text-xs uppercase tracking-wide text-slate-500">Machine</div><div className="font-medium text-slate-900">{manifest?.machineId ?? "-"}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-slate-500">Pushed at</div><div className="font-medium text-slate-900">{formatDate(manifest?.pushedAt)}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-slate-500">Hash</div><div className="font-medium text-slate-900">{manifest?.hash ?? "-"}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-slate-500">Files</div><div className="font-medium text-slate-900">{manifest?.fileCount ?? bundle.files.length}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-slate-500">Size</div><div className="font-medium text-slate-900">{formatBytes(manifest?.totalSize)}</div></div>
      </div>

      {manifest ? (
        <pre className="mt-4 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100"><code>{JSON.stringify(manifest, null, 2)}</code></pre>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th className="py-2 pr-4 font-medium">Path</th>
              <th className="py-2 pr-4 font-medium">Size</th>
              <th className="py-2 pr-4 font-medium">Hash</th>
              <th className="py-2 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {bundle.files.length === 0 ? (
              <tr><td className="py-3 text-slate-500" colSpan={4}>No files listed in this bundle.</td></tr>
            ) : bundle.files.map((file, index) => (
              <tr className="border-b border-slate-100" key={`${bundle.path}-${file.path ?? index}`}>
                <td className="py-2 pr-4 font-mono text-xs text-slate-800">{file.path ?? "-"}</td>
                <td className="py-2 pr-4 text-slate-700">{formatBytes(file.size)}</td>
                <td className="py-2 pr-4 font-mono text-xs text-slate-600">{file.hash ?? "-"}</td>
                <td className="py-2 pr-4 text-right">{file.path ? <Link className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-white" to={dashboardPathLink(bundle.path, file.path)}>view</Link> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BundlesPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setState({ kind: "loading" });
    void loadBundles().then((bundles) => {
      if (cancelled) return;
      setState({ kind: "loaded", bundles });
    }).catch((error) => {
      if (cancelled) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load synced bundles." });
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const bundles = useMemo(() => state.kind === "loaded" ? state.bundles : [], [state]);

  if (authLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div></main>;
  if (!isAuthenticated) return <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16"><AuthLoginPanel redirectTo="/bundles" /></main>;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Synced bundles</h1>
            <p className="text-sm text-slate-600">Read-only status for bundles pushed by the adrive CLI. Current user: {user?.email ?? user?.name ?? "Unknown"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-white" to="/drive">Dashboard</Link>
            <Link className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700" to="/connect">Connect AI Agent</Link>
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">Sign out</button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          {state.kind === "loading" || state.kind === "idle" ? (
            <p className="text-sm text-slate-600">Scanning drive for synced bundle manifests...</p>
          ) : state.kind === "error" ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</div>
          ) : bundles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              <p className="font-medium text-slate-900">No synced bundles yet. Use the adrive CLI to push your first one.</p>
              <p className="mt-2">See <a className="font-medium text-blue-700 underline underline-offset-2" href={CLI_GUIDE_URL} rel="noreferrer" target="_blank">setup guide</a> →</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-600">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Pushed from</th>
                    <th className="py-2 pr-4 font-medium">Pushed at</th>
                    <th className="py-2 pr-4 font-medium">Files</th>
                    <th className="py-2 pr-4 font-medium">Size</th>
                    <th className="py-2 pr-4 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {bundles.map((bundle) => {
                    const expanded = expandedPath === bundle.path;
                    return (
                      <Fragment key={bundle.path}>
                        <tr className="border-b border-slate-100 align-top">
                          <td className="py-3 pr-4 font-medium text-slate-900">{bundle.name}</td>
                          <td className="py-3 pr-4 text-slate-700">{bundle.manifest?.machineId ?? "-"} · {shortHash(bundle.manifest?.hash)}</td>
                          <td className="py-3 pr-4 text-slate-700">{formatDate(bundle.manifest?.pushedAt)}</td>
                          <td className="py-3 pr-4 text-slate-700">{bundle.manifest?.fileCount ?? bundle.files.length}</td>
                          <td className="py-3 pr-4 text-slate-700">{formatBytes(bundle.manifest?.totalSize)}</td>
                          <td className="py-3 pr-4 text-right">
                            <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => setExpandedPath(expanded ? null : bundle.path)} type="button">view</button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="border-b border-slate-100">
                            <td className="pb-4" colSpan={6}><BundleDetails bundle={bundle} /></td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
