import { useEffect, useState } from "react";
import type { DriveFile } from "@/types/drive";

interface PreviewPayload {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  downloadUrl: string;
}

type RenderKind = "image" | "pdf" | "text" | "video" | "audio" | "other";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "cfg", "env",
  "log", "csv", "tsv", "xml", "html", "htm", "css", "scss", "sass",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "sh", "bash", "zsh", "fish",
  "sql", "graphql", "proto", "dockerfile",
]);

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function classify(payload: PreviewPayload): RenderKind {
  const type = (payload.contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("text/")) return "text";
  if (type === "application/json" || type === "application/xml" || type === "application/javascript") return "text";

  const ext = extensionOf(payload.name);
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export function PreviewModal({
  target,
  loadPreview,
  onClose,
}: {
  target: DriveFile;
  loadPreview: (fileId: string) => Promise<PreviewPayload>;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPayload(null);
    setTextBody(null);
    setTextTruncated(false);

    (async () => {
      try {
        const result = await loadPreview(target.id);
        if (cancelled) return;
        setPayload(result);
        const kind = classify(result);
        if (kind === "text") {
          if (result.size > TEXT_PREVIEW_MAX_BYTES) {
            setTextTruncated(true);
            setTextBody(null);
          } else {
            const response = await fetch(result.downloadUrl);
            if (!response.ok) throw new Error(`Failed to load preview (HTTP ${response.status})`);
            const body = await response.text();
            if (cancelled) return;
            setTextBody(body);
          }
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Preview failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target.id, loadPreview]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kind = payload ? classify(payload) : "other";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-slate-900">{target.name}</div>
            <div className="truncate text-xs text-slate-500">
              {target.path}
              {payload ? <> · {payload.contentType || "unknown"} · {formatBytes(payload.size)}</> : null}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {payload ? (
              <a
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                download={target.name}
                href={payload.downloadUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                Download
              </a>
            ) : null}
            <button
              aria-label="Close preview"
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto bg-slate-50">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-600">Loading preview…</div>
          ) : error ? (
            <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : !payload ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">No preview available</div>
          ) : kind === "image" ? (
            <div className="flex h-full items-center justify-center p-4">
              <img alt={target.name} className="max-h-full max-w-full object-contain" src={payload.downloadUrl} />
            </div>
          ) : kind === "pdf" ? (
            <iframe className="h-full w-full" src={payload.downloadUrl} title={target.name} />
          ) : kind === "video" ? (
            <div className="flex h-full items-center justify-center p-4">
              <video className="max-h-full max-w-full" controls src={payload.downloadUrl} />
            </div>
          ) : kind === "audio" ? (
            <div className="flex h-full items-center justify-center p-4">
              <audio controls src={payload.downloadUrl} />
            </div>
          ) : kind === "text" ? (
            textTruncated ? (
              <div className="m-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                File is larger than {formatBytes(TEXT_PREVIEW_MAX_BYTES)}. Preview skipped — use Download to fetch.
              </div>
            ) : (
              <pre className="m-0 h-full overflow-auto whitespace-pre-wrap break-words bg-white p-4 font-mono text-xs leading-relaxed text-slate-800">
                {textBody}
              </pre>
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm text-slate-600">
              <div>No inline preview for this file type.</div>
              <a
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                download={target.name}
                href={payload.downloadUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                Download {target.name}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
