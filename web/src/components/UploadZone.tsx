import { useState } from "react";

interface UploadProgress {
  filename: string;
  percent: number;
}

interface UploadZoneProps {
  uploading: boolean;
  progress: UploadProgress | null;
  onFilesSelected: (files: File[]) => void;
  onFolderSelected: (files: File[]) => void;
}

export type { UploadProgress };

export function UploadZone({ uploading, progress, onFilesSelected, onFolderSelected }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`mb-4 rounded-xl border-2 border-dashed p-6 text-center transition ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50"}`}
      onDragEnter={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const items = Array.from(event.dataTransfer.items);
        const fileEntries = items
          .map((item) => item.webkitGetAsEntry?.())
          .filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined);
        const hasFolder = fileEntries.some((entry) => entry.isDirectory);
        if (hasFolder) {
          void collectFilesFromEntries(fileEntries)
            .then(onFolderSelected)
            .catch((error) => {
              console.error("Failed to read dropped folder entries", error);
            });
        } else {
          onFilesSelected(Array.from(event.dataTransfer.files));
        }
      }}
    >
      <p className="text-sm text-slate-700">Drag files or folders here to upload</p>
      {uploading && progress ? (
        <div className="mt-3 mx-auto max-w-xs">
          <p className="text-xs text-blue-600 mb-1">Uploading: {progress.filename}</p>
          <div className="w-full bg-slate-200 rounded-full h-2">
            <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-1">{progress.percent}%</p>
        </div>
      ) : uploading ? (
        <p className="mt-2 text-xs text-blue-600">Preparing upload...</p>
      ) : null}
    </div>
  );
}

async function collectFilesFromEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const result: File[] = [];
  async function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    const all: FileSystemEntry[] = [];
    // readEntries returns batches; keep reading until empty to avoid truncation.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  }

  async function readEntry(entry: FileSystemEntry, path: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      const fileWithPath = new File([file], file.name, { type: file.type });
      Object.defineProperty(fileWithPath, "webkitRelativePath", { value: path + file.name, writable: false });
      result.push(fileWithPath);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await readDirectoryEntries(reader);
      for (const child of children) {
        await readEntry(child, `${path}${entry.name}/`);
      }
    }
  }

  for (const entry of entries) {
    await readEntry(entry, "");
  }
  return result;
}
