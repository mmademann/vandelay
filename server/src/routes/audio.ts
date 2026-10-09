import { Router } from "express";
import { existsSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractVideoId } from "../lib/youtube.js";
import { extractAudio, ingestUpload, CACHE_DIR } from "../lib/extract.js";
import { readHistory, recordHistory, removeHistory } from "../lib/history.js";
import { isValidTrackId } from "../lib/trackId.js";

const router = Router();

const LoadBody = z.object({ url: z.string().url() });

/**
 * POST /api/upload — a local file, ingested exactly like a YouTube track.
 *
 * Raw body rather than multipart: there is one file and no fields, so a parser dependency
 * would earn nothing. The filename rides in a header because the body is the file.
 */
router.post("/upload", async (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ error: "Empty upload" });
  }
  const raw = req.header("x-filename") ?? "upload";
  let filename = raw;
  try { filename = decodeURIComponent(raw); } catch { /* header was not encoded */ }
  try {
    const info = await ingestUpload(body, filename);
    recordHistory({ id: info.id, title: info.title, duration: info.duration });
    res.json({ id: info.id, title: info.title, duration: info.duration });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Upload failed" });
  }
});

router.post("/audio", async (req, res) => {
  const parsed = LoadBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body" });
  }
  const id = extractVideoId(parsed.data.url);
  if (!id) {
    return res.status(400).json({ error: "Could not extract YouTube video ID from URL" });
  }
  try {
    const info = await extractAudio(id);
    recordHistory({ id: info.id, title: info.title, duration: info.duration });
    res.json({ id: info.id, title: info.title, duration: info.duration });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.get("/history", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=10");
  res.json(readHistory());
});

router.delete("/history/:id", (req, res) => {
  if (!isValidTrackId(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  res.json(removeHistory(req.params.id));
});

router.get("/audio/:id", (req, res) => {
  const id = req.params.id;
  if (!isValidTrackId(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const path = join(CACHE_DIR, `${id}.wav`);
  if (!existsSync(path)) return res.status(404).json({ error: "Not found" });

  const stat = statSync(path);
  const range = req.headers.range;

  res.setHeader("Content-Type", "audio/wav");
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
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", chunkSize);
  createReadStream(path, { start, end }).pipe(res);
});

export default router;
