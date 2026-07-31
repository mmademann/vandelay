import { Router } from "express";
import { readFile, writeFile, readdir, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const STATE_PATH = join(REPO_ROOT, "multi-state.json");
/** Timestamped snapshots live here so an overwrite of multi-state.json is always recoverable. */
const HISTORY_DIR = join(REPO_ROOT, "multi-state-history");
const KEEP_SNAPSHOTS = 20;
const SNAPSHOT_RE = /^multi-state-.*\.json$/;

/** Write a timestamped copy and prune to the newest KEEP_SNAPSHOTS. Never throws — backup must still succeed. */
async function archiveSnapshot(json: string): Promise<void> {
  try {
    await mkdir(HISTORY_DIR, { recursive: true });
    // Filename-safe ISO: 2026-07-31T10-30-00-000Z
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(HISTORY_DIR, `multi-state-${stamp}.json`), json);

    const files = (await readdir(HISTORY_DIR)).filter((f) => SNAPSHOT_RE.test(f)).sort();
    // Lexical sort on ISO stamps == chronological, so the oldest are at the front.
    await Promise.all(
      files.slice(0, Math.max(0, files.length - KEEP_SNAPSHOTS)).map((f) => unlink(join(HISTORY_DIR, f))),
    );
  } catch (e) {
    console.warn("[multi-state] snapshot archive failed:", e);
  }
}

const router = Router();

router.get("/multi-state", async (_req, res) => {
  try {
    const data = await readFile(STATE_PATH, "utf-8");
    res.json(JSON.parse(data));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "No saved state" });
    } else {
      res.status(500).json({ error: "Failed to read state" });
    }
  }
});

router.post("/multi-state", async (req, res) => {
  const body = req.body;
  if (body?.version !== 1 || !body.namedSessions || !body.slotSettings || !body.presets || !body.masterSettings) {
    res.status(400).json({ error: "Invalid export structure" });
    return;
  }
  try {
    // Archive the version we're about to clobber, not the incoming one — that's the copy you'd want back.
    const previous = await readFile(STATE_PATH, "utf-8").catch(() => null);
    if (previous) await archiveSnapshot(previous);

    await writeFile(STATE_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to write state" });
  }
});

/** GET /api/multi-state/history — list archived snapshots, newest first */
router.get("/multi-state/history", async (_req, res) => {
  try {
    const files = (await readdir(HISTORY_DIR).catch(() => []))
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort()
      .reverse();
    res.json(files.map((file) => ({ file, savedAt: file.slice("multi-state-".length, -".json".length) })));
  } catch {
    res.status(500).json({ error: "Failed to list history" });
  }
});

/** GET /api/multi-state/history/:file — read one snapshot back */
router.get("/multi-state/history/:file", async (req, res) => {
  const { file } = req.params;
  // Reject anything that isn't a literal snapshot name — blocks path traversal.
  if (!SNAPSHOT_RE.test(file)) {
    res.status(400).json({ error: "Invalid snapshot name" });
    return;
  }
  try {
    res.json(JSON.parse(await readFile(join(HISTORY_DIR, file), "utf-8")));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "Snapshot not found" });
    } else {
      res.status(500).json({ error: "Failed to read snapshot" });
    }
  }
});

export default router;
