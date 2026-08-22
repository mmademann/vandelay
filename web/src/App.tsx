import { useEffect } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { pruneCache } from "./lib/audioCache";
import { getAllTrackMeta } from "./lib/trackMetaCache";
import { SinglePage } from "./pages/SinglePage";
import { MixPage } from "./pages/MixPage";
import { StemsPage } from "./pages/StemsPage";
import { MultiPage } from "./pages/MultiPage";

/** Legacy `/multi` path — multi moved to `/`. Preserves `?slots=` so old links keep working. */
function LegacyMultiRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

export default function App() {
  useEffect(() => {
    getAllTrackMeta()
      .then((entries) => pruneCache(entries.map((e) => e.id)))
      .catch(() => undefined);
  }, []);

  return (
    <BrowserRouter>
      <div className="flex h-dvh w-full flex-col gap-4 overflow-hidden px-4 py-4 sm:px-6">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div id="multi-transport-portal" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" />
          <nav className="flex shrink-0 items-center gap-4 text-xs uppercase tracking-widest ml-auto">
            {/* Multi does everything Single/Mix/Stems do, including separation via
                SlotPicker. Routes stay live so existing links keep working. */}
            {/* <NavLink
              to="/single"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Single Track
            </NavLink> */}
            {/* <NavLink
              to="/mix"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Multi Track
            </NavLink> */}
            {/* <NavLink
              to="/stems"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Track Stems
            </NavLink> */}
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
              title="Studio"
              aria-label="Studio"
            >
              {/* Drawn rather than typed: every system face available here renders π
                  flat-topped, reading as ∏. currentColor keeps the active/hover states. */}
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                {/* Crossbar: heavier than the legs, with a slight downward wave and a small
                    serif overhang past each leg. Filled so the bar can outweigh the stems. */}
                <path
                  fill="currentColor"
                  d="M3.6 6.9c.6-.5 1.3-.8 2.2-.9 1.1-.1 2.4-.1 3.9-.1h6.6c1 0 1.8.1 2.4.3.5.2.8.5.8.9 0 .5-.4.8-1.1.8-.4 0-.9-.1-1.5-.2-.5-.1-1.1-.1-1.7-.1H9.6c-1.3 0-2.3 0-3 .1-.6.1-1.1.3-1.5.6-.3.2-.6.2-.8 0-.2-.2-.2-.4 0-.7z"
                />
                {/* Left stem: near-vertical, tapering slightly, with a short inward foot. */}
                <path
                  fill="currentColor"
                  d="M8.9 7.7c.7 0 1 .3.9.9-.2 2.6-.5 4.9-.9 7-.3 1.6-.7 2.8-1.3 3.6-.5.7-1.1 1-1.8.8-.5-.1-.7-.5-.6-1 .1-.4.5-.6 1-.5.3.1.6-.1.8-.5.3-.6.6-1.6.8-2.9.4-2.1.7-4.4.9-6.9 0-.4.1-.5.2-.5z"
                />
                {/* Right stem: straighter through the middle, then flares into the tail. */}
                <path
                  fill="currentColor"
                  d="M15.3 7.7c.7 0 1 .3.9 1-.2 2.7-.3 4.9-.1 6.7.1 1.4.4 2.3.9 2.7.4.4.9.4 1.4.1.5-.3.9-.2 1.1.2.2.4 0 .9-.5 1.2-1 .6-2 .5-2.9-.3-.9-.8-1.4-2.2-1.6-4.1-.2-1.9-.1-4.1.1-6.8.1-.5.4-.7.7-.7z"
                />
              </svg>
            </NavLink>
          </nav>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            <Route path="/" element={<MultiPage />} />
            <Route path="/single" element={<SinglePage />} />
            <Route path="/mix" element={<MixPage />} />
            <Route path="/stems" element={<StemsPage />} />
            <Route path="/multi" element={<LegacyMultiRedirect />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
