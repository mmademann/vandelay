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
const render    = read("audio/renderMulti.ts");
const loopSnap  = read("lib/loopSnap.ts");
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
     /stretchSlotToTempoAnchor\((?!.*,)/.test(relock ?? "") || /stretchSlotToTempoAnchor\(id\)/.test(relock ?? ""),
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
  ok("it carries the playhead with the region", /nudgeSlot/.test(mv ?? ""),
     "updateSlot preserves absolute position, so without this the playhead jumps musically and a large move leaves it outside the loop");
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

section("13. expensive analysis is memoised");
{
  ok("estimateBpm results are cached", /WeakMap/.test(multiPage) && /sourceBpm/.test(multiPage),
     "~30ms per call; uncached it stalls every render");
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
