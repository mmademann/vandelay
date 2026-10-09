/**
 * Which track ids the server will accept in a path.
 *
 * These ids become filesystem paths (`cache/<id>.wav`, `stems/htdemucs/<id>/`), so this stays
 * a strict allowlist rather than a sanitiser. Two shapes are legal: a YouTube video id, and
 * an uploaded file's content hash from `ingestUpload`.
 */
const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;
const UPLOAD_ID = /^up-[0-9a-f]{12}$/;

export function isValidTrackId(id: string): boolean {
  return YOUTUBE_ID.test(id) || UPLOAD_ID.test(id);
}
