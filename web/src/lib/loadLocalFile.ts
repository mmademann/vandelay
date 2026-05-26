import { putCachedAudio } from "./audioCache";
import { putTrackMeta } from "./trackMetaCache";
import type { TrackMeta } from "./trackApi";

async function fileId(file: File): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(file.name + file.size);
	const hashBuffer = await crypto.subtle.digest("SHA-1", data);
	const bytes = new Uint8Array(hashBuffer);
	const b64 = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return b64.slice(0, 16);
}

export async function loadLocalFileMeta(file: File): Promise<TrackMeta> {
	const arrayBuffer = await file.arrayBuffer();
	const ctx = new AudioContext();
	const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
	await ctx.close();

	const id = await fileId(file);
	const title = file.name.replace(/\.[^.]+$/, "");
	const duration = decoded.duration;

	await putCachedAudio(id, arrayBuffer);
	await putTrackMeta({ id, title, duration, addedAt: Date.now() });

	return { id, title, duration };
}
