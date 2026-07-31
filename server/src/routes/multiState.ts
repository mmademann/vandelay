import { Router } from "express";
import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "../../..", "multi-state.json");

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
    await writeFile(STATE_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to write state" });
  }
});

export default router;
