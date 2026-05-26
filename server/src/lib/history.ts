import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, "..", "..", "history.json");
const MAX_ENTRIES = 50;

export interface HistoryEntry {
  id: string;
  title: string;
  duration: number;
  addedAt: number;
}

export function readHistory(): HistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordHistory(entry: Omit<HistoryEntry, "addedAt">): HistoryEntry[] {
  const current = readHistory().filter((e) => e.id !== entry.id);
  const next: HistoryEntry[] = [{ ...entry, addedAt: Date.now() }, ...current].slice(0, MAX_ENTRIES);
  writeFileSync(HISTORY_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function removeHistory(id: string): HistoryEntry[] {
  const next = readHistory().filter((e) => e.id !== id);
  writeFileSync(HISTORY_PATH, JSON.stringify(next, null, 2));
  return next;
}
