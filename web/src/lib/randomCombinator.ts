import type { StemName } from "../audio/dubEngine";

const STEM_ROLES: StemName[] = ["drums", "bass", "vocals", "other"];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildRandomSlots(
  library: { id: string; title: string }[],
  viabilityMap: Map<string, boolean> = new Map(),
): { trackId: string; stemName: StemName }[] | null {
  if (library.length < 2) return null;
  const shuffledTracks = shuffle(library);
  const shuffledRoles = shuffle(STEM_ROLES);
  const count = Math.min(shuffledTracks.length, shuffledRoles.length);
  const slots: { trackId: string; stemName: StemName }[] = [];
  let roleIdx = 0;
  for (const track of shuffledTracks) {
    if (slots.length >= count) break;
    if (roleIdx >= shuffledRoles.length) break;
    const role = shuffledRoles[roleIdx];
    const key = `${track.id}:${role}`;
    // Skip only if explicitly marked non-viable; uncached stems are included
    if (viabilityMap.get(key) === false) continue;
    slots.push({ trackId: track.id, stemName: role });
    roleIdx++;
  }
  return slots.length < 2 ? null : slots;
}
