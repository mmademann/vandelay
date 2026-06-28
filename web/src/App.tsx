import { useEffect } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
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
        <header className="flex shrink-0 items-baseline justify-between">
          <Link to="/" className="text-2xl font-semibold tracking-tight">
            vandelay
          </Link>
          <nav className="flex items-center gap-4 text-xs uppercase tracking-widest">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Single
            </NavLink>
            <NavLink
              to="/mix"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Mix
            </NavLink>
            <NavLink
              to="/stems"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Stems
            </NavLink>
            <NavLink
              to="/collab"
              className={({ isActive }) =>
                isActive ? "text-accent" : "text-foreground/50 hover:text-foreground/80"
              }
            >
              Collab
            </NavLink>
          </nav>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            <Route path="/" element={<SinglePage />} />
            <Route path="/mix" element={<MixPage />} />
            <Route path="/stems" element={<StemsPage />} />
            <Route path="/collab" element={<CollabPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
