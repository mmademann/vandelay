import { openDB, HISTORY_STORE } from "./audioCache";

export interface CachedTrackMeta {
  id: string;
  title: string;
  duration: number;
  addedAt: number;
}

export async function putTrackMeta(meta: CachedTrackMeta): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HISTORY_STORE, "readwrite");
      tx.objectStore(HISTORY_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* quota or disabled — fall through */
  }
}

export async function getAllTrackMeta(): Promise<CachedTrackMeta[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(HISTORY_STORE, "readonly");
      const req = tx.objectStore(HISTORY_STORE).getAll();
      req.onsuccess = () => {
        const entries = (req.result as CachedTrackMeta[]).sort((a, b) => b.addedAt - a.addedAt);
        resolve(entries);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function getTrackMeta(id: string): Promise<CachedTrackMeta | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(HISTORY_STORE, "readonly");
      const req = tx.objectStore(HISTORY_STORE).get(id);
      req.onsuccess = () => resolve((req.result as CachedTrackMeta | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteTrackMeta(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HISTORY_STORE, "readwrite");
      tx.objectStore(HISTORY_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
