import express from "express";
import cors from "cors";
import audioRouter from "./routes/audio.js";

const app = express();
const PORT = 5174;

app.use(cors());
app.use(express.json());

app.use("/api", audioRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
