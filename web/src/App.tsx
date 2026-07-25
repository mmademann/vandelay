import { useEffect } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { pruneCache } from "./lib/audioCache";
import { getAllTrackMeta } from "./lib/trackMetaCache";
import { SinglePage } from "./pages/SinglePage";
import { MixPage } from "./pages/MixPage";
import { StemsPage } from "./pages/StemsPage";
import { CollabPage } from "./pages/CollabPage";

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
          <div id="collab-transport-portal" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" />
          <nav className="flex shrink-0 items-center gap-4 text-xs uppercase tracking-widest ml-auto">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Single Track
            </NavLink>
            {/* <NavLink
              to="/mix"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Multi Track
            </NavLink> */}
            <NavLink
              to="/stems"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Track Stems
            </NavLink>
            <NavLink
              to="/multi"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Multi Track Stems
            </NavLink>
          </nav>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            <Route path="/" element={<SinglePage />} />
            <Route path="/mix" element={<MixPage />} />
            <Route path="/stems" element={<StemsPage />} />
            <Route path="/multi" element={<CollabPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
