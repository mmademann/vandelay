import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  // The audio analysis worker dynamically imports Essentia's WASM bundle, which forces a
  // code-split. Vite's default worker format is IIFE, and IIFE cannot code-split — so a
  // production build failed while dev (unbundled) worked fine.
  worker: { format: "es" },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5174",
    },
  },
});
