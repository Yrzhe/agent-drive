import type { OAuthScopeDescription } from "@/lib/oauth-scopes";

export function ConsentScopeList({ scopes }: { scopes: OAuthScopeDescription[] }) {
  if (scopes.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        This client did not request any OAuth scopes.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {scopes.map((scope) => (
        <li className="rounded-lg border border-slate-200 bg-white px-3 py-2" key={scope.scope}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium text-slate-900">{scope.title}</div>
            <code className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{scope.scope}</code>
          </div>
          <p className="mt-1 text-sm text-slate-600">{scope.description}</p>
        </li>
      ))}
    </ul>
  );
}
