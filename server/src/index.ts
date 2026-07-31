import express from "express";
import cors from "cors";
import audioRouter from "./routes/audio.js";
import stemsRouter from "./routes/stems.js";
import multiStateRouter from "./routes/multiState.js";
import { cleanupStems } from "./lib/stems.js";

const app = express();
const PORT = 5174;

app.use(cors());
app.use(express.json());

app.use("/api", audioRouter);
app.use("/api", stemsRouter);
app.use("/api", multiStateRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  cleanupStems();
});
