/**
 * Surface coverage — the checklist, enforced against the source.
 *
 * CLAUDE.md documents which surfaces a slot property has to reach. Documentation drifts;
 * this does not. Every rule below reads the actual source files and fails when a property
 * is missing from a surface that must carry it.
 *
 * The recurring bug in this codebase is not bad arithmetic — it is a property that works
 * where it was written and is silently absent everywhere else. That is exactly what this
 * catches, and it catches it without anyone having to listen for a millisecond error.
 *
 * Run: node src/lib/__tests__/surfaceCoverage.test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(SRC, p), "utf8");

let fails = 0, checks = 0;
const ok = (n, c, d = "") => {
  checks++;
  if (!c) { fails++; console.log(`  FAIL ${n}${d ? "\n        " + d : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

const multiPage = read("pages/MultiPage.tsx");
const slotStrip = read("components/multi/SlotStrip.tsx");
const settings  = read("lib/multiSettings.ts");
const engine    = read("audio/multiEngine.ts");
const knob      = read("components/multi/Knob.tsx");
const picker    = read("components/multi/SlotPicker.tsx");
const render    = read("audio/renderMulti.ts");
const loopSnap  = read("lib/loopSnap.ts");
const reverbSlot = read("audio/reverbSlot.ts");
const multiChain = read("audio/multiChain.ts");
const SERVER = resolve(SRC, "../../server/src");
const readServer = (p) => readFileSync(resolve(SERVER, p), "utf8");
const stemsRoute = readServer("routes/stems.ts");
const audioRoute = readServer("routes/audio.ts");
const trackId = readServer("lib/trackId.ts");
const extract = readServer("lib/extract.ts");
const transport = read("components/multi/MultiTransport.tsx");

/** Body of a balanced call, e.g. every `saveSlotSettings(...)`. */
function callBodies(src, fnName) {
  const out = [];
  const re = new RegExp(`${fnName}\\(`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length, depth = 1;
    while (depth > 0 && i < src.length) {
      const c = src[i];
      if ("({[".includes(c)) depth++;
      else if (")}]".includes(c)) depth--;
      i++;
    }
    out.push({ body: src.slice(m.index, i), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Body of a named function/method declaration. */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  if (i === -1) return null;
  let j = src.indexOf("{", i), depth = 0, k = j;
  do {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") depth--;
    k++;
  } while (depth > 0 && k < src.length);
  return src.slice(i, k);
}

// Every persisted slot property, and which surfaces must carry it.
// `skip` documents a deliberate exemption — an empty reason is not allowed.
const PROPERTIES = [
  { name: "speed",             session: true, saved: true, engine: true,  render: true },
  { name: "pitch",             session: true, saved: true, engine: true,  render: true },
  { name: "linkPitch",         session: true, saved: true, engine: true,  render: true },
  { name: "gain",              session: true, saved: true, engine: true,  render: true },
  { name: "muted",             session: true, saved: true, engine: true,  render: true },
  { name: "soloed",            session: true, saved: true, engine: true,  render: true },
  { name: "effects",           session: true, saved: true, engine: true,  render: true },
  { name: "loopStart",         session: true, saved: "loopStartFrac", engine: true, render: true },
  { name: "loopEnd",           session: true, saved: "loopEndFrac",   engine: true, render: true },
  { name: "stretch",           session: true, saved: true, engine: false,
    skip: { engine: "stretch is baked into the buffer by swapBuffer, not a slot field" },
    render: false,
    skipRender: "export receives the already-stretched buffer" },
  // Both exemptions here used to read "expressed through loop bounds" / "baked into the
  // exported loop bounds". That was true while phase moved the loop. It stopped being true
  // when phase became a pure playhead offset, and because nothing re-checked the *reason*,
  // the suite stayed green while every export silently rendered on the downbeat.
  { name: "phase",             session: true, saved: true, engine: true,  render: true },
  { name: "tempoRelation",     session: true, saved: true, engine: false,
    skip: { engine: "selects the stretch ratio; the engine only ever sees the resulting buffer" },
    render: false,
    skipRender: "export receives the already-stretched buffer, same as stretch" },
  { name: "bypassMasterSpeed", session: true, saved: true, engine: true, render: true },
  { name: "pitchInterval",     session: true, saved: true, engine: false,
    skip: { engine: "UI step size only" }, render: false, skipRender: "UI only" },
  { name: "isMatched",         session: true, saved: true, engine: false,
    skip: { engine: "badge state" }, render: false, skipRender: "badge state" },
  { name: "matchedBasePitch",  session: true, saved: true, engine: false,
    skip: { engine: "badge state" }, render: false, skipRender: "badge state" },
];

console.log("Surface coverage — the checklist, enforced against the source");

section("1. every persisted property is in the session snapshot");
{
  const builder = fnBody(multiPage, "function buildSessionSlots()");
  ok("buildSessionSlots() exists", builder !== null);
  const slotIface = settings.match(/export interface MultiSlot \{([\s\S]*?)\n\}/)[1];
  for (const p of PROPERTIES.filter((x) => x.session)) {
    // Either named explicitly in the builder, or carried by the `...e.slot` spread.
    const viaSpread = new RegExp(`\\b${p.name}\\??:`).test(slotIface) && /\.\.\.e\.slot/.test(builder);
    const explicit = new RegExp(`\\b${p.name}\\b`).test(builder);
    ok(`session carries "${p.name}"`, viaSpread || explicit,
       `not in buildSessionSlots() and not on MultiSlot`);
  }
}

section("2. every persisted property is in MultiSlotSavedSettings (refresh)");
{
  const iface = settings.match(/export interface MultiSlotSavedSettings \{([\s\S]*?)\n\}/)[1];
  for (const p of PROPERTIES.filter((x) => x.saved)) {
    const key = typeof p.saved === "string" ? p.saved : p.name;
    ok(`saved settings declare "${key}"`, new RegExp(`\\b${key}\\??:`).test(iface));
  }
}

section("3. EVERY saveSlotSettings call site writes EVERY saved property");
{
  const sites = [...callBodies(multiPage, "saveSlotSettings"), ...callBodies(slotStrip, "saveSlotSettings")];
  ok("found the expected number of call sites (5)", sites.length === 5, `found ${sites.length}`);
  for (const site of sites) {
    const missing = PROPERTIES.filter((p) => p.saved)
      .map((p) => (typeof p.saved === "string" ? p.saved : p.name))
      .filter((k) => !new RegExp(`\\b${k}\\b`).test(site.body));
    ok(`call site at line ${site.line} writes every field`, missing.length === 0,
       `missing: ${missing.join(", ")}  — saveSlotSettings replaces the whole record, so these are wiped`);
  }
}

section("4. session load reads from pendingSlot, not only `saved`");
{
  // `saved` is null on the session path, so `saved?.x ?? fallback` silently drops the value.
  const decode = multiPage.slice(multiPage.indexOf("const pendingSlot ="), multiPage.indexOf("await multiEngine.addSlot"));
  const suspicious = [];
  for (const p of PROPERTIES.filter((x) => x.saved && x.session)) {
    const key = typeof p.saved === "string" ? p.saved : p.name;
    const onlySaved = new RegExp(`saved\\?\\.${key}\\b`).test(decode);
    const alsoPending = new RegExp(`pendingSlot[.?]`).test(decode) &&
      new RegExp(`pendingSlot[^\\n]{0,80}\\b${p.name}\\b|\\b${p.name}\\b[^\\n]{0,80}pendingSlot`).test(decode);
    // Spread-carried values are fine — pendingSlot is spread wholesale.
    const viaSpread = /\.\.\.pendingSlot/.test(decode);
    if (onlySaved && !alsoPending && !viaSpread) suspicious.push(key);
  }
  ok("no property is read only from `saved`", suspicious.length === 0,
     `${suspicious.join(", ")} would be lost on session load`);
}

section("5. audio-affecting properties reach the engine and the offline render");
{
  const update = fnBody(engine, "updateSlot(id: string");
  for (const p of PROPERTIES.filter((x) => x.engine)) {
    ok(`engine handles "${p.name}"`, new RegExp(`\\b${p.name}\\b`).test(engine));
  }
  for (const p of PROPERTIES.filter((x) => x.render)) {
    ok(`offline render handles "${p.name}"`, new RegExp(`\\b${p.name}\\b`).test(render));
  }
  ok("updateSlot exists", update !== null);
}

section("6. exemptions are documented, not silent");
{
  for (const p of PROPERTIES) {
    if (p.engine === false) ok(`"${p.name}" engine exemption has a reason`, !!p.skip?.engine);
    if (p.render === false) ok(`"${p.name}" render exemption has a reason`, !!p.skipRender);
  }
}

section("7. live/export rate math is character-identical");
{
  const grab2 = (src) => {
    const b = fnBody(src, "function phaseOffsetSec");
    return b ? b.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim() : null;
  };
  const grab = (src) => {
    const b = fnBody(src, "function slotPlaybackRate");
    return b ? b.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim() : null;
  };
  const a = grab(engine), b = grab(render);
  ok("both define slotPlaybackRate", a !== null && b !== null);
  ok("the two implementations are identical", a === b,
     `engine: ${a}\n        render: ${b}\n        — export would drift from playback`);

  // Same rule for the phase offset. Phase lives in the playhead, so unlike loop bounds it is
  // not implicit in the exported geometry — the render has to compute it, with the same math.
  const pa = grab2(engine), pb = grab2(render);
  ok("both define phaseOffsetSec", pa !== null && pb !== null,
     "the offline render must reproduce the offset, not inherit it from the loop bounds");
  ok("the two phase implementations are identical", pa === pb,
     `engine: ${pa}\n        render: ${pb}\n        — export would land on a different beat`);

  // The live player has loop = true and wraps at loopEnd. The offline one does not, so a
  // phased read has to be split in two or it runs past the loop into unrelated audio.
  const body = fnBody(render, "export async function renderMulti");
  ok("export reads from the phased position", /slot\.loopStart \+ off/.test(body ?? ""),
     "starting at a bare loopStart discards the offset");
  ok("export wraps at loopEnd instead of reading past it",
     /player\.start\([^)]*slot\.loopStart,/.test(body ?? "") &&
     /player\.start\([^)]*slot\.loopStart \+ off,/.test(body ?? ""),
     "a phased repeat needs two reads: off -> loopEnd, then loopStart -> off");
  ok("export threads the bar length in", /phaseBarSec/.test(render),
     "the render cannot derive the tempo grid; the UI owns it");
}

section("8. transport re-anchor paths agree on where a slot starts");
{
  // play(fromLoopStart), rewindAll and startSilencedSlots all re-anchor. They must not
  // disagree, and none may place the playhead outside the loop.
  for (const fn of ["rewindAll()", "private startSilencedSlots()"]) {
    const body = fnBody(engine, fn);
    ok(`${fn} exists`, body !== null);
    if (!body) continue;
    ok(`${fn} anchors to loopStart (or a phase-matched peer)`,
       /loopStart/.test(body) || /matchingLoopPosition/.test(body));
    ok(`${fn} does not subtract an offset from loopStart`,
       !/loopStart\s*-\s*(?!0\b)/.test(body),
       "subtracting wraps the playhead to the END of the loop");
  }
  const play = fnBody(engine, "async play(instant = false");
  ok("play() re-anchors to loopStart when asked", /fromLoopStart\)?\s*slot\.startOffset\s*=\s*slot\.loopStart/.test(play.replace(/\s+/g, " ")) || /slot\.loopStart/.test(play));
}

section("9. phase is audible immediately, not only on the next wrap");
{
  // Moving loop bounds does not move the playhead — updateSlot preserves it deliberately.
  // So a phase change MUST also call nudgeSlot or nothing is heard until the loop wraps.
  ok("engine exposes nudgeSlot", /nudgeSlot\s*\(/.test(engine));
  const applyPhase = fnBody(slotStrip, "function applyPhase");
  ok("applyPhase exists", applyPhase !== null);
  ok("applyPhase moves the playhead", /nudgeSlot/.test(applyPhase ?? ""),
     "without this, changing Phase is silent until the loop wraps");
  // Phase is a PURE timing offset. Moving the loop region is Move's job — when Phase did
  // both, the two controls were indistinguishable.
  ok("applyPhase does NOT move the loop region", !/loopStart:/.test(applyPhase ?? ""),
     "that is Move's job; Phase only shifts when the slot lands");
  ok("applyPhase shifts by the DIFFERENCE from the current phase",
     /slot\.phase/.test(applyPhase ?? ""),
     "shifting by the absolute amount each time accumulates");
  const mv2 = fnBody(slotStrip, "function moveLoop");
  ok("moveLoop DOES move the region", /loopStart:/.test(mv2 ?? ""));
  ok("moveLoop does not set phase", !/phase:/.test(mv2 ?? ""),
     "the two controls must stay independent");
  ok("phase offset is re-applied on load", /applyRestoredPhase/.test(multiPage),
     "a playhead offset is not persisted the way bounds are, so it must be re-applied");
  // Every path that returns a slot to the top of its loop must add the phase offset back,
  // or the displacement vanishes the first time the user presses rewind.
  ok("the engine owns one phase-offset implementation", /phaseOffsetFor/.test(engine));
  ok("rewindAll adds the offset", /phaseOffsetFor/.test(fnBody(engine, "rewindAll()") ?? ""));
  ok("play(fromLoopStart) adds the offset",
     /phaseOffsetFor/.test(fnBody(engine, "async play(instant = false") ?? ""));
  ok("per-slot rewind uses startPositionFor, not getLoopStart",
     /seekSlot\(slot\.id, multiEngine\.startPositionFor\(slot\.id\)\)/.test(slotStrip),
     "seeking to a bare loop start drops the phase displacement");
  // The two re-anchor paths this rule originally forgot. Section 8 already names both, but
  // this section only listed rewindAll, play() and per-slot rewind — so a phased slot went
  // silently back to the downbeat when started from its own Play button, or when unmuted
  // or soloed into a running rack. Both reach the grid through matchingLoopPosition, so
  // that is the one place the offset has to be applied.
  const mlp = fnBody(engine, "private matchingLoopPosition") ?? "";
  ok("joining a running rack re-applies the phase offset", /phaseOffsetFor\(slot\)/.test(mlp),
     "playSlot and startSilencedSlots both start from matchingLoopPosition");
  ok("joining a running rack un-phases the PEER first", /phaseOffsetFor\(other\)/.test(mlp),
     "the peer is arbitrary; unsubtracted, its own phase becomes everyone else's downbeat");
  for (const fn of ["async playSlot", "private startSilencedSlots()"]) {
    ok(`${fn} starts from the phase-aware helper`,
       /matchingLoopPosition/.test(fnBody(engine, fn) ?? ""),
       "anchoring it any other way bypasses the phase offset");
  }
  ok("a phase restore deferred by a missing anchor tempo is flushed later",
     /pendingPhaseRestoreRef/.test(multiPage),
     "guessing the bar from the slot's own BPM restores the offset against the wrong grid");
  ok("the UI keeps the engine's bar length current", /setPhaseBarSec/.test(slotStrip));
}

section("10. the three tempo domains stay distinct");
{
  ok("SlotStrip separates delayBpm from phaseBpm", /const delayBpm\b/.test(slotStrip) && /const phaseBpm\b/.test(slotStrip));
  const delayLine = slotStrip.match(/const delayBpm = [^\n]*/)?.[0] ?? "";
  const phaseLine = slotStrip.match(/const phaseBpm = [^\n]*/)?.[0] ?? "";
  ok("delay uses the HEARD tempo (gridBpm first)", /gridBpm/.test(delayLine), delayLine);
  ok("phase uses the FILE tempo (rawGridBpm first)", /rawGridBpm/.test(phaseLine), phaseLine);
  ok("they are not the same expression", delayLine !== phaseLine);
  ok("quantize scales the grid per slot", /slotGridBpm/.test(multiPage),
     "one shared BPM makes bars unequal in real time across slots");
}

section("11. relation selection cannot be ambiguous");
{
  const fn = fnBody(multiPage, "function tempoStretchRatio");
  ok("tempoStretchRatio exists", fn !== null);
  // The fold is now relation selection in loopSnap — same rule (nearest to unity stretch),
  // a wider set. What must not come back is a hand-picked band: [0.7, 1.45] spanned 2.07x,
  // so inputs near the edges had two valid answers and a 1 BPM difference flipped between
  // them. Nearest-to-unity over a fixed list has exactly one answer for any input.
  ok("selection goes through autoTempoRelation, not a hand-picked band",
     /autoTempoRelation/.test(fn ?? ""),
     "a while-loop band wider than one octave gives two valid answers for the same input");
  ok("no while-loop folding crept back", !/while\s*\([^)]*(1\.4|0\.7)/.test(fn ?? ""));
  const auto = fnBody(loopSnap, "export function autoTempoRelation");
  ok("auto folding rounds log2 and is unbounded", /Math\.round\(Math\.log2/.test(auto ?? ""),
     "searching the finite ladder cannot fold an extreme ratio far enough, and would make polymeter the default");
  ok("the ladder marks which relations stay on the shared grid", /gridSafe/.test(loopSnap));
  // Quantize derives its grid from the anchor's bar, which a polymetric slot does not share.
  // Rounding one to that grid gives a loop that is not a whole number of ITS bars, so it
  // never repeats cleanly — leave the loop alone and say so instead.
  // The bug this exists for: every entry defaulted its relation to 1, so "auto" and "the
  // user asked for the anchor's tempo" became the same stored value and the fold never ran.
  // A ratio of 1.86 that should have folded to 0.93 came out as 1.86 — audibly double speed.
  ok("an unset relation stays unset rather than defaulting to 1",
     !/tempoRelation \?\? 1/.test(multiPage),
     "a stored 1 reads as an explicit choice and suppresses the octave fold");
  ok("the applied relation falls back to autoTempoRelation",
     /\?\?\s*autoTempoRelation/.test(multiPage),
     "without the fallback the raw BPM quotient is used unfolded");
  // The picker needs both: the stored value decides whether "Auto" is selected, the
  // effective value is what every row's numbers are computed against.
  ok("the picker receives the effective relation",
     /effectiveRelation=\{entry\.effectiveRelation\}/.test(multiPage),
     "an auto-matched slot has no stored relation, so the numbers would read blank or wrong");
  ok("the picker also receives the stored choice", /tempoRelation=\{entry\.tempoRelation\}/.test(multiPage),
     "without it the picker cannot tell an explicit 1:1 from Auto");

  // Re-lock must not pass a relation override, or it overwrites the user's choice with
  // whatever the anchor currently implies — the opposite of what re-lock is for.
  const relock = fnBody(multiPage, "async function handleRelockStale");
  ok("re-lock re-stretches without overriding the relation",
     // `undefined` in the relation slot, never a number: the third argument is the
     // re-measure flag, which is about WHERE the BPM is read, not which relation is used.
     /stretchSlotToTempoAnchor\(id, undefined, true\)/.test(relock ?? ""),
     "passing a relation here would drag a deliberately half-speed slot back to the automatic answer");
  // Stale detection and the match must resolve the relation the same way, or a slot is
  // flagged stale, re-stretched, and flagged again — an auto re-lock loop every 600ms.
  ok("stale detection resolves the relation the same way the match does",
     /tempoStretchRatio\(heardBpm\(bpm, e\.slot, ms\), anchorEffectiveBpm, e\.tempoRelation\)/.test(multiPage),
     "if the two disagree, auto re-lock never converges");

  // Every tempo comparison is heard-vs-heard. Comparing a slot's RAW tempo against the
  // anchor's HEARD tempo is wrong by exactly that slot's playback rate: it agrees only when
  // every slot sits at unity, so matching at master speed 0.85 left slaves 15% slow, and
  // riding the master dial after a good match flagged the whole rack stale and let auto
  // re-lock re-stretch it into the error.
  ok("MultiPage defines heardBpm and mirrors slotPlaybackRate",
     /function heardBpm\(rawBpm: number, slot: MultiSlot, masterSpeed: number\)/.test(multiPage)
       && /slot\.linkPitch \? slot\.speed : slot\.speed \* Math\.pow\(2, slot\.pitch \/ 12\)/.test(multiPage)
       && /slot\.bypassMasterSpeed \? base : base \* \(masterSpeed \|\| 1\)/.test(multiPage),
     "the slot's own rate must be folded in the same way the engine folds it");
  for (const [call, why] of [
    [/autoTempoRelation\(heardBpm\(bpm, e\.slot, ms\), anchorEffectiveBpm\)/,
     "the recommended row must name the relation the match will actually pick"],
    [/const targetHeard = heardBpm\(targetBpm, target\.slot, masterSettingsRef\.current\.masterSpeed \?\? 1\)/,
     "the stretch itself must target the anchor's heard tempo from the slot's heard tempo"],
    [/autoTempoRelation\(targetHeard, anchorBpm\)/, "and so must the relation it folds to"],
    [/tempoStretchRatio\(targetHeard, anchorBpm, relation\)/, "and the ratio it applies"],
  ]) {
    ok(`tempo comparison is heard-vs-heard: ${call.source.slice(0, 46)}...`, call.test(multiPage), why);
  }

  // Quantize rewrites loop bounds in place and persists them, with no undo. Run mid-load it
  // rounds every loop to bars of the anchor's *guessed* BPM, because detectedBpm has not
  // arrived yet and the fallback is onset autocorrelation.
  for (const fn of ["function quantizeAllToAnchorGrid", "async function handleTempoMatchAll"]) {
    const body = fnBody(multiPage, fn);
    ok(`${fn} refuses to run while a slot is loading`,
       /some\(\(e\) => e\.loading\)/.test(body ?? ""),
       "matching against a half-loaded rack quantizes to a grid the latecomer never shares");
  }
  ok("the transport disables Match Tempos while loading", /slotsLoading/.test(transport),
     "a silent no-op reads as the button being broken");
  // Auto must be reachable, or a stored relation is a one-way door and every later match
  // honours a choice the user cannot revoke.
  ok("the relation can be cleared back to auto", /relationOverride === undefined/.test(multiPage),
     "without a null case a stored relation can never be undone");
  // No separate Auto row: it duplicated whichever value row was selected, which read as the
  // list repeating itself. Auto is now the row it lands on, marked, and choosing that row
  // clears the stored pin instead of setting one.
  ok("the picker has no duplicate Auto row", !/value="auto"/.test(slotStrip),
     "a mode row that mirrors a value row reads as a duplicate");
  ok("choosing Auto's own pick clears the pin", /=== autoRelation \? null/.test(slotStrip),
     "otherwise selecting it pins a value the user only meant to un-pin");
  // The grid chip and the slot pickers both name "the anchor's tempo". Quantize computes in
  // file time, the pickers display heard time, and an anchor at Speed 0.70x makes those
  // differ by exactly that factor — 120 in one place, 84 in the other, with no qualifier.
  ok("the grid chip reports the HEARD tempo, matching the pickers",
     /anchorEffectiveBpm \?\? anchorBpm\)\} bpm grid/.test(multiPage),
     "two surfaces naming the anchor's tempo must not disagree by the playback-rate factor");

  ok("the least-stretch row is marked for the reader", /"recommended" : null/.test(slotStrip),
     "\"auto\" names the mechanism, not anything the reader is choosing between");
  // Auto re-lock reschedules itself; a stretch outlasting the debounce starts a second pass
  // over slots the first is still rebuilding, and swapBuffer then applies a ratio relative
  // to a buffer that has already been replaced.
  ok("auto re-lock runs one cascade at a time", /relockInFlightRef/.test(multiPage),
     "overlapping cascades race on entriesRef and corrupt the stretch ratio");

  ok("quantize leaves non-grid-safe slots alone", /isGridSafeRelation/.test(multiPage),
     "rounding a 3:4 slot to the anchor's bar produces a loop that cannot repeat cleanly");
  ok("the chosen relation can be overridden", /relation\?:|relationOverride/.test(multiPage),
     "a deterministic wrong answer with no escape hatch is worse than an unstable one");
  // Strip comments first — the historical band is named in a comment explaining the fix.
  const code = (fn ?? "").replace(/\/\/[^\n]*/g, "");
  ok("no legacy while-loop band remains in code",
     !/while\s*\([^)]*(1\.45|0\.7)/.test(code));
}

section("12. moving the loop region keeps its geometry consistent");
{
  const mv = fnBody(slotStrip, "function moveLoop");
  ok("moveLoop exists", mv !== null);
  ok("it does not touch phase", !/phase:/.test(mv ?? ""),
     "Move changes what is looped; Phase changes when it lands — keep them independent");
  ok("it clamps to the buffer rather than wrapping", /Math\.max\(0/.test(mv ?? "") && /buffer\.duration/.test(mv ?? ""));
  ok("it preserves loop length", /loopDur/.test(mv ?? ""));
  ok("it carries the playhead with the region", /carryPlayhead: true/.test(mv ?? ""),
     "bounds and playhead are separate, so Move has to say which rule it wants — the engine applies it");
  ok("it repaints the playhead marker", /setSeekRevision/.test(mv ?? ""));
  // Both rewind paths must target loopStart, which Move updates — so they follow the region.
  const rw = fnBody(engine, "rewindAll()");
  ok("global rewind targets loopStart (follows a moved region)", /slot\.loopStart/.test(rw ?? ""));
  // Must read from the ENGINE, not the React prop: after a Move or Snap the prop is a
  // render behind, so rewind seeked to the previous position and the move appeared to have
  // no effect. startPositionFor also folds in the phase offset.
  ok("per-slot rewind reads from the engine, not the prop",
     /seekSlot\(slot\.id, multiEngine\.startPositionFor\(slot\.id\)\)/.test(slotStrip),
     "using slot.loopStart here is stale immediately after a Move, and drops the phase offset");

  // Phase and Move must both work on the ANCHOR, not only on slaves. This has regressed
  // twice: anchorBpm is deliberately withheld from the anchor slot so its Snap uses its own
  // tempo, and reading it here silently disables both controls on the anchor.
  ok("Move gates on phaseBpm, not anchorBpm",
     !/!anchorBpm/.test(mv ?? "") && /phaseBpm/.test(mv ?? ""));
  const phaseLine = slotStrip.match(/const phaseBpm = [^\n]*/)?.[0] ?? "";
  ok("phaseBpm resolves through rawGridBpm (which includes the anchor)",
     /rawGridBpm/.test(phaseLine), phaseLine);
  const rawGridProp = (multiPage.match(/rawGridBpm=\{[\s\S]*?\n\s*\}/) ?? [""])[0];
  ok("MultiPage passes rawGridBpm to every slot unconditionally",
     rawGridProp !== "" && !/isTempoAnchor|slotAnchorBpm/.test(rawGridProp),
     "a ternary on isTempoAnchor here is what disabled Phase on the anchor before");

  // Phase, Move, Snap and quantize all place things on the anchor's bar measured in the
  // slot's own buffer seconds — and that is NOT one number across the rack. Quantize scaled
  // by anchorRate/slotRate and Phase/Move did not, so a slot with its own Speed was
  // quantized to one bar and phased against another (a 1/2 bar offset landing ~7% early at
  // 0.70 against 0.75). Master speed hides it; a Speed knob or unlinked Pitch does not.
  const gridFn = fnBody(multiPage, "function anchorBarGridBpm");
  ok("anchorBarGridBpm scales the anchor's bar by anchorRate / slotRate",
     gridFn !== null && /slotRate\(anchorSlot, masterSpeed\)/.test(gridFn)
       && /slotRate\(slot, masterSpeed\)/.test(gridFn)
       && /anchorRawBpm \* \(\(aRate \|\| 1\) \/ \(eRate \|\| 1\)\)/.test(gridFn),
     "without the ratio every slot is placed on the anchor's file bar, which is only its own bar at equal rates");
  ok("rawGridBpm is that same per-slot grid",
     /anchorBarGridBpm\(anchorBpm, anchorEntryForBpm\?\.slot, entry\.slot/.test(rawGridProp),
     "Phase and Move read this prop; handing them the raw anchor tempo is the bug above");
  ok("quantize derives its grid from the same helper",
     /const slotGridBpm = anchorBarGridBpm\(/.test(multiPage),
     "two copies of this formula is exactly how Phase and quantize drifted apart");
  for (const [re, why] of [
    [/const phaseGrid = anchorBpmRef\.current !== undefined/, "the decode-path phase restore"],
    [/anchorBarGridBpm\(anchorBpm, anchorSlot, slot, ms\)/, "the deferred restore flushed when the anchor's BPM lands"],
  ]) {
    ok(`phase restore uses the per-slot grid: ${why}`, re.test(multiPage),
       "a restore on the anchor's raw bar puts the slot back at a different offset than the UI shows");
  }

  // Snap rounds loop bounds — buffer positions — so it needs the same per-slot bar, not the
  // anchor's raw tempo. On the anchor the two are equal, so withholding anchorBpm still does
  // its job (the anchor keeps snapping to its own tempo).
  ok("Snap rounds to the per-slot grid",
     /const bpm = rawGridBpm \?\? detectedBpm \?\? estimateBpm\(buffer\)/.test(slotStrip),
     "anchorBpm here made Snap and Match Tempos disagree about the length of a bar");
  ok("only the delay readout still falls back to the raw anchor tempo",
     /const delayBpm = gridBpm \?\? anchorBpm \?\? detectedBpm/.test(slotStrip),
     "delay is heard time and has its own domain — see the three-domain table");

  // SlotStrip must take its bar length from that prop, not from a tempo of its own.
  ok("SlotStrip derives the Phase/Move bar from rawGridBpm",
     /const phaseBpm = rawGridBpm \?\? detectedBpm/.test(slotStrip)
       && /setPhaseBarSec\(slot\.id, phaseBpm \? \(60 \/ phaseBpm\) \* 4 : 0\)/.test(slotStrip),
     "the engine has no view of the grid, so this push-down is the only thing keeping export and playback on the same bar");
}

section("12b. joining a running rack is matched in bars");
{
  // The fraction of a peer's loop is not a musical position unless both loops are the same
  // length. matchingLoopPosition must convert through the bar length the UI pushes down.
  const fn = fnBody(engine, "private matchingLoopPosition");
  ok("matchingLoopPosition exists", fn !== null);
  ok("it converts the peer's progress through the bar, not the loop fraction",
     /const otherBar = other\.phaseBarSec/.test(fn ?? "") && /const barsIn = rel \/ otherBar/.test(fn ?? ""),
     "matching raw fractions puts a 6-bar slot 0.6 of a bar off a 4-bar peer");
  ok("it still un-phases the peer and re-applies its own phase",
     /rel = pos - other\.loopStart - this\.phaseOffsetFor\(other\)/.test(fn ?? "")
       && /unphased \+ this\.phaseOffsetFor\(slot\)/.test(fn ?? ""),
     "invariant 20: the peer's own offset is not everyone else's downbeat");
  ok("it falls back to the fraction when no bar length is known",
     /rel \/ otherDur/.test(fn ?? ""),
     "with no tempo anchor there is no bar; starting at the top would be worse");
}

section("12c. Shift escapes the delay ladder");
{
  // The delay knob snaps to divisions while dragging, which makes every off-grid value
  // unreachable. Shift bypasses it — on the pointer AND on the arrow keys, because a knob
  // you can only set one way is a knob with a hidden mode.
  ok("Shift-drag skips the knob's own step quantisation",
     /const next = e\.shiftKey \? clampRange\(raw\) : clampStep\(raw\)/.test(knob),
     "clampStep alone still lands on 0.01 boundaries, which is not free");
  ok("Shift-drag tells the caller to skip its snapping too",
     /setLive\(next, \{ free: e\.shiftKey \}\)/.test(knob),
     "the ladder snap lives in SlotStrip, so the flag has to reach it");
  ok("Shift-arrow escapes the ladder only where there is one",
     /const free = e\.shiftKey && onStep !== undefined/.test(knob)
       && /const coarse = e\.shiftKey && onStep === undefined \? 10 : 1/.test(knob),
     "Shift means 10x coarse on every other knob; changing that would be a silent regression");
  ok("the delay knob honours the free flag",
     /if \(opts\?\.free\) \{[\s\S]{0,120}delayTime: v < 0\.001 \? 0 : v/.test(slotStrip),
     "without this Shift-drag repaints freely and then snaps back on the next render");
  ok("an off-grid delay is not labelled as a division",
     /Math\.abs\(delaySync\.seconds - slot\.effects\.delayTime\) < 0\.0005/.test(slotStrip),
     "nearest-division labelling would call a deliberately free 210ms delay \"0.5 \u00b7 1/8\"");
}

section("12d. one tempo control, and it sets both halves of the pair");
{
  // This was two adjacent dropdowns built from the same ladder — one set the relation, the
  // other set the relation and a delay — and with the list closed the difference was
  // invisible. Merged. The rules below are what the merge must not lose.
  ok("there is exactly one tempo dropdown, not two",
     (slotStrip.match(/onTempoRelationChange\(autoRelation !== undefined/g) ?? []).length === 1,
     "two controls over the same seven relations read as duplicates — that is why they were merged");
  ok("SlotStrip builds the tempo rows", /const tempoRows = useMemo/.test(slotStrip));
  // Colour carries meaning in this rack: orange is the tempo family, teal is the key family,
  // and bright pulsing amber means "needs you now". A tempo control in teal reads as a key
  // control at a glance, which is the whole point of having two families.
  ok("it wears the tempo colour, not the key colour",
     !/border-accent\/25 bg-accent\/5[\s\S]{0,600}Tempo — change/.test(slotStrip),
     "it sets a tempo relation and a delay — neither is a key control");
  ok("it does not borrow the word \"lock\"",
     /"⚡ Sweet spot" : "↻ Tempo"/.test(slotStrip) && !/Re-lock delay|Lock tempo/.test(slotStrip),
     "↻ Re-lock already means re-stretching a drifted slot; one word, two meanings is how this got confusing");
  ok("the ladder is offered whole, so the merge made no relation unreachable",
     /return TEMPO_RELATIONS\.map\(\(r\) => \{/.test(slotStrip)
       && !/\}\)\.filter\(\(c\): c is NonNullable/.test(slotStrip),
     "the old sweet-spot list dropped relations with no fitting delay; as the only tempo control it cannot");
  ok("each row carries the relation, its tempo, the delay and the stretch it costs",
     /\{r\.name\}\{bpm\}\{delay\}\{pct\}/.test(slotStrip)
       && /delay \$\{Math\.round\(r\.delaySec \* 1000\)\}ms/.test(slotStrip)
       && /stretchPct/.test(slotStrip),
     "a row that names only a tempo is the relation picker again");
  ok("the delay in a row carries a unit",
     !/delay \{r\.tickBeats/.test(slotStrip),
     "on the knob a bare 0.25 is read against D.TIME and its ms; in a dropdown row it is 0.25 of nothing");
  ok("rows without a delay are marked as such, so ⚡ means something",
     /r\.delaySec !== undefined[\s\S]{0,80}\\u26a1 delay/.test(slotStrip),
     "if every row claimed a delay the marker would carry no information");
  ok("choosing a row writes the relation AND the delay",
     /onTempoRelationChange\(autoRelation !== undefined && v === autoRelation \? null : v\);[\s\S]{0,1800}delayTime: row\.delaySec/.test(slotStrip),
     "half the pair is worse than neither — the delay would sit on the old relation's grid");
  // It writes the delay UNCONDITIONALLY, and that is the fix, not an oversight. The first
  // version gated it on "the delay is already within 5ms of a division", to protect a
  // hand-dialed one. But snapDelayToTempo returns the nearest division however far away it
  // is, so a real delay is either 0 or reads `free`, the gate declined every single time,
  // and picking a row moved no knob. Re-adding any such gate silently kills the feature.
  ok("the delay write is not gated on being near a division",
     /if \(row\?\.delaySec !== undefined\) \{/.test(slotStrip)
       && !/delayOnGrid/.test(slotStrip),
     "the 5ms gate never passed in practice, so the row appeared to do nothing");
  ok("offered delays are filtered against the delay ceiling",
     /b \* beatSec <= EFFECTS_LIMITS\.delayTime\.max/.test(slotStrip),
     "a 4x-slower slot's shared tick can exceed 4s, and the knob would clamp it off the grid");
  // The active row has to survive a reload like every other setting — but it is not a new
  // piece of state. It is exactly "relation + delay are the pair from that row", and both of
  // those already persist (tempoRelation is a PROPERTIES row above; delayTime rides with the
  // effects). A stored third copy could disagree with the two it was derived from.
  ok("the active sweet spot is derived from the two persisted halves, not stored",
     /const activeCombo = tempoRows\.find\(/.test(slotStrip)
       && /Math\.abs\(c\.value - effectiveRelation\) < 1e-6/.test(slotStrip)
       && /Math\.abs\(c\.delaySec - slot\.effects\.delayTime\) < 0\.002/.test(slotStrip),
     "storing it would let a reloaded slot claim a sweet spot its delay had been moved off");
  ok("no sweetSpot field was added to the persisted shapes",
     !/sweetSpot/i.test(settings) && !/sweetSpot/i.test(multiPage),
     "it is derived; a persisted copy is a second source of truth");
  ok("the list is titled",
     /\{activeCombo \? "⚡ Sweet spot" : "↻ Tempo"\} — \{currentRow\?\.name \?\? "change"\}…/.test(slotStrip),
     "opened, seven unlabelled rows do not say what they are choosing between");
  ok("the title row is not disabled",
     !/<option value="" disabled>/.test(slotStrip),
     "greyed out reads as broken, not as a heading");
  ok("selecting the title is a no-op",
     /if \(e\.target\.value === ""\) return;/.test(slotStrip),
     'Number("") is 0, which would pin a relation of zero');
  // Parked on the placeholder ON PURPOSE. A native select fires no change event for the
  // option already selected, so binding value to the current relation made that row — and
  // the delay it advertises — unreachable. The current row is named in the placeholder and
  // ticked in the list instead.
  ok("the select stays parked on the placeholder",
     /value=""\n/.test(slotStrip) || /value=""\s/.test(slotStrip),
     "binding it to the current relation makes that row unselectable, so its delay cannot be applied");
  ok("the placeholder names the current relation",
     /currentRow\?\.name \?\? "change"/.test(slotStrip),
     "the browser's own selection mark no longer says where you are, so the text must");
  ok("and the current row is ticked explicitly",
     /const here = Math\.abs\(r\.value - effectiveRelation\) < 1e-6 \? "\\u2713 " : "";/.test(slotStrip));
  ok("and reads as engaged while a sweet spot is",
     /activeCombo[\s\S]{0,120}border-orange-400\/50 bg-orange-500\/20/.test(slotStrip),
     "same lit-orange treatment as every other engaged tempo control; dimming is how you see you moved off it");
  ok("it is hidden on the tempo anchor",
     /!isTempoAnchor && hasTempoAnchor && tempoRows\.length > 0/.test(slotStrip),
     "the anchor has no relation to the anchor, and there is nothing to be relative to with no anchor at all");
  const lock = fnBody(loopSnap, "export function lockingDelays");
  ok("lockingDelays requires an exact relationship to BOTH grids",
     /locked\(1, b\) && locked\(slotBeat, b\)/.test(lock ?? "")
       && /whole\(beat \/ b\) \|\| whole\(b \/ beat\)/.test(lock ?? ""),
     "locking to only the slot's beat is the 0.375-at-4/3 case that fights the kick");
  ok("a tick may be a whole NUMBER of beats, not only a division of one",
     /whole\(b \/ beat\)/.test(lock ?? ""),
     "divisions-only caps every delay at one beat, so 4x slower / 2x slower / anchor all " +
     "collapsed onto the same value and stepping between those rows moved no knob");
  ok("but never longer than the slot's own beat",
     /b <= slotBeat \+ 1e-9/.test(lock ?? ""),
     "a multiple of the anchor's beat that exceeds the slot's reads as a bar-length wash, not its pulse");
}

section("12e. an async stretch must not resurrect the slot it captured");
{
  // stretchSlotToTempoAnchor reads its entry, yields twice (a frame for the spinner, then
  // the stretch itself), and commits. Spreading the CAPTURED slot at the end puts back every
  // value the user changed in between. Real symptom: the Sweet spots picker writes a delay
  // and a relation in one click, the stretch clobbered the delay, and the row only took
  // effect on the second attempt — in the audio and in localStorage, not just in the badge.
  const fn = fnBody(multiPage, "async function stretchSlotToTempoAnchor");
  ok("stretchSlotToTempoAnchor exists", fn !== null);
  ok("the swap ratio is measured from the engine's buffer, not from React state",
     /const held = multiEngine\.getBuffer\(targetSlotId\)/.test(fn ?? "")
       && /stretch \/ currentStretch/.test(fn ?? "")
       && !/stretch \/ target\.stretch/.test(fn ?? ""),
     "a stale ratio rescales loop bounds against a buffer already swapped — the loop lands wrong or collapses");
  ok("and the early-return compares against that same measured value",
     /Math\.abs\(stretch - currentStretch\) < 0\.005/.test(fn ?? ""),
     "comparing against the stale copy skips a rebuild that is genuinely needed");
  ok("it commits from the updater's prev, not from the captured entry",
     /slot: \{\s*\.\.\.e\.slot,\s*loopStart,\s*loopEnd,/.test(fn ?? "")
       && /\.\.\.e\.slot\.effects, \.\.\.matchedDelay\(e\.slot\.effects\)/.test(fn ?? "")
       && !/\.\.\.target\.slot/.test(fn ?? ""),
     "spreading target.slot after an await reverts anything changed during the rebuild");
  ok("and persists that same committed entry",
     /persisted = next;/.test(fn ?? "") && !/persistMatchedState\(\s*\{ \.\.\.target/.test(fn ?? ""),
     "persisting the stale copy writes the reverted value to storage too");
}

section("12f. a picker row never sits on a raw YouTube id");
{
  // GET /api/stems/library falls back to the id when history has no title yet, and there is
  // a real window where that happens: the stems land (so /status reports ready and the
  // client refetches) just before the title is recorded. A row reading "yTiVw3rFNhU" is
  // unusable — you cannot tell which track it is — and it used to persist until a reload.
  ok("the picker notices a title that is just the id",
     /library\.some\(\(e\) => e\.title === e\.id\)/.test(picker),
     "nothing else distinguishes the fallback from a real title");
  ok("and refetches to heal it", /titleRetriesRef/.test(picker) && /fetchLibrary\(\)/.test(picker));
  ok("but a bounded number of times",
     /titleRetriesRef\.current >= 3/.test(picker),
     "a track with no history entry looks identical and would poll forever");
}

section("12g. a stored anchor whose slot is gone must not lock the rack");
{
  // Both anchors persist by trackId/stem, so a restored id can match no loaded slot. Gating
  // "has an anchor" on the id alone made every slot offer "Match Tempo" / "Match Key"
  // against nothing, while no slot offered "Set ... Anchor" — the rack could not be
  // re-anchored at all without clearing it.
  ok("anchor presence is decided by a loaded slot, not a stored id",
     /const hasReference = entries\.some\(\(e\) => e\.slot\.id === referenceSlotId\)/.test(multiPage)
       && /const hasTempoAnchor = entries\.some\(\(e\) => e\.slot\.id === tempoAnchorId\)/.test(multiPage),
     "a dangling id reads as an anchor that exists");
  ok("and that is what SlotStrip is told",
     /hasTempoAnchor=\{hasTempoAnchor\}/.test(multiPage)
       && !/hasTempoAnchor=\{tempoAnchorId !== null\}/.test(multiPage));

  // Phase and Move need a bar length. Snap has always fallen back to measuring the buffer;
  // these read the same prop, so without the same fallback they sat dead on a rack with no
  // anchor while Snap on the same slot worked.
  ok("Phase/Move fall back to a measured tempo, like Snap",
     /entry\.detectedBpm \?\? \(entry\.sourceBuffer \? sourceBpm\(entry\.sourceBuffer\) : undefined\)/.test(multiPage),
     "greyed-out Phase and Move next to a working Snap is the symptom");
  ok("that fallback uses the memoised measurement",
     /sourceBpm\(entry\.sourceBuffer\)/.test(multiPage),
     "estimateBpm is ~30ms and this is a render path");
}

section("12h. swapBuffer compensates its own scheduling lead");
{
  const fn = fnBody(engine, "swapBuffer(id: string, buffer: AudioBuffer, ratio: number)");
  ok("swapBuffer exists", fn !== null);
  ok("it advances the resume position by the lead, scaled by playback rate",
     /const advanced = this\.wrapIntoLoop\(slot, newPos \+ lead \* \(Number\.isFinite\(rate\) \? rate : 1\)\)/.test(fn ?? ""),
     "starting at now+lead from a position sampled at now puts the slot a lead behind the rack");
  ok("and the parked offset follows it",
     /slot\.startOffset = advanced;/.test(fn ?? ""),
     "a later pause/resume would otherwise rewind by the lead again");
}

section("12i. quantizing a running rack does not strand a playhead");
{
  // updateSlot leaves the playhead alone on purpose (Move must not jump the audio), but
  // quantize can shorten a loop past the current position, and a player sitting outside its
  // loop region plays to the end of the buffer before it ever wraps.
  const fn = fnBody(engine, "reseatInLoop(id: string, posBefore: number)");
  ok("the engine can fold a stranded playhead back in", fn !== null);
  ok("it is a no-op while the playhead is inside",
     /if \(posBefore >= slot\.loopStart && posBefore < slot\.loopEnd\) return;/.test(fn ?? ""),
     "Move and Snap must stay silent");
  // The position has to be sampled against the OLD bounds. getSlotPosition folds into the
  // slot's current loop, so read after the assignment it can never be outside — the first
  // version of this check was dead code that could not fire.
  ok("the position is sampled before the new bounds are assigned",
     /const posBefore = boundsMoved \? this\.getSlotPosition\(id\) : 0;[\s\S]{0,200}Object\.assign\(slot, patch\);/.test(engine),
     "sampled afterwards it is always inside by construction");
  ok("a stopped slot has its parked offset corrected, without a seek",
     /if \(!slot\.playing\) return;[\s\S]{0,120}slot\.player\.seek/.test(fn ?? ""),
     "seeking a stopped player throws; the offset still has to be inside for the next start");
  ok("it folds by whole loop durations, preserving the bar position",
     /const wrapped = this\.wrapIntoLoop\(slot, posBefore\)/.test(fn ?? ""),
     "a post-quantize loop is a whole number of bars, so folding by it keeps the beat");
  // The fold is the engine's job, not each caller's — that was the whole point of moving the
  // rule into updateSlot. Quantize must NOT ask to carry the playhead: rounding the region
  // must not drag the audio with it.
  ok("updateSlot folds a stranded playhead itself",
     /if \(boundsMoved\)[\s\S]*?this\.reseatInLoop\(id, posBefore\);/.test(engine),
     "leaving it to callers is how quantize came to miss it");
  ok("carrying the playhead and folding it are exclusive",
     /this\.nudgeSlot\(id, startDelta\);[\s\S]*?else this\.reseatInLoop\(id, posBefore\);/.test(engine),
     "a nudge already lands inside the loop; folding on top of it would move the audio twice");
  ok("quantize does not carry the playhead",
     /multiEngine\.updateSlot\(entry\.slot\.id, \{ loopStart: finalStart, loopEnd: finalEnd \}\)/.test(multiPage)
       && !/reseatInLoop\(entry\.slot\.id\)/.test(multiPage),
     "rounding a region is not a Move");
  ok("no call site outside the engine folds the playhead by hand",
     !/reseatInLoop/.test(multiPage) && !/reseatInLoop/.test(slotStrip),
     "one door: the rule lives in updateSlot or it decays back to three call sites");
}

section("12j. the sessions panel stays inside the window");
{
  // The list grows with every save. Unbounded, it ran off the bottom of the screen and took
  // the save box — the only way to add another session — with it.
  const panel = multiPage.slice(multiPage.indexOf("sessionsPanelOpen && ("), multiPage.indexOf("sessionsPanelOpen && (") + 6000);
  ok("the panel is height-capped", /max-h-\[min\(70vh,32rem\)\]/.test(panel),
     "a viewport-relative cap, so it also works on a short window");
  ok("the list scrolls, not the panel",
     /overflow-y-auto/.test(panel) && /min-h-0/.test(panel),
     "without min-h-0 a flex child refuses to shrink and the scroller never engages");
  ok("the save form sits outside the scroller",
     panel.indexOf("overflow-y-auto") < panel.indexOf("Save current session"),
     "it is the one control that must stay reachable at any list length");
}

section("12k. silent effect branches leave the render graph");
{
  // Web Audio renders every node reachable from the destination, so a convolver at 0% wet
  // costs the same as one at 100%. Each slot carried two reverbs, a 3s spring impulse and a
  // throw reverb, all live regardless of their knobs — five slots exhausted the audio
  // thread's budget and the rack went silent while the transport kept running.
  //
  // The reverb is the trap: in algorithmic mode Tone.Reverb at wet 0 passes the DRY signal,
  // so `algorithmic → algorithmicOut → gain` is the slot's only path to the master.
  // Disconnecting it to save convolution silences the slot. It needs a dry path first.
  ok("the chain carries a dry path around the reverb",
     /reverbBypass: Tone\.Gain;/.test(multiChain) && /delay\.connect\(reverbBypass\)/.test(multiChain),
     "without it, removing the reverb removes the audio");
  ok("the bypass is raised in the same step the reverb is dropped",
     /chain\.reverbBypass\.gain\.value = 1;[\s\S]{0,200}algorithmicOut\.disconnect\(chain\.gain\)/.test(multiChain),
     "one without the other is either silence or a doubled dry signal");
  ok("and lowered when the reverb comes back",
     /chain\.reverbBypass\.gain\.value = 0;[\s\S]{0,200}algorithmicOut\.connect\(chain\.gain\)/.test(multiChain));
  ok("the swap only happens at exactly zero wet",
     /const reverbNeeded = e\.reverbWet > 0;/.test(multiChain),
     "anywhere else there is a tail to cut off");
  ok("applyDualReverb itself no longer disconnects anything",
     !/setBranch/.test(reverbSlot) && !/algoLive/.test(reverbSlot),
     "it is shared with single/mix, whose graphs have no bypass path");

  ok("the engine has one helper for parallel sends",
     /private static setSend\(/.test(engine) && /if \(live === was\) return was;/.test(engine),
     "redundant connect/disconnect calls on every knob turn are their own bug");
  ok("the spring send follows Big Knob",
     /slot\.springLive = MultiEngine\.setSend\(slot\.springWet, this\.master, wet > 0/.test(engine),
     "a genuinely parallel send, so it is safe to drop — a 3s impulse per slot");
  ok("the throw tail starts disconnected",
     /throwReverb\.disconnect\(this\.master\);/.test(engine),
     "a Tone.Reverb per slot for a send that is idle almost always");
  ok("and is wired back in before the gate opens",
     /setSend\(slot\.throwReverb, this\.master, true/.test(engine));
  ok("and dropped only after the echoes have rung out",
     /const tailSec = ts\.delayTime \* 8 \+ ts\.reverbDecay \+ 1/.test(engine)
       && /if \(!slot\.throwActive && this\.master\)/.test(engine),
     "disconnecting at gate close cuts the throw exactly where it should be trailing away");
  ok("its pending disconnect is cleared on teardown",
     (engine.match(/throwTailTimer\) clearTimeout/g) ?? []).length >= 2,
     "a timer firing after dispose touches a disposed node");
  ok("the bypass node is disposed with the rest of the chain",
     (engine.match(/reverbBypass\.disconnect\(\); slot\.chain\.reverbBypass\.dispose\(\)/g) ?? []).length >= 2,
     "removeSlot and dispose both tear the chain down");
}

section("12l. an uploaded file is a track like any other");
{
  // Demucs reads from disk, so an upload has to become a cached WAV with an id before any of
  // the existing machinery — separation, the library, sessions, /api/audio — can touch it.
  ok("uploads are transcoded to the same WAV the YouTube path produces",
     /audioFrequency\(44100\)[\s\S]{0,200}audioChannels\(2\)[\s\S]{0,200}audioCodec\("pcm_s16le"\)/.test(
       (extract.match(/export async function ingestUpload[\s\S]*?\n\}/) ?? [""])[0]),
     "anything else is a second on-disk format the whole pipeline has to learn");
  ok("the id is content-derived, so re-uploading reuses the existing stems",
     /createHash\("sha1"\)\.update\(bytes\)/.test(extract),
     "a random id would re-separate the same file every time");
  ok("uploads respect the duration cap",
     /duration > MAX_DURATION_SECONDS/.test(extract),
     "the cap is about demucs runtime, which does not care where the audio came from");
  ok("there is one id rule, shared",
     /YOUTUBE_ID\.test\(id\) \|\| UPLOAD_ID\.test\(id\)/.test(trackId)
       && /isValidTrackId/.test(audioRoute) && /isValidTrackId/.test(stemsRoute),
     "the 11-character YouTube check rejected upload ids from /api/audio — stems separated fine and then would not play");
  ok("it stays an allowlist",
     /\^up-\[0-9a-f\]\{12\}\$/.test(trackId) && !/replace|sanitiz/i.test(trackId),
     "these ids are interpolated into filesystem paths");
  ok("separation accepts an id for audio already on disk",
     /const id = parsed\.data\.id \?\? \(parsed\.data\.url \? extractVideoId\(parsed\.data\.url\) : null\)/.test(stemsRoute)
       && /parsed\.data\.id && existsSync\(cached\)/.test(stemsRoute),
     "an upload has no YouTube page, so sending yt-dlp after its id fails");
  ok("the picker drives both entry points through one poll",
     /async function separateAndWait\(/.test(picker)
       && (picker.match(/separateAndWait\(/g) ?? []).length >= 3,
     "two copies of the polling loop is how the URL and upload paths would drift apart");
  ok("the upload sends its filename encoded",
     /"x-filename": encodeURIComponent\(file\.name\)/.test(picker),
     "a header cannot carry the non-ASCII characters real filenames have");
}

section("12m. the sweep filter reaches live AND export");
{
  // Every effect has to exist twice — the live chain and the offline render — and the second
  // one is the copy that gets forgotten. Invariant 2: export matches audible settings.
  ok("the live chain has the filter, pre-delay like the EQ",
     /const filter = new Tone\.Filter\(\{ type: "lowpass"/.test(multiChain)
       && /new Tone\.Chorus\([\s\S]{0,120}\}\)\.connect\(filter\)/.test(multiChain),
     "after the delay it would dull the repeats instead of letting them carry the sweep");
  ok("the offline chain has it too",
     /const filterOff = new Tone\.Filter\(\{[\s\S]{0,60}type: "lowpass"/.test(multiChain)
       && /connect\(filterOff\)/.test(multiChain),
     "an export that ignores the filter is the classic half-implemented effect here");
  ok("both read the same two fields",
     (multiChain.match(/sweepFreq/g) ?? []).length >= 2 && (multiChain.match(/sweepRes/g) ?? []).length >= 2);
  ok("defaults leave it open, so old sessions are unchanged",
     /sweepFreq: 20000/.test(read("store.ts")) && /sweepRes: 0\.5/.test(read("store.ts")),
     "a filter that defaults closed silently dulls every existing session");
  ok("the frequency knob is logarithmic",
     /Math\.log2\(\(slot\.effects\.sweepFreq/.test(slotStrip)
       && /EFFECTS_LIMITS\.sweepFreq\.min \* Math\.pow\(2, v\)/.test(slotStrip),
     "linear, the entire usable sweep lives in the last eighth of the travel");
  ok("the sweep reaches low enough to actually choke",
     /sweepFreq: \{ min: 30, max: 20000 \}/.test(read("store.ts")),
     "a floor above the bass leaves low end passing at the bottom of the travel");
  ok("resonance range is the full sweep-to-squeal",
     /sweepRes: \{ min: 0\.5, max: 20 \}/.test(read("store.ts")));
}

section("12n. the session label names a session that exists");
{
  // Three separate paths change the saved-session list, and each one forgot that the header
  // button is a *copy* of a name in it. A label naming a deleted, renamed-away or
  // imported-over session is not cosmetic: it is what the export filename is built from.
  ok("deleting the loaded session drops the label",
     /deleteNamedSession\(name\)\);[\s\S]{0,200}setActiveSessionName\(\(cur\) => \(cur === name \? null : cur\)\)/.test(multiPage),
     "the mount-time validation runs once and is guarded by a ref, so nothing else clears it");
  ok("a refused rename does not move the label",
     /const refused = updated\.some\(\(s\) => s\.name === oldName\);[\s\S]{0,120}if \(!refused\)/.test(multiPage),
     "renameNamedSession declines a name that is already taken; relabelling anyway pointed the header at a different session");
  ok("an empty ?slots= clears the label on navigation, not only on mount",
     /if \(\(searchParams\.get\("slots"\) \?\? ""\)\.trim\(\) === ""\) setActiveSessionName\(null\);/.test(multiPage)
       && /\}, \[searchParams\]\);/.test(multiPage),
     "the lazy initialiser only runs on mount, so clicking the home link left a blank rack still naming a session");
  ok("import re-checks the label against the imported list",
     /setNamedSessions\(data\.namedSessions\);[\s\S]{0,240}data\.namedSessions\.some\(\(s\) => s\.name === cur\)/.test(multiPage),
     "import replaces every session, so the name the header holds may no longer exist");
}

section("12o. a faded mute is a level change, not a stop");
{
  // The whole point is that the slot keeps running in time, so it un-mutes back on the grid
  // rather than restarting. If this ever turns into a stop/start it will silently lose phase.
  ok("the mute path never stops the player",
     !/patch\.muted[\s\S]{0,400}player\.stop/.test(engine),
     "stopping would drop the slot off the grid, which is exactly what the fade exists to avoid");
  ok("the fade only applies to mute and solo",
     /patch\.muted !== undefined \|\| patch\.soloed !== undefined \? opts\?\.fadeSec : undefined/.test(engine),
     "a gain-knob drag ramped per frame makes the knob feel disconnected from the sound");
  ok("recomputeAllVolumes can ramp instead of jumping",
     /recomputeAllVolumes\(fadeSec\?: number\)/.test(engine)
       && /if \(fadeSec && fadeSec > 0\)[\s\S]{0,400}rampVolume\(slot, targetDb, now, fadeSec/.test(engine),
     "writing .value cancels automation, so the ramp has to replace that write, not follow it");
  ok("a ramp out of silence starts from the floor, not -Infinity",
     /silentNow = !Number\.isFinite\(cur\) \|\| cur <= MultiEngine\.GAIN_FLOOR_DB/.test(engine),
     "dbToGain(-Infinity) poisons the automation curve — the documented reason rampVolume has fromSilence");
  ok("an in-flight fade is still re-targeted, not restarted",
     /Math\.abs\(targetDb - slot\.fadeTarget\) < 0\.01/.test(engine),
     "hitting Fade twice, or muting mid-fade, would otherwise restart the ramp audibly");
  ok("the UI reads the fade length from the engine",
     /fadeSeconds\(\): number \{ return MultiEngine\.FADE_SEC; \}/.test(engine)
       && /multiEngine\.fadeSeconds\(\)/.test(slotStrip)
       && !/fadeSec: 10/.test(slotStrip),
     "a second copy of the number drifts from the transport's fade");
  ok("the instant half still exists",
     /onClick=\{\(\) => update\(\{ muted: !slot\.muted \}\)\}/.test(slotStrip)
       && /update\(\{ muted: !slot\.muted \}, \{ fadeSec: multiEngine\.fadeSeconds\(\) \}\)/.test(slotStrip),
     "the split control is instant on the left, fade on the right — same shape as Play All");
}

section("12p. a tempo row has to be audible, and reachable in one click");
{
  ok("picking a row switches the delay on when it is at zero",
     /slot\.effects\.delayWet <= 0\.001[\s\S]{0,120}delayWet: 0\.5, delayFeedback: 0\.35/.test(slotStrip),
     "both default to 0, so writing only delayTime moved a knob and changed nothing audible");
  ok("but never overwrites a delay mix already dialled in",
     /\? \{ delayWet: 0\.5, delayFeedback: 0\.35 \}[\s\S]{0,40}: null/.test(slotStrip),
     "turning something on from zero is a reveal; overwriting the user's mix is a theft");
  ok("feedback stays well under the wet level",
     /delayFeedback: 0\.3[0-9]?/.test(slotStrip) && !/delayFeedback: 0\.[5-9]/.test(slotStrip),
     "the slow rows hand out bar-length delays; 60% feedback on one is a ~20s tail");
  ok("Lock All runs keys before tempos",
     /handleMatchAll\(\);[\s\S]{0,400}handleTempoMatchAll\(\)/.test(multiPage),
     "Match Keys writes Speed and the tempo pass reads it — the reverse order leaves every slave stale");
  ok("and yields between the two so the tempo pass sees the new Speed",
     /handleMatchAll\(\);[\s\S]{0,300}await new Promise\(\(r\) => setTimeout\(r, 0\)\);[\s\S]{0,200}handleTempoMatchAll/.test(multiPage),
     "entriesRef is a render behind, so without it the heard BPM is computed from pre-match Speed");
  ok("it runs whichever anchors are set rather than demanding both",
     /if \(referenceSlotIdRef\.current\)[\s\S]{0,400}if \(tempoAnchorIdRef\.current\)/.test(multiPage),
     "a rack with only a tempo anchor should still lock");
  ok("the transport lists Keys before Tempos",
     transport.indexOf("↻ Match Keys") < transport.indexOf("↻ Match Tempos"),
     "left to right the UI read backwards from the order that works, with nothing saying so");
  ok("Lock All comes first of the three",
     transport.indexOf("⚓ Lock All") < transport.indexOf("↻ Match Keys"),
     "it is the one-click path; the single-dimension buttons are the fallback");
}

section("12q. the slot sweep filter is not the throw filter");
{
  // Both dials are labelled Freq. They were both called filterFreq too, in the same
  // codebase — so a grep in the area most likely to be edited returned the wrong one.
  ok("the slot filter uses the sweep names",
     /sweepFreq/.test(read("store.ts")) && /sweepRes/.test(read("store.ts")));
  ok("the throw filter keeps its own",
     /filterFreq: number/.test(settings) && !/sweepFreq/.test(settings),
     "ThrowSettings is a different filter with a different range and default");
  ok("no EffectsState field is still called filterFreq",
     !/filterFreq|filterQ/.test(read("audio/multiChain.ts")),
     "the slot chain is the one place the two could be confused");
  ok("a filter saved under the old names is still read",
     /\(e as LegacyFilterEffects\)\.filterFreq/.test(read("store.ts"))
       && /\(e as LegacyFilterEffects\)\.filterQ/.test(read("store.ts")),
     "without the legacy read, a slot with a dialled sweep reloads wide open and silently loses it");
}

section("12r. the sweeps that were costing CPU or padding files");
{
  ok("the throw impulse is only regenerated when the decay moved",
     /if \(settings\.reverbDecay === prevDecay\) return;/.test(engine),
     "it was rebuilding one convolution impulse per slot on every throw knob, for a value the impulse ignores");
  ok("export appends no reverb tail at zero wet",
     /if \(e\.reverbWet <= 0\) return 0;/.test(reverbSlot),
     "the decay knob keeps its value when wet goes to 0, so every such export gained up to 8s of silence");
  ok("a slot added to a running rack joins in phase",
     /this\.matchingLoopPosition\(runtime\) \?\? slot\.loopStart/.test(engine),
     "addSlot was the third join path and the only one still starting at the top of its own loop");
  ok("POST /api/stems validates the id it is handed",
     /isValidTrackId\(id\)\) return res\.status\(400\)/.test(stemsRoute),
     "it is interpolated into cache/<id>.wav and stems/htdemucs/<id>/, and CORS is wide open");
}

section("12s. doc comments sit on the function they describe");
{
  // Two had drifted onto the wrong declaration, and one of them argued for behaviour that
  // had been deliberately removed — in the file where confusing time domains has caused the
  // same bug twice. A comment that contradicts the code is worse than none.
  const before = (a, b) => engine.indexOf(a) < engine.indexOf(b) && engine.indexOf(a) !== -1;
  ok("the rewind comment is on rewindAll",
     /one shared timestamp[\s\S]{0,420}\n  rewindAll\(\): void \{/.test(engine));
  ok("the phase-offset comment is on phaseOffsetFor",
     /displaced from its loop start by Phase[\s\S]{0,620}\n  private phaseOffsetFor\(/.test(engine));
  ok("startSilencedSlots describes what it now does",
     /private startSilencedSlots\(\): void \{/.test(engine)
       && /joins at `matchingLoopPosition`, NOT at its own parked/.test(engine)
       && !/there is no shared position to align to/.test(engine),
     "the old text said slots resume from their own startOffset — the exact behaviour that was fixed");
  ok("setSend keeps only its own comment",
     before("Keep a parallel send out of the render graph", "  private static setSend("));
}

section("12t. Reset actually resets");
{
  // Reset builds its patch from DRY_EFFECTS, which lives on the old dub page and lagged
  // every knob the multi rack gained. Because each new field was added to EffectsState as
  // OPTIONAL, the compiler never objected — so EQ and the sweep filter quietly survived a
  // Reset, and the call site had grown a hand-written `phaserWet: 0, chorusWet: 0` patch
  // instead. This reads the interface and fails on the next field that goes missing.
  const dub = read("audio/dubEngine.ts");
  const iface = /export interface EffectsState \{([\s\S]*?)\n\}/.exec(read("store.ts"))?.[1] ?? "";
  const keys = [...iface.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  const dry = /DRY_EFFECTS[^=]*= \{([\s\S]*?)\n\};/.exec(dub)?.[1] ?? "";
  ok("EffectsState has fields to check", keys.length > 15);
  for (const k of keys) {
    ok(`DRY_EFFECTS sets "${k}"`, new RegExp(`^\\s*${k}:`, "m").test(dry),
       "absent means Reset leaves this knob where it was, and a new slot inherits it by accident");
  }
  ok("dry means OPEN for the sweep filter, not zero",
     /sweepFreq: EFFECTS_LIMITS\.sweepFreq\.max/.test(dub) && /sweepRes: EFFECTS_LIMITS\.sweepRes\.min/.test(dub),
     "a 0Hz lowpass cutoff mutes the slot outright");
  ok("Reset patches nothing on top of DRY_EFFECTS",
     /effects: \{ \.\.\.DRY_EFFECTS \}, speed: 1, pitch: 0, linkPitch: true, gain: 0/.test(slotStrip),
     "a hand-written field at the call site is how the other knobs got forgotten");
}

section("12u. Grit drives the shaper, not just its curve");
{
  // The knob only widened the clipping curve, which stops getting nastier around 60%. Dirt
  // comes from how hard the signal hits the shaper, so Grit now also boosts into it.
  ok("there is a drive before the shaper and a makeup after",
     /const drive = new Tone\.Gain\(1\)\.connect\(distortion\)/.test(multiChain)
       && /const makeup = new Tone\.Gain\(1\)\.connect\(eqLo\)/.test(multiChain)
       && /\.connect\(makeup\)/.test(multiChain));
  ok("both are driven by grit",
     /chain\.drive\.gain\.value = Tone\.dbToGain\(GRIT_DRIVE_DB \* grit\)/.test(multiChain)
       && /chain\.makeup\.gain\.value = Tone\.dbToGain\(-GRIT_MAKEUP_DB \* grit\)/.test(multiChain));
  ok("and are unity at grit 0",
     /new Tone\.Gain\(1\)\.connect\(distortion\)/.test(multiChain),
     "a clean slot must pass through untouched — this node is in every slot's path");
  ok("makeup gives back less than the drive",
     /GRIT_DRIVE_DB = 18/.test(multiChain) && /GRIT_MAKEUP_DB = 9/.test(multiChain),
     "the shaper bounds its own output, so full compensation makes the slot quieter as it dirties");
  // Invariant 2. The offline chain is the half that gets forgotten, and an export that is
  // cleaner than what was auditioned is the worst kind of wrong: it sounds fine.
  ok("the offline render does the same thing",
     /Tone\.dbToGain\(GRIT_DRIVE_DB \* grit\)/.test(multiChain)
       && /Tone\.dbToGain\(-GRIT_MAKEUP_DB \* grit\)/.test(multiChain),
     "export must hit the shaper exactly as hard as playback did");
  ok("both constants are read twice — live and offline",
     (multiChain.match(/GRIT_DRIVE_DB/g) ?? []).length >= 3
       && (multiChain.match(/GRIT_MAKEUP_DB/g) ?? []).length >= 3,
     "a second hardcoded number is how the two chains drift apart");
  ok("the player feeds the drive, not the shaper",
     /new Tone\.Player\(toneBuffer\)\.connect\(chain\.drive\)/.test(engine),
     "connecting to the distortion would route around the drive and silently restore the old behaviour");
  ok("the new nodes are disposed with the slot",
     (engine.match(/chain\.drive\.disconnect\(\); slot\.chain\.drive\.dispose\(\)/g) ?? []).length === 2
       && (engine.match(/chain\.makeup\.disconnect\(\); slot\.chain\.makeup\.dispose\(\)/g) ?? []).length === 2,
     "removeSlot and dispose both, or a removed slot leaks two nodes per slot");
}

section("12v. tempo detection must not fail silently");
{
  // It did, for every track in the app. RhythmExtractor2013 was handed the WHOLE file —
  // thirteen million samples for a five-minute stem — blew the WASM heap, threw, and the
  // throw went into a bare `catch {}`. Keys kept working (KeyExtractor is far cheaper), so
  // nothing looked broken: every BPM in the app was quietly the rough onset estimate from
  // loopSnap instead. Not one of 32 saved sessions had a detectedBpm.
  const worker = read("workers/audioAnalysisWorker.ts");
  ok("the rhythm pass runs on a slice, not the whole track",
     /RHYTHM_WINDOW_SEC/.test(worker) && /mono\.subarray\(start, start \+ want\)/.test(worker),
     "the whole file is what exhausted the heap; tempo does not change, so more audio buys nothing");
  ok("the key vector is freed before the rhythm pass allocates",
     /keyVector\?\.delete\(\);[\s\S]{0,400}estimateTempo\(/.test(worker),
     "two copies of a multi-minute track in the WASM heap at once is most of the original failure");
  ok("a failure is reported, never swallowed",
     !/\} catch \{\s*\/\* rhythm extraction failed/.test(worker)
       && /bpmError/.test(worker) && /console\.warn\(`\[analysis\] no BPM/.test(worker),
     "a bare catch here hid a total feature outage for the entire library");
  ok("there is a cheaper second opinion",
     /PercivalBpmEstimator\(vector/.test(worker),
     "one algorithm failing should not mean no tempo at all");
  ok("both estimators are range-checked",
     /v >= 40 && v <= 250/.test(worker),
     "Essentia returns 0 when it finds no pulse, and 0 would be accepted as a tempo");
  ok("a cached key with no BPM counts as incomplete",
     /stemAnalysis\.bpm !== undefined/.test(multiPage),
     "otherwise every already-analysed stem stays BPM-less forever behind a cache HIT");
}

section("12w. pinning the anchor re-measures its tempo from the loop");
{
  // Load-time detection reads the middle of the file, which is a guess about where the beat
  // lives. By the time a slot is pinned as the anchor the user has chosen a loop, and that
  // loop is the part being played.
  const worker = read("workers/audioAnalysisWorker.ts");
  const analysis = read("lib/audioAnalysis.ts");
  ok("pinning triggers it",
     /void redetectAnchorTempo\(entry\.slot\.id\)\.then\(/.test(multiPage));
  ok("ONLY pinning triggers it",
     (multiPage.match(/redetectAnchorTempo\(/g) ?? []).length === 2,
     "re-measuring whenever a loop handle moved would restretch every slave mid-session — "
     + "the anchor's BPM is the grid the whole rack is built on");
  ok("loop bounds are divided out of the stretch first",
     /const ratio = entry\.stretch > 0 \? entry\.stretch : 1;[\s\S]{0,160}loopStart \/ ratio/.test(multiPage),
     "bounds are in the stretched timebase, sourceBuffer is not — invariant 18");
  ok("a failed detection keeps the old value",
     /const key = result\.key \?\? entry\.detectedKey \?\? null;/.test(multiPage)
       && /const bpm = result\.bpm \?\? entry\.detectedBpm;/.test(multiPage)
       && /measured \?\? target\.detectedBpm \?\? sourceBpm/.test(multiPage),
     "no answer is not evidence the previous answer was wrong — each half falls back independently");
  ok("a relation step does NOT re-measure",
     /remeasure \? await redetectTempoFromLoop\(targetSlotId\) : undefined/.test(multiPage)
       && /stretchSlotToTempoAnchor\(slotId, relation\);/.test(multiPage),
     "an Essentia pass on every sweet-spot pick is a second of lag on the most-used control");
  ok("but every match path does",
     (multiPage.match(/stretchSlotToTempoAnchor\([^)]*, undefined, true\)/g) ?? []).length === 3,
     "per-slot Match Tempo, Match Tempos and re-lock are exactly when a wrong BPM becomes a wrong stretch");
  ok("the better numbers are persisted",
     /stemAnalysis: \{ \.\.\.\(fresh\.stemAnalysis \?\? \{\}\), \[role\]: \{ key, bpm \} \}/.test(multiPage),
     "otherwise the next session re-measures the middle of the file and loses both");
  // Key and tempo are measured TOGETHER now, in one pass, because both matchers want the
  // loop and Lock All runs keys then tempos — two passes per slot on identical audio.
  ok("one pass serves both matchers",
     /export async function analyzeRegion\(/.test(analysis)
       && /await analyzeRegion\(entry\.sourceBuffer, startSec, endSec\)/.test(multiPage),
     "key extraction is the expensive half; running it twice per slot doubles Lock All");
  ok("and the result is cached per slot AND per loop",
     /const cacheKey = `\$\{slotId\}\|\$\{startSec\.toFixed\(3\)\}\|\$\{endSec\.toFixed\(3\)\}`/.test(multiPage),
     "keyed by the loop too, or moving the loop would not re-measure — which is the point");
  ok("a short loop grows a window instead of failing",
     /RHYTHM_MIN_SEC = 20/.test(worker)
       && /Math\.max\(RHYTHM_MIN_SEC \* sampleRate, regionLen\)/.test(worker),
     "a four-bar loop is ~8s and rhythm extraction returns 0 below roughly 20s");
  ok("the window stays inside the track",
     /Math\.max\(0, Math\.min\(mono\.length - want, Math\.floor\(centre - want \/ 2\)\)\)/.test(worker),
     "a loop near either end would otherwise read past the buffer");
}

section("12x. the anchor can move without restretching the rack");
{
  // Once an anchor existed, every other slot's button became Match Tempo, so the only way
  // to move the anchor was to unpin the current one — which resets it to its own tempo and
  // drags every slave with it. A matched slot is already playing at the rack's tempo, so
  // handing it the anchor should cost nothing.
  ok("there is a handover path distinct from Set Tempo Anchor",
     /function handleTakeTempoAnchor\(slotId: string\)/.test(multiPage)
       && /onTakeTempoAnchor/.test(slotStrip));
  // Scoped to the function body: handleSetTempoAnchor sits directly below and legitimately
  // calls both of the things this one must not.
  const take = fnBody(multiPage, "function handleTakeTempoAnchor(slotId: string)") ?? "";
  ok("the handover body was found", take.length > 0);
  // The CALL, not the word: the body's own comment names both of these to explain why they
  // are absent, and matching the bare identifier made the rule fail on its documentation.
  ok("it does NOT reset the new anchor's stretch",
     !/reapplyStretch\(/.test(take),
     "resetting it to its own tempo is exactly the destruction this path exists to avoid");
  ok("and does NOT re-measure its tempo",
     !/redetectTempoFromLoop\(/.test(take),
     "a new BPM would change the heard tempo, which is the one thing this promises not to do");
  ok("it still persists the choice",
     /saveTempoAnchorKey\(entry\.slot\.trackId, entry\.slot\.stemName\)/.test(take),
     "an anchor that does not survive a reload is not an anchor");
  ok("the button only appears where the handover is free",
     /!isTempoAnchor && hasTempoAnchor && isTempoMatched && !tempoStale && \(/.test(slotStrip),
     "on an unmatched or stale slot the swap is NOT free, and must go through the destructive path");
  ok("Set Tempo Anchor stays destructive for an unmatched slot",
     /if \(entry && entry\.sourceBuffer && Math\.abs\(entry\.stretch - 1\) > 0\.005\)[\s\S]{0,120}reapplyStretch/.test(multiPage),
     "pinning an unmatched slot really is declaring a new tempo; everything else has to follow");
  ok("the handover button says what it does, and is always visible",
     /⚓ Make Tempo Anchor<\/button>/.test(slotStrip)
       && !/opacity-0 transition group-hover:opacity-100/.test(slotStrip),
     "a bare anchor glyph revealed only on hover was never found — it sits beside two "
     + "labelled anchor buttons, so unlabelled reads as decoration");
}

section("12y. key matching compares keys, not letters");
{
  // Reading only the letter made C major and A minor look nine semitones apart. They are
  // the same notes. The A-minor stem was shifted down nine into C minor, clashing on the
  // third — and roughly half of all pairs are a major against a minor, so about half of
  // every key match was wrong in exactly that way.
  const analysis = read("lib/audioAnalysis.ts");
  ok("a minor key folds to its relative major",
     /scale\.startsWith\("min"\) \? \(s \+ 3\) % 12 : s/.test(analysis),
     "the Camelot fold — without it relative keys are transposed apart");
  ok("a low-confidence key is treated as no key",
     /if \(scale\.endsWith\("\?"\)\) return null;/.test(analysis),
     "Essentia marks an unsure detection with ?; the rule was documented but never implemented");
  ok("the shift takes the shortest way round",
     /const shortest = \(\(raw \+ 6\) % 12 \+ 12\) % 12 - 6;/.test(multiPage),
     "an 11-semitone drop to reach a note one semitone up is an octave of artefacts for nothing");
  ok("and is still applied relative to the reference's own pitch",
     /pitch = refEntry\.slot\.pitch - shortest;/.test(multiPage),
     "the reference may itself be shifted; ignoring that matches to the wrong key");
  // Worked examples, so the fold cannot silently invert.
  const sem = (key) => {
    const parts = key.trim().split(/\s+/);
    const scale = (parts[1] ?? "").toLowerCase();
    if (scale.endsWith("?")) return null;
    const table = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
    const s = table[parts[0]];
    if (s === undefined) return null;
    return scale.startsWith("min") ? (s + 3) % 12 : s;
  };
  ok("C major and A minor need no shift", sem("C major") === sem("A minor"));
  ok("G major and E minor need no shift", sem("G major") === sem("E minor"));
  ok("C major and C minor are NOT the same", sem("C major") !== sem("C minor"),
     "same letter, different notes — this is the pair the old code got right by accident");
  ok("an unsure key yields nothing", sem("C major?") === null);
}

section("12z. key extraction gets the same treatment as tempo");
{
  // It did not crash the way rhythm extraction did — it just averaged chroma across the
  // whole track (intro, breakdown, outro, any key change), returned a strength under the
  // 0.2 floor, and the result was thrown away. Every stem in a 131-slot library came back
  // with no key, which is why Match Key appeared to do nothing at all.
  const worker = read("workers/audioAnalysisWorker.ts");
  ok("both passes share one windowing rule",
     /function sliceAround\(/.test(worker)
       && (worker.match(/sliceAround\(/g) ?? []).length >= 3,
     "two copies of the window drift apart, and then key and tempo describe different audio");
  ok("key runs on the slice, not the whole file",
     /const keySlice = tempoOnly \? null : sliceAround\(mono, sampleRate, region\)/.test(worker));
  ok("the window is still centred, not taken from the start",
     /const centre = region \? \(\(region\.startSec \+ region\.endSec\) \/ 2\)/.test(worker),
     "intros are often sparse or beatless, and for key, often silent");
}

section("12aa. an unmatched slot is not told a stretch it cannot know");
{
  // The merged dropdown is deliberately offered before a slot is matched, because picking a
  // row performs the match. But the figures beside each row are derived from the relation
  // alone — current stretch x (current relation / the row's) — and on an unmatched slot
  // that is 1 x (1/1), so every row advertised a tidy 100% / 200% / 50% no matter how far
  // apart the tempos really were. The old relation picker was matched-only for this reason.
  ok("the stretch figure withdraws until matched",
     /stretchPct: isTempoMatched && stretch > 0 && effectiveRelation > 0/.test(slotStrip),
     "on an unmatched slot the number is not merely unknown, it is confidently wrong");
  ok("so does the recommended tag",
     /isTempoMatched && r\.value === autoRelation \? "recommended" : null/.test(slotStrip),
     "it names the least-stretch row, which is exactly what is not yet known");
  ok("off-grid is NOT withheld",
     /!r\.gridSafe \? "off-grid" : null/.test(slotStrip),
     "that one is a property of the relation itself and true whether or not anything is matched");
  ok("the memo recomputes when matched state changes",
     /\}, \[gridBpm, stretch, effectiveRelation, isTempoMatched\]\);/.test(slotStrip),
     "otherwise the figures stay hidden through the match that should reveal them");
}

section("12ab. pinning the anchor locks its own loop in");
{
  // The anchor's loop is the bar every other loop is rounded against, so it has to be a
  // whole number of bars itself. Match Tempos always quantized it; Set Tempo Anchor did
  // not — so a rack that was pinned and simply played drifted, with a 3.8-bar anchor loop
  // and nothing on screen to explain it.
  ok("setting the anchor quantizes its loop",
     /redetectAnchorTempo\(entry\.slot\.id\)\.then\(\(\) => \{[\s\S]{0,200}quantizeAllToAnchorGrid\(entry\.slot\.id\)/.test(multiPage));
  ok("and does it AFTER re-reading the tempo",
     !/quantizeAllToAnchorGrid\(entry\.slot\.id\);[\s\S]{0,160}redetectAnchorTempo/.test(multiPage),
     "quantize rounds to the detected BPM, so running it first rounds to the number being replaced");
  ok("only while this slot is still the anchor",
     /if \(tempoAnchorIdRef\.current === entry\.slot\.id\) quantizeAllToAnchorGrid/.test(multiPage),
     "detection is async; the anchor may have moved, and quantize has no undo");
  ok("it quantizes ONLY that slot",
     /quantizeAllToAnchorGrid\(entry\.slot\.id\)/.test(multiPage),
     "the bare call rounds every loop in the rack — pinning an anchor must not rewrite slots the user never touched");
}

section("12ac. the key anchor moves the same way, and touches no audio");
{
  ok("there is a key handover distinct from Set Key Anchor",
     /function handleTakeReference\(slotId: string\)/.test(multiPage)
       && /⚓ Make Key Anchor<\/button>/.test(slotStrip));
  const take = fnBody(multiPage, "function handleTakeReference(slotId: string)") ?? "";
  ok("the key handover body was found", take.length > 0);
  ok("it does NOT clear everyone's matched flag",
     !/isMatched: false/.test(take),
     "handleSetReference drops every badge, which invites a re-match that moves pitches — "
     + "but a slot already in the anchor's key is already in the right key");
  ok("it touches no audio at all",
     !/updateSlot\(/.test(take) && !/reapplyStretch\(/.test(take),
     "that is what makes the key handover even safer than the tempo one");
  ok("it persists the choice", /saveAnchorKey\(entry\.slot\.trackId, entry\.slot\.stemName\)/.test(take));
  ok("the button only appears where the handover is free",
     /!isReference && hasReference && isMatched && \(/.test(slotStrip),
     "on an unmatched slot the new anchor is NOT in the rack's key, so the swap is not free");
  ok("Set Key Anchor still clears the badges",
     /isMatched: false/.test(fnBody(multiPage, "function handleSetReference(slotId: string)") ?? ""),
     "pinning an unmatched slot really is declaring a new key; nothing is matched to it yet");
}

section("12ad. Essentia actually loads in the worker");
{
  // THE bug behind "key matching does nothing" and "every BPM is a guess". Emscripten
  // detects its environment by probing for `importScripts`. A MODULE worker does not have
  // that — it is a classic-worker API — so Essentia concluded it was running on a page and
  // reached for `document.currentScript`. A worker has no document either, so it threw on
  // the first line of loading. A bare `catch` swallowed it, every analysis returned
  // {key: null, bpm: undefined} in ~50ms, and nothing anywhere said a word. 131 saved slots
  // across 32 sessions, not one with a key or a tempo.
  const worker = read("workers/audioAnalysisWorker.ts");
  ok("the document stub is in place",
     /if \(typeof g\.document === 'undefined'\) g\.document = \{ currentScript: null \};/.test(worker),
     "without it Essentia throws before loading and the whole analysis feature is dead");
  ok("it is set BEFORE the dynamic import",
     /g\.document = \{ currentScript: null \};[\s\S]{0,200}await Promise\.all\(\[[\s\S]{0,80}import\('essentia/.test(worker),
     "the throw happens during module evaluation, so a stub set afterwards is too late");
  ok("a load failure is now loud",
     /console\.error\('\[analysis\] Essentia failed to load:'/.test(worker),
     "a silent catch here can hide a total outage of both key and tempo detection");
  ok("the worker stays a module worker",
     /type: 'module'/.test(read("lib/audioAnalysis.ts")),
     "invariant 27: the dynamic import forces a code-split, which an IIFE worker cannot do — "
     + "becoming a classic worker to dodge the stub would break the production build");
}

section("12ae. key matching measures the loop too");
{
  // Symmetry with tempo, and for the same reason: load-time detection reads the middle of
  // the file, and the loop is the part actually being played.
  ok("matching a slot measures both sides first",
     /await redetectFromLoop\(referenceSlotIdRef\.current\);[\s\S]{0,80}await redetectFromLoop\(targetSlotId\);/.test(multiPage),
     "comparing a loop-measured key against a file-measured one is a mismatch of its own");
  ok("setting the key anchor measures it from its loop",
     /saveAnchorKey\(entry\.slot\.trackId, entry\.slot\.stemName\);[\s\S]{0,200}void redetectFromLoop\(newRefId\)/.test(multiPage),
     "same moment and same reasoning as Set Tempo Anchor");
  ok("Match Keys snapshots ids before awaiting",
     /const ids = entriesRef\.current[\s\S]{0,160}for \(const id of ids\) \{[\s\S]{0,120}await matchSlotToReference\(id\)/.test(multiPage),
     "matchSlotToReference now awaits an analysis pass, and entriesRef is rebuilt on every render between iterations");
  ok("and yields so each iteration sees the last one's commit",
     /await matchSlotToReference\(id\);[\s\S]{0,160}await new Promise\(\(r\) => setTimeout\(r, 0\)\);/.test(multiPage));
  ok("the handover path still measures nothing",
     !/redetectFromLoop/.test(fnBody(multiPage, "function handleTakeReference(slotId: string)") ?? ""),
     "a new key would change what the rack is matched to, which is what that path promises not to do");
}

section("12af. Throw lands on a hit, not on the click");
{
  // Fired the instant a finger lands, a throw catches whatever happened to be sounding,
  // which is almost never the hit you wanted. Guessing a grid position does not fix it:
  // "next beat" catches kicks half the time and "next half-bar" assumes a snare on the 3.
  ok("there is a hit finder",
     /export function findHits\(buffer: AudioBuffer, startSec: number, endSec: number\)/.test(loopSnap));
  ok("it high-passes before looking",
     /const d = data\[i\] - data\[i - 1\];/.test(loopSnap),
     "a first difference collapses a kick's sub-bass and leaves a snare's body — that is the whole trick");
  ok("it only keeps local maxima well above average",
     /if \(flux\[f\] < flux\[f - 1\] \|\| flux\[f\] < flux\[f \+ 1\]\) continue;/.test(loopSnap)
       && /const threshold = mean \* 3;/.test(loopSnap),
     "without both, a steady hat pattern qualifies every frame and the throw never waits for anything");
  ok("and merges hits closer than one attack",
     /minGapFrames/.test(loopSnap),
     "a snare's attack spans several frames; each would otherwise count as its own hit");
  ok("the wait is converted out of buffer seconds",
     /const aheadFile = next !== undefined[\s\S]{0,200}return aheadFile \/ rate;/.test(engine),
     "hits and the playhead are in buffer seconds, the scheduler is in wall clock — the gap is "
     + "wrong by exactly the playback rate without this");
  ok("it looks past the loop end by wrapping",
     /loopDur - \(pos - inLoop\[0\]\)/.test(engine),
     "past the last hit in the loop, the next one to arrive is the first one after the wrap");
  ok("a sparse stem cannot swallow the gesture",
     /THROW_MAX_WAIT_SEC = 1\.2/.test(engine)
       && /wait <= MultiEngine\.THROW_MAX_WAIT_SEC \? wait : 0/.test(engine),
     "past the cap it fires immediately, which is the behaviour it always had");
  ok("the gate opens AT the hit, not at the click",
     /slot\.throwSend\.gain\.rampTo\(1, 0\.02, now\)/.test(engine),
     "rampTo without an explicit time starts immediately and undoes the whole feature");
  ok("and stays open for its full length from the hit",
     /\}, \(lead \+ 0\.4\) \* 1000\);/.test(engine),
     "measuring the 400ms from the click would cut the burst short by however long it waited");
  ok("the button shows it is waiting",
     /throwArmed \? "↯ Waiting…" : "↯ Throw"/.test(slotStrip),
     "up to 1.2s of nothing after a press reads as a broken button");
  ok("armed and active are distinguishable",
     /throwArmed[\s\S]{0,160}animate-pulse/.test(slotStrip));
  ok("the scan is not in a render path",
     /useEffect\(\(\) => \{\s*if \(!buffer\) return;\s*multiEngine\.setHits\(slot\.id, findHits\([\s\S]{0,120}\}, \[buffer, slot\.loopStart, slot\.loopEnd, slot\.id\]\);/.test(slotStrip),
     "it is a full pass over the region; the engine poll next to it runs every 100ms");
}

section("12ag. the throw's delay follows the tempo");
{
  // Throw character was already a proper dub throw — feedback 0.72, fully wet, 3.5s reverb,
  // a 700Hz filter. The delay TIME was the one value that ignored the music: a fixed 250ms
  // whatever was playing, so the repeats never sat on the beat.
  ok("only the delay time is derived",
     /const delayTime = beats \* beatSec;[\s\S]{0,200}\{ \.\.\.ts, delayTime \}/.test(multiPage),
     "feedback, wet, decay and filter are character, not length — tempo has no business moving them");
  ok("the untouched default becomes a dotted eighth",
     /untouched \? 0\.75 : null/.test(multiPage)
       && /Math\.abs\(ts\.delayTime - DEFAULT_THROW_SETTINGS\.delayTime\) < 1e-6/.test(multiPage),
     "the stored 0.25s is not a division of anything, so 'preserve the division' would leave it "
     + "tempo-blind forever — treat never-set as never-set");
  ok("a division the user chose is carried across tempo changes",
     /const beats = onGrid \? atPrev\.beats :/.test(multiPage),
     "picking a triplet and then changing tempo should still be a triplet");
  ok("a deliberately free time is left exactly where it is",
     /if \(beats === null\) return;/.test(multiPage),
     "same rule as every other delay in this app: off-grid means chosen, not stale");
  ok("it is debounced",
     /window\.setTimeout\([\s\S]{0,1400}\}, 400\);[\s\S]{0,120}\[anchorEffectiveBpm\]/.test(multiPage),
     "master speed and the anchor's Speed move the heard tempo every frame of a drag; "
     + "rewriting a delay time per frame is audible as warbling (gotcha 32)");
}

section("13. expensive analysis is memoised");
{
  ok("estimateBpm results are cached", /WeakMap/.test(multiPage) && /sourceBpm/.test(multiPage),
     "~30ms per call; uncached it stalls every render");
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
