import type { DriveFile } from "@/types/drive";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatDate(input: string): string {
  return new Date(input).toLocaleString();
}

export function FileTable({
  entries,
  loading,
  onOpenFolder,
  onRename,
  onShare,
  onDelete,
}: {
  entries: DriveFile[];
  loading: boolean;
  onOpenFolder: (entry: DriveFile) => void;
  onRename: (entry: DriveFile) => void;
  onShare: (entry: DriveFile) => void;
  onDelete: (entry: DriveFile) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-600">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Size</th>
            <th className="py-2 pr-4 font-medium">Updated</th>
            <th className="py-2 pr-4 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="py-4 text-slate-600" colSpan={5}>Loading files...</td>
            </tr>
          ) : entries.length === 0 ? (
            <tr>
              <td className="py-4 text-slate-500" colSpan={5}>This folder is empty.</td>
            </tr>
          ) : (
            entries.map((entry) => (
              <tr className="border-b border-slate-100" key={entry.id}>
                <td className="py-2 pr-4">
                  {entry.isFolder ? (
                    <button className="rounded px-2 py-1 font-medium text-blue-700 hover:bg-blue-50" onClick={() => onOpenFolder(entry)} type="button">
                      📁 {entry.name}
                    </button>
                  ) : (
                    <span className="text-slate-800">📄 {entry.name}</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-700">{entry.isFolder ? "Folder" : entry.contentType || "File"}</td>
                <td className="py-2 pr-4 text-slate-700">{entry.isFolder ? "-" : formatBytes(entry.size)}</td>
                <td className="py-2 pr-4 text-slate-600">{formatDate(entry.updatedAt)}</td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-2">
                    <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => onRename(entry)} type="button">Rename</button>
                    <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => onShare(entry)} type="button">Share</button>
                    <button className="rounded border border-red-300 px-2 py-1 text-xs text-red-700" onClick={() => onDelete(entry)} type="button">Delete</button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
