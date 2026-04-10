import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { driveApi } from "@/lib/drive-api";
import type { GuideData } from "@/types/drive";

export default function GuidePage() {
  const [guide, setGuide] = useState<GuideData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const data = await driveApi.getGuide();
        if (!canceled) setGuide(data);
      } catch (error) {
        if (!canceled) setErrorMessage(error instanceof Error ? error.message : "Failed to load guide");
      } finally {
        if (!canceled) setLoading(false);
      }
    };
    void load();
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-900">Agent Drive Guide</h1>
          <Link className="text-sm text-slate-600 hover:text-slate-900" to="/">Dashboard</Link>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          {loading ? <p className="text-sm text-slate-600">Loading guide...</p> : null}
          {errorMessage ? <p className="text-sm text-red-700">{errorMessage}</p> : null}

          {!loading && !errorMessage && guide ? (
            <article className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold text-slate-900">{guide.title}</h2>
                <p className="mt-2 text-slate-700">{guide.intro}</p>
              </div>
              <div className="space-y-4">
                {guide.sections.map((section) => (
                  <section className="rounded-xl border border-slate-200 p-4" key={section.title}>
                    <h3 className="text-base font-semibold text-slate-900">{section.title}</h3>
                    <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{section.content}</p>
                  </section>
                ))}
              </div>
            </article>
          ) : null}
        </section>
      </div>
    </main>
  );
}
