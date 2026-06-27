import { Router } from "express";
import { existsSync, statSync, createReadStream } from "node:fs";
import { z } from "zod";
import { extractVideoId } from "../lib/youtube.js";
import { extractAudio } from "../lib/extract.js";
import { recordHistory } from "../lib/history.js";
import { separateStems, stemsReady, stemPath, STEM_NAMES, type StemName } from "../lib/stems.js";

const router = Router();

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const PostBody = z.object({ url: z.string().url() });

/** POST /api/stems — download + separate. Blocks until demucs finishes. */
router.post("/stems", async (req, res) => {
  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const id = extractVideoId(parsed.data.url);
  if (!id) return res.status(400).json({ error: "Could not extract YouTube video ID" });

  try {
    // Ensure source WAV exists (reuses cache if already downloaded)
    const info = await extractAudio(id);

    const cached = stemsReady(id);
    if (!cached) {
      await separateStems(id);
    }

    recordHistory({ id: info.id, title: info.title, duration: info.duration });
    res.json({ id, title: info.title, duration: info.duration, stems: STEM_NAMES, cached });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/** GET /api/stems/:id/status — check if stems are already separated (no processing) */
router.get("/stems/:id/status", (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  res.json({ ready: stemsReady(id) });
});

/** GET /api/stems/:id/:stem — stream a stem WAV */
router.get("/stems/:id/:stem", (req, res) => {
  const { id, stem } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  if (!(STEM_NAMES as readonly string[]).includes(stem)) {
    return res.status(400).json({ error: `Invalid stem. Must be one of: ${STEM_NAMES.join(", ")}` });
  }

  const path = stemPath(id, stem as StemName);
  if (!existsSync(path)) return res.status(404).json({ error: "Stem not found" });

  const stat = statSync(path);
  const range = req.headers.range;

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    return createReadStream(path).pipe(res);
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) {
    res.setHeader("Content-Length", stat.size);
    return createReadStream(path).pipe(res);
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  createReadStream(path, { start, end }).pipe(res);
});

export default router;
