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
            >
              Studio
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
