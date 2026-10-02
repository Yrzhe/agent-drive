import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { useAuth } from "@/hooks/useAuth";
import { useAccessStatus } from "@/hooks/useAccessStatus";
import { driveApi } from "@/lib/drive-api";
import { uploadBlob } from "@/lib/upload";
import { deploymentPlatform } from "@/lib/platform";
import { normalizePath } from "@/lib/path-utils";

export default function UploadPage() {
  const [query] = useSearchParams();
  const { user, loading: authLoading, isAuthenticated } = useAuth();
  const access = useAccessStatus();
  const [file, setFile] = useState<File | null>(null);
  const [destination, setDestination] = useState(query.get("path") ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploadedPath, setUploadedPath] = useState("");
  const wrongAccount = Boolean(query.get("account") && user?.id !== query.get("account"));
  const upload = async () => {
    if (!file || !isAuthenticated || access.status !== "active" || wrongAccount || busy) return;
    setBusy(true); setError(""); setProgress(0);
    try {
      const target = normalizePath(destination || `/${file.name}`);
      const lastSlash = target.lastIndexOf("/");
      const filename = target.slice(lastSlash + 1);
      const folder = target.slice(0, lastSlash) || "/";
      if (!filename) throw new Error("目标路径需要包含文件名。");
      const ticket = await driveApi.requestUpload({ filename, path: folder, contentType: file.type || "application/octet-stream", size: file.size });
      await uploadBlob(ticket, file, setProgress);
      const result = await driveApi.completeUpload(ticket.fileId, ticket.filename, ticket.path);
      setUploadedPath(result.file.path);
    } catch (e) { setError(e instanceof Error ? e.message : "上传失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <main className="min-h-screen bg-slate-50 px-6 py-12">
    <div className="mx-auto max-w-xl space-y-5 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
      <Link to="/drive" className="text-sm text-blue-700">← Agent Drive</Link>
      <h1 className="text-2xl font-semibold">上传大文件</h1>
      <p className="text-sm leading-6 text-slate-600">选择本地的程序、ZIP 或其他文件，网站会读取真实大小并自动分块上传。500 MB 文件使用同一流程。</p>
      <p className="text-sm text-slate-500">{deploymentPlatform === "sites" ? "应用默认单文件上限 625 GiB、总配额 1 TiB；实际可用容量取决于 Sites 配额。" : "文件大小与总配额由站点配置决定。"} MCP 的 5 MiB 文本消息上限不适用于此页面。</p>
      {authLoading || (isAuthenticated && access.loading) ? <p>正在检查账号…</p>
        : !isAuthenticated ? <AuthLoginPanel redirectTo={window.location.pathname + window.location.search} />
        : wrongAccount ? <p role="alert" className="text-red-700">请使用创建此上传链接的同一个账号登录。当前账号：{user?.email}。</p>
        : access.error ? <p role="alert" className="text-red-700">{access.error}</p>
        : access.status !== "active" ? <p role="alert">账号尚未获批或已暂停。<Link to="/waitlist" className="text-blue-700">查看账号状态</Link></p>
        : uploadedPath ? <div className="space-y-3"><p role="status">已上传：{uploadedPath}</p><p className="text-sm text-slate-600">返回 ChatGPT 后，可以让 Agent Drive 列出文件或创建分享链接。</p><Link to="/drive" className="text-blue-700">打开网盘</Link></div>
        : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void upload(); }}>
          <p className="text-sm text-slate-500">当前账号：{user?.email}</p>
          <label className="block space-y-2"><span className="text-sm font-medium">本地文件</span><input type="file" disabled={busy} className="block w-full text-sm" onChange={(event) => { const chosen = event.target.files?.[0] ?? null; setFile(chosen); if (chosen && !destination) setDestination(`/${chosen.name}`); }} /></label>
          {file && <p className="text-sm text-slate-500">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB</p>}
          <label className="block space-y-2"><span className="text-sm font-medium">保存路径</span><input value={destination} onChange={(event) => setDestination(event.target.value)} disabled={busy} placeholder="/program.zip" className="w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
          {busy && <div role="status"><progress max={100} value={progress} className="w-full" /><p className="text-sm text-slate-600">{progress >= 100 ? "文件已传输，正在确认保存…" : `上传中 ${Math.floor(progress)}%`}</p></div>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={!file || busy} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "上传中…" : "开始上传"}</button>
        </form>}
    </div>
  </main>;
}
