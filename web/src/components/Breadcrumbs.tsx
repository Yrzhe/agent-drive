import { useMemo } from "react";

type Item = { label: string; path: string };

export function Breadcrumbs({ currentPath, onNavigate }: { currentPath: string; onNavigate: (path: string) => void }) {
  const items = useMemo<Item[]>(() => {
    const segments = currentPath.split("/").filter(Boolean);
    const result: Item[] = [{ label: "Root", path: "/" }];
    let buffer = "";
    for (const segment of segments) {
      buffer = `${buffer}/${segment}`;
      result.push({ label: segment, path: buffer });
    }
    return result;
  }, [currentPath]);

  return (
    <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
      {items.map((item, index) => (
        <div className="flex items-center gap-2" key={item.path}>
          <button
            className={`rounded px-2 py-1 ${item.path === currentPath ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}
            onClick={() => onNavigate(item.path)}
            type="button"
          >
            {item.label}
          </button>
          {index < items.length - 1 ? <span className="text-slate-400">/</span> : null}
        </div>
      ))}
    </nav>
  );
}
