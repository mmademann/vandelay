import { Router } from "express";
import { existsSync, statSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractVideoId } from "../lib/youtube.js";
import { extractAudio, CACHE_DIR } from "../lib/extract.js";
import { recordHistory, readHistory } from "../lib/history.js";
import { isValidTrackId } from "../lib/trackId.js";
import { separateStems, stemsReady, stemsMp3Ready, stemMp3Path, transcodeStems, STEMS_DIR, STEM_NAMES, type StemName } from "../lib/stems.js";

const router = Router();

// Either a YouTube URL to fetch, or the id of a track already on disk — which is what an
// upload is by the time it gets here.
const PostBody = z.object({ url: z.string().url().optional(), id: z.string().min(1).optional() })
  .refine((b) => b.url !== undefined || b.id !== undefined, { message: "url or id required" });

/** POST /api/stems — download WAV (blocking), then separate in background. Returns 202 immediately after download. */
router.post("/stems", async (req, res) => {
  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const id = parsed.data.id ?? (parsed.data.url ? extractVideoId(parsed.data.url) : null);
  if (!id) return res.status(400).json({ error: "Could not extract YouTube video ID" });
  // The id reaches this route straight from the request body, and below it is interpolated
  // into cache/<id>.wav and stems/htdemucs/<id>/. Every other id-taking route runs this
  // check; the upload path added `id` here and skipped it. CORS is wide open, so any page
  // the user visits can post an arbitrary one.
  if (!isValidTrackId(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    // Download WAV first — demucs needs it on disk before it can start. An uploaded track is
    // already there, and has no YouTube page to fetch metadata from, so take its title from
    // history instead of sending yt-dlp after an id that was never a video.
    const cached = join(CACHE_DIR, `${id}.wav`);
    const info = parsed.data.id && existsSync(cached)
      ? (() => {
          const known = readHistory().find((h) => h.id === id);
          return { id, title: known?.title ?? id, duration: known?.duration ?? 0, path: cached };
        })()
      : await extractAudio(id);

    // Already fully done — return 200 immediately
    if (stemsReady(id) && stemsMp3Ready(id)) {
      recordHistory({ id: info.id, title: info.title, duration: info.duration });
      return res.json({ id, title: info.title, duration: info.duration, stems: STEM_NAMES, cached: true });
    }

    // Fire-and-forget separation; browser polls GET /api/stems/:id/status for completion
    Promise.resolve()
      .then(() => stemsReady(id) ? Promise.resolve() : separateStems(id))
      // Record the title as soon as the stems exist — /stems/:id/status reports ready at this
      // point, so the client refetches the library now. Writing history after the slow mp3
      // transcode would make that refetch fall back to `titleMap.get(id) ?? id` (the raw id).
      .then(() => recordHistory({ id: info.id, title: info.title, duration: info.duration }))
      .then(() => stemsMp3Ready(id) ? Promise.resolve() : transcodeStems(id))
      .catch((e) => console.error(`[stems] background separation failed for ${id}:`, e instanceof Error ? e.message : e));

    return res.status(202).json({ id, title: info.title });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/** GET /api/stems/library — list all track IDs with separated stems, joined with history for titles */
router.get("/stems/library", (_req, res) => {
  const htdemucsDir = join(STEMS_DIR, "htdemucs");
  let ids: string[] = [];
  try {
    ids = readdirSync(htdemucsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // Directory doesn't exist yet — return empty list
  }

  const history = readHistory();
  const titleMap = new Map(history.map((e) => [e.id, e.title]));

  const results = ids.map((id) => ({ id, title: titleMap.get(id) ?? id }));
  res.setHeader("Cache-Control", "public, max-age=10");
  res.json(results);
});

/** GET /api/stems/:id/status — check if stems are already separated (no processing) */
router.get("/stems/:id/status", (req, res) => {
  const { id } = req.params;
  if (!isValidTrackId(id)) return res.status(400).json({ error: "Invalid id" });
  res.json({ ready: stemsReady(id) });
});

/** GET /api/stems/:id/:stem — stream a stem as MP3 (falls back to WAV if MP3 not ready) */
router.get("/stems/:id/:stem", (req, res) => {
  const { id, stem } = req.params;
  if (!isValidTrackId(id)) return res.status(400).json({ error: "Invalid id" });
  if (!(STEM_NAMES as readonly string[]).includes(stem)) {
    return res.status(400).json({ error: `Invalid stem. Must be one of: ${STEM_NAMES.join(", ")}` });
  }

  const mp3 = stemMp3Path(id, stem as StemName);
  const path = existsSync(mp3) ? mp3 : null;
  if (!path) return res.status(404).json({ error: "Stem not found" });

  const stat = statSync(path);
  const range = req.headers.range;

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

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
