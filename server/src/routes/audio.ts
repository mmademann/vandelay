import { Router } from "express";
import { existsSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractVideoId } from "../lib/youtube.js";
import { extractAudio, CACHE_DIR } from "../lib/extract.js";
import { readHistory, recordHistory, removeHistory } from "../lib/history.js";

const router = Router();

const LoadBody = z.object({ url: z.string().url() });

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
  res.json(readHistory());
});

router.delete("/history/:id", (req, res) => {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  res.json(removeHistory(req.params.id));
});

router.get("/audio/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const path = join(CACHE_DIR, `${id}.wav`);
  if (!existsSync(path)) return res.status(404).json({ error: "Not found" });

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
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", chunkSize);
  createReadStream(path, { start, end }).pipe(res);
});

export default router;
