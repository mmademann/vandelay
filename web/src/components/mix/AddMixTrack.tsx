import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMixStore } from "../../mixStore";
import { resolveTrackFromUrl } from "../../lib/trackApi";
import { loadLocalFileMeta } from "../../lib/loadLocalFile";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";

export function AddMixTrack() {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const status = useMixStore((s) => s.status);
  const error = useMixStore((s) => s.error);
  const setStatus = useMixStore((s) => s.setStatus);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function urlWith(extraId: string): string {
    const ids = (searchParams.get("v") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.includes(extraId)) ids.push(extraId);
    return `/mix?v=${ids.join(",")}`;
  }

  async function handleLoad() {
    if (!url.trim() || resolving) return;
    setResolving(true);
    setStatus("loading");
    try {
      const meta = await resolveTrackFromUrl(url);
      navigate(urlWith(meta.id));
      setUrl("");
    } catch (e) {
      setStatus("error", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setResolving(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setResolving(true);
    setStatus("loading");
    try {
      const meta = await loadLocalFileMeta(file);
      navigate(urlWith(meta.id));
    } catch (err) {
      setStatus("error", err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setResolving(false);
    }
  }

  const busy = resolving || status === "loading";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-accent"
          placeholder="Paste a YouTube URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLoad()}
        />
        <Button onClick={handleLoad} disabled={busy}>
          {busy ? <Spinner /> : "Add track"}
        </Button>
        <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          Upload file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}
