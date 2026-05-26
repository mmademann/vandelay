import { getTrackMeta } from "./trackMetaCache";

export interface TrackMeta {
  id: string;
  title: string;
  duration: number;
}

export async function resolveTrackFromUrl(url: string): Promise<TrackMeta> {
  const res = await fetch("/api/audio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to load" }));
    throw new Error(err.error ?? "Failed to load");
  }
  return (await res.json()) as TrackMeta;
}

export async function resolveTrackFromId(id: string): Promise<TrackMeta> {
  const cached = await getTrackMeta(id);
  if (cached) return { id: cached.id, title: cached.title, duration: cached.duration };

  const res = await fetch("/api/history");
  const history = (res.ok ? await res.json() : []) as TrackMeta[];
  const fromHistory = history.find((h) => h.id === id);
  if (fromHistory) return fromHistory;
  return resolveTrackFromUrl(`https://www.youtube.com/watch?v=${id}`);
}
