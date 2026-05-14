import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const ShareDownloadPage = lazy(() => import("@/pages/ShareDownloadPage"));
const GuidePage = lazy(() => import("@/pages/GuidePage"));
const ConnectAuthorizePage = lazy(() => import("@/pages/ConnectAuthorizePage"));
const ConnectSetupPage = lazy(() => import("@/pages/ConnectSetupPage"));
const BundlesPage = lazy(() => import("@/pages/BundlesPage"));
const TrashPage = lazy(() => import("@/pages/TrashPage"));

function RouteFallback() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-3xl rounded-xl border border-slate-200 bg-white p-6 text-slate-600">Loading page...</div>
    </main>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<DashboardPage />} path="/" />
          <Route element={<ShareDownloadPage />} path="/s/:shareId" />
          <Route element={<GuidePage />} path="/guide" />
          <Route element={<ConnectSetupPage />} path="/connect" />
          <Route element={<ConnectAuthorizePage />} path="/connect/authorize" />
          <Route element={<BundlesPage />} path="/bundles" />
          <Route element={<TrashPage />} path="/trash" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
