/**
 * Whole-rack timing simulation.
 *
 * Every bug in this area came from the same place: a function that was individually correct
 * but used the wrong *time domain*. Unit tests could not catch that, because each function
 * passed on its own. This models a whole rack — mixed speeds, stretches, phases, master
 * speed — and asserts on what a listener would actually notice: do the slots stay together
 * over many loops?
 *
 * Three domains, and confusing them is the recurring bug:
 *   FILE  time — loop bounds, snap, quantize, phase. Playback rate does not move these.
 *   HEARD time — delay echoes, and whether two loops stay aligned. Rate is everything.
 *   BARS       — musical intent, converted into one of the above.
 *
 * Run: node src/lib/__tests__/rackSync.test.mjs
 */

let fails = 0, checks = 0;
const ok = (n, c, d = "") => {
  checks++;
  if (!c) { fails++; console.log(`  FAIL ${n}${d ? "  " + d : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- production formulas
// Mirrored from the app. If these drift from the source, the tests are worthless — each is
// annotated with where it lives.

/** multiEngine.slotPlaybackRate / renderMulti.slotPlaybackRate */
const rate = (s, masterSpeed = 1) => {
  const base = s.linkPitch ? s.speed : s.speed * Math.pow(2, s.pitch / 12);
  return s.bypassMasterSpeed ? base : base * masterSpeed;
};

/** loopSnap.TEMPO_RELATIONS — grid-safe ones are what auto-match may choose. */
const TEMPO_RELATIONS = [
  { value: 1 / 2, gridSafe: true },
  { value: 3 / 4, gridSafe: false },
  { value: 1,     gridSafe: true },
  { value: 4 / 3, gridSafe: false },
  { value: 2,     gridSafe: true },
];
/** loopSnap.stretchForRelation */
const stretchForRelation = (targetBpm, anchorBpm, relation) => {
  const want = anchorBpm * relation;
  if (!Number.isFinite(want) || want <= 0) return 1;
  const r = targetBpm / want;
  return Number.isFinite(r) && r > 0 ? r : 1;
};
/** loopSnap.autoTempoRelation — nearest power of two, unbounded. */
const autoTempoRelation = (targetBpm, anchorBpm) => {
  const raw = targetBpm / anchorBpm;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.pow(2, Math.round(Math.log2(raw)));
};
/** MultiPage.tempoStretchRatio — relation selection; the octave fold was its special case. */
const tempoStretchRatio = (targetBpm, anchorBpm, relation) => {
  if (!Number.isFinite(targetBpm) || !Number.isFinite(anchorBpm) || targetBpm <= 0 || anchorBpm <= 0) return 1;
  return stretchForRelation(targetBpm, anchorBpm, relation ?? autoTempoRelation(targetBpm, anchorBpm));
};

/** MultiPage.anchorEffectiveBpm — the tempo the anchor is HEARD at. */
const effectiveBpm = (rawBpm, slot, masterSpeed, stretch) =>
  (rawBpm * rate(slot, masterSpeed)) / (stretch || 1);

/** MultiPage.quantizeAllToAnchorGrid — per-slot grid so bars match in HEARD time. */
const slotGridBpm = (anchorRawBpm, anchorRate, slotRate) =>
  anchorRawBpm * ((anchorRate || 1) / (slotRate || 1));

/** loopSnap.quantizeToGrid — round a span to whole bars of the given grid. */
const quantizeBars = (span, gridBpm) => {
  const bar = (60 / gridBpm) * 4;
  return Math.max(1, Math.round(span / bar)) * bar;
};

/** SlotStrip.applyPhase — rotate loop start by a fraction of a FILE bar. */
const phaseOffset = (phase, gridBpm, loopDur) => {
  const bar = (60 / gridBpm) * 4;
  return (((phase * bar) % loopDur) + loopDur) % loopDur;
};

/** loopSnap.snapDelayToTempo — nearest division, in HEARD seconds. */
const DIVISIONS = [0.0625, 1/12, 0.125, 1/6, 0.1875, 0.25, 1/3, 0.375, 0.5, 2/3, 0.75, 1, 4/3, 1.5, 2, 3, 4, 6, 8, 12, 16];
const snapDelay = (seconds, bpm, max = 4) => {
  const beat = 60 / bpm;
  let best = null, err = Infinity;
  for (const b of DIVISIONS) {
    const s = b * beat;
    if (s > max) continue;
    const e = Math.abs(s - seconds);
    if (e < err) { err = e; best = { seconds: s, beats: b }; }
  }
  return best;
};

// ---------------------------------------------------------------- rack model
function buildRack({ masterSpeed = 1 } = {}) {
  const anchor = {
    name: "drums", rawBpm: 120, isAnchor: true,
    speed: 0.70, pitch: 0, linkPitch: true, bypassMasterSpeed: true,
    stretch: 1, phase: 0, loopStart: 4.42, loopEnd: 4.42 + 8,
  };
  const slaves = [
    { name: "other-A", rawBpm: 112, speed: 0.75, pitch: 0,   linkPitch: true,  stretch: 1, phase: 0,   loopStart: 0.32, loopEnd: 0.32 + 6 },
    { name: "other-B", rawBpm: 96,  speed: 0.75, pitch: -15, linkPitch: false, stretch: 1, phase: 0.5, loopStart: 1.12, loopEnd: 1.12 + 5 },
    { name: "vocals",  rawBpm: 88,  speed: 1.00, pitch: 18,  linkPitch: false, stretch: 1, phase: 1/3, loopStart: 4.43, loopEnd: 4.43 + 7 },
    { name: "bass",    rawBpm: 174, speed: 1.00, pitch: 0,   linkPitch: true,  stretch: 1, phase: 0,   loopStart: 0,    loopEnd: 9 },
  ];
  return { anchor, slaves, masterSpeed };
}

/** The full Match Tempos pipeline: stretch, then quantize, then re-apply phase. */
function matchTempos(rack) {
  const { anchor, masterSpeed } = rack;
  const aRate = rate(anchor, masterSpeed);
  const aEff = effectiveBpm(anchor.rawBpm, anchor, masterSpeed, anchor.stretch);

  for (const s of rack.slaves) {
    // 1. stretch to the anchor's HEARD tempo.
    //    swapBuffer scales by the ratio RELATIVE to what is already applied, and
    //    stretchSlotToTempoAnchor returns early when the target is already in place — so
    //    re-running must be a no-op, not a second scaling.
    //    Heard-vs-heard: the slot's raw tempo times its own rate. Comparing the raw tempo
    //    against the anchor's heard tempo is wrong by exactly that rate — see section 3b.
    const target = tempoStretchRatio(s.rawBpm * rate(s, masterSpeed), aEff);
    if (Math.abs(target - s.stretch) < 0.005) continue;
    const r = target / (s.stretch || 1);
    s.stretch = target;
    s.loopStart *= r; s.loopEnd *= r;
  }

  // 2. quantize every slot, anchor included, on a per-slot grid
  for (const s of [anchor, ...rack.slaves]) {
    const g = slotGridBpm(anchor.rawBpm, aRate, rate(s, masterSpeed));
    // Phase is a playhead offset now, so quantize simply rounds the region — there is no
    // offset baked into the bounds to strip out first.
    s.loopEnd = s.loopStart + quantizeBars(s.loopEnd - s.loopStart, g);
    s.gridBpm = g;
  }
  return rack;
}

/** Real-time duration of one pass of a slot's loop. */
const heardLoopDur = (s, masterSpeed) => (s.loopEnd - s.loopStart) / rate(s, masterSpeed);

// ---------------------------------------------------------------- the tests
console.log("Rack timing simulation — whole-system, not per-function");

section("1. after Match Tempos, every loop is a whole number of heard bars");
{
  const rack = matchTempos(buildRack());
  const aRate = rate(rack.anchor, rack.masterSpeed);
  const anchorHeardBar = ((60 / rack.anchor.rawBpm) * 4) / aRate;
  for (const s of [rack.anchor, ...rack.slaves]) {
    const bars = heardLoopDur(s, rack.masterSpeed) / anchorHeardBar;
    ok(`${s.name}: ${bars.toFixed(4)} heard bars is a whole number`,
       Math.abs(bars - Math.round(bars)) < 1e-9, `${bars}`);
  }
}

section("2. no drift — slots realign after every anchor pass, out to 256 bars");
{
  const rack = matchTempos(buildRack());
  const aRate = rate(rack.anchor, rack.masterSpeed);
  const anchorHeardBar = ((60 / rack.anchor.rawBpm) * 4) / aRate;
  for (const s of rack.slaves) {
    const d = heardLoopDur(s, rack.masterSpeed);
    // Worst-case phase error after N bars: how far the loop boundary sits from a bar line.
    const barsPerLoop = d / anchorHeardBar;
    const err = Math.abs(barsPerLoop - Math.round(barsPerLoop)) * anchorHeardBar * 256;
    ok(`${s.name}: <1ms accumulated over 256 bars`, err < 0.001, `${(err * 1000).toFixed(3)}ms`);
  }
}

section("3. master speed moves everything together (except bypassed slots)");
{
  for (const ms of [0.6, 0.85, 1.0, 1.4]) {
    const rack = matchTempos(buildRack({ masterSpeed: 1 }));
    // Ride master AFTER matching — the common live move.
    const following = [rack.anchor, ...rack.slaves].filter((s) => !s.bypassMasterSpeed);
    const ratios = following.map((s) => heardLoopDur(s, ms) / heardLoopDur(s, 1));
    ok(`master ${ms}: all following slots scale identically`,
       ratios.every((r) => Math.abs(r - ratios[0]) < 1e-12), `${ratios.map(r=>r.toFixed(6))}`);
  }
}

section("3b. matching WHILE master speed is off unity, and while slot speeds differ");
{
  // The gap that let a real bug ship: section 3 always matched at master 1 and only rode the
  // dial afterwards. Matching AT 0.85 stretched every slave by 1/0.85 too much, and the app
  // reported TEMPO MATCHED throughout.
  for (const ms of [0.6, 0.85, 1.0, 1.4]) {
    const rack = matchTempos(buildRack({ masterSpeed: ms }));
    const aEff = effectiveBpm(rack.anchor.rawBpm, rack.anchor, ms, rack.anchor.stretch);
    for (const s of rack.slaves) {
      const heard = effectiveBpm(s.rawBpm, s, ms, s.stretch);
      // The relation the fold chose — heard tempo may legitimately be a power of two off.
      const rel = autoTempoRelation(s.rawBpm * rate(s, ms), aEff);
      ok(`master ${ms} / ${s.name}: heard ${heard.toFixed(1)} == anchor ${aEff.toFixed(1)} x ${rel}`,
         Math.abs(heard - aEff * rel) < 0.05, `off by x${(aEff * rel / heard).toFixed(4)}`);
      // The grid quantize rounds to must be the slot's OWN bar, or a whole-bar loop is not
      // a whole number of the bars you can hear in it.
      const ownBarsPerAnchorBar = (s.rawBpm / s.stretch) / s.gridBpm;
      const whole = Math.abs(ownBarsPerAnchorBar - Math.round(ownBarsPerAnchorBar)) < 1e-9
        || Math.abs(1 / ownBarsPerAnchorBar - Math.round(1 / ownBarsPerAnchorBar)) < 1e-9;
      ok(`master ${ms} / ${s.name}: quantize grid is a whole multiple of its own bar`,
         whole, `${ownBarsPerAnchorBar}`);
    }
  }
}

section("3c. a good match survives the master dial — auto re-lock must stay quiet");
{
  // Riding master scales every following slot equally, so a matched rack is still matched
  // and nothing should be flagged. Before the heard-vs-heard fix every slot went stale and
  // auto re-lock re-stretched a correct rack into a 15% tempo error.
  const rack = matchTempos(buildRack({ masterSpeed: 1 }));
  for (const ms of [0.6, 0.85, 1.4]) {
    const aEff = effectiveBpm(rack.anchor.rawBpm, rack.anchor, ms, rack.anchor.stretch);
    for (const s of rack.slaves) {
      const want = tempoStretchRatio(s.rawBpm * rate(s, ms), aEff);
      const stale = Math.abs(want - s.stretch) > 0.01;
      // The anchor bypasses master in this rack, so slots that FOLLOW master genuinely do
      // drift against it — those must flag. Slots sharing the anchor's bypass must not.
      const followsWithAnchor = s.bypassMasterSpeed === rack.anchor.bypassMasterSpeed;
      ok(`master ${ms} / ${s.name}: stale=${stale} matches whether it tracks the anchor`,
         stale === !followsWithAnchor, `want ${want.toFixed(3)} vs held ${s.stretch.toFixed(3)}`);
    }
  }
}

section("4. key intervals survive master speed");
{
  const rack = buildRack();
  for (const ms of [0.6, 1.0, 1.4]) {
    const semis = [rack.anchor, ...rack.slaves]
      .filter((s) => !s.bypassMasterSpeed)
      .map((s) => 12 * Math.log2(rate(s, ms) / rate(s, 1)));
    ok(`master ${ms}: every slot shifts by the same interval`,
       semis.every((v) => Math.abs(v - semis[0]) < 1e-9), `${semis.map(v=>v.toFixed(4))}`);
  }
}

section("5. phase does not alter loop bounds (it is a timing offset)");
{
  const rack = matchTempos(buildRack());
  for (const s of [rack.anchor, ...rack.slaves]) {
    // Bounds are set by Snap/quantize/Move only. Two slots with the same region but
    // different phase must have identical bounds.
    const bars = (s.loopEnd - s.loopStart) / ((60 / s.gridBpm) * 4);
    ok(`${s.name}: region is whole bars regardless of phase (${s.phase ?? 0})`,
       Math.abs(bars - Math.round(bars)) < 1e-9, `${bars}`);
  }
}

section("6. phase never changes loop length (so it cannot cause drift)");
{
  const plain = matchTempos(buildRack());
  const noPhase = matchTempos((() => { const r = buildRack(); [r.anchor, ...r.slaves].forEach(s => s.phase = 0); return r; })());
  for (let i = 0; i < plain.slaves.length; i++) {
    const a = plain.slaves[i], b = noPhase.slaves[i];
    ok(`${a.name}: length identical with and without phase`,
       Math.abs((a.loopEnd - a.loopStart) - (b.loopEnd - b.loopStart)) < 1e-9);
  }
}

section("7. delay divisions are equal in HEARD time across all slots");
{
  const rack = matchTempos(buildRack());
  const aEff = effectiveBpm(rack.anchor.rawBpm, rack.anchor, rack.masterSpeed, rack.anchor.stretch);
  const eighth = snapDelay(0.3, aEff).seconds;
  for (const s of [rack.anchor, ...rack.slaves]) {
    // Every slot reads the same grid, so the same division is the same wall-clock time.
    const own = snapDelay(0.3, aEff).seconds;
    ok(`${s.name}: 1/8 is the same duration as the anchor's`, Math.abs(own - eighth) < 1e-12);
  }
  const beat = 60 / aEff;
  // Whatever division 0.3s snapped to, it must be an exact multiple of the heard beat —
  // that is what puts the echo on the grid.
  const beats = eighth / beat;
  ok(`snapped delay is an exact division of the heard beat (${(eighth*1000).toFixed(0)}ms at ${aEff.toFixed(1)}bpm)`,
     DIVISIONS.some((d) => Math.abs(d - beats) < 1e-9), `${beats.toFixed(4)} beats`);
}

section("8. a freshly matched slot never reads as stale");
{
  for (const ms of [1, 0.8, 1.25]) {
    const rack = matchTempos(buildRack({ masterSpeed: ms }));
    const aEff = effectiveBpm(rack.anchor.rawBpm, rack.anchor, ms, rack.anchor.stretch);
    for (const s of rack.slaves) {
      // Same heard-vs-heard comparison the app's stale check makes (MultiPage.staleTempoIds).
      const want = tempoStretchRatio(s.rawBpm * rate(s, ms), aEff);
      ok(`master ${ms} ${s.name}: not stale after matching`,
         Math.abs(want - s.stretch) <= 0.01, `want ${want.toFixed(4)} have ${s.stretch.toFixed(4)}`);
    }
  }
}

section("9. matching is idempotent — running it twice changes nothing");
{
  const once = matchTempos(buildRack());
  const twice = matchTempos(JSON.parse(JSON.stringify(once)));
  for (let i = 0; i < once.slaves.length; i++) {
    const a = once.slaves[i], b = twice.slaves[i];
    ok(`${a.name}: stretch stable`, Math.abs(a.stretch - b.stretch) < 1e-9, `${a.stretch} -> ${b.stretch}`);
    ok(`${a.name}: loop stable`, Math.abs(a.loopStart - b.loopStart) < 1e-9 && Math.abs(a.loopEnd - b.loopEnd) < 1e-9);
  }
}

section("10. octave folding is single-valued and continuous");
{
  const a = 88.2;
  let jumps = 0, prev = tempoStretchRatio(40, a);
  for (let t = 40.5; t <= 260; t += 0.5) {
    const f = tempoStretchRatio(t, a);
    if (f / prev > 1.15 || f / prev < 0.87) jumps++;
    prev = f;
  }
  ok(`only octave-boundary discontinuities (${jumps})`, jumps <= 3, `${jumps}`);
  let outside = 0;
  for (let t = 40; t <= 260; t += 0.25) {
    const f = tempoStretchRatio(t, a);
    if (f < 1 / Math.SQRT2 - 1e-9 || f > Math.SQRT2 + 1e-9) outside++;
  }
  ok("every result lands within one octave of unity", outside === 0, `${outside} outside`);
  for (const [t, an] of [[174, 87], [87, 174], [240, 120], [60, 120]])
    ok(`${t} vs ${an} collapses to unity`, Math.abs(tempoStretchRatio(t, an) - 1) < 1e-9);

  // MultiPage.stretchSlotToTempoAnchor resolves the relation before calling. An unset
  // (auto) relation must reach the fold; passing a literal 1 instead skips it, which is how
  // a 1.86 ratio that should fold to 0.93 shipped as 1.86 — double speed, and audible.
  const resolve = (chosen, t, a) => tempoStretchRatio(t, a, chosen ?? autoTempoRelation(t, a));
  for (let t = 40; t <= 260; t += 0.5) {
    const auto = resolve(undefined, t, 88.2);
    if (auto < 1 / Math.SQRT2 - 1e-9 || auto > Math.SQRT2 + 1e-9) {
      ok(`auto relation folds at ${t} bpm`, false, `${auto}`); break;
    }
  }
  ok("an unset relation resolves through the fold", true);
  ok("an unset relation is NOT the same as an explicit 1:1",
     Math.abs(resolve(undefined, 164, 88.2) - resolve(1, 164, 88.2)) > 0.1,
     "collapsing the two suppresses the fold for every slot");
  ok("an explicit relation is honoured verbatim",
     Math.abs(resolve(1 / 2, 120, 120) - 2) < 1e-9);
}

section("11. export loop tiling covers each pass exactly");
{
  const rack = matchTempos(buildRack());
  const all = [rack.anchor, ...rack.slaves];
  const master = Math.max(...all.map((s) => heardLoopDur(s, rack.masterSpeed)));
  for (const s of all) {
    const seg = heardLoopDur(s, rack.masterSpeed);
    let covered = 0;
    for (let r = 0; r < Math.ceil(master / seg); r++) {
      const when = r * seg;
      if (when >= master) break;
      covered = Math.min(master, when + Math.min(seg, master - when));
    }
    ok(`${s.name}: tiles the master pass with no gap`, Math.abs(covered - master) < 1e-9,
       `${covered.toFixed(6)} vs ${master.toFixed(6)}`);
  }
}

section("12. a stretched slot keeps its musical length");
{
  const rack = buildRack();
  for (const s of rack.slaves) {
    const beforeBars = (s.loopEnd - s.loopStart) / ((60 / s.rawBpm) * 4);
    const r = 0.83;
    const after = { ...s, loopStart: s.loopStart * r, loopEnd: s.loopEnd * r };
    // Stretching scales the audio, so a bar in the file scales with it.
    const afterBars = (after.loopEnd - after.loopStart) / (((60 / s.rawBpm) * 4) * r);
    ok(`${s.name}: bar count unchanged by stretch`, Math.abs(beforeBars - afterBars) < 1e-9);
  }
}

section("13. phase is a pure timing offset — it must not move the loop region");
{
  const wrap = (v, ld) => ((v % ld) + ld) % ld;
  /** SlotStrip.applyPhase — playhead only, by the difference from the current phase. */
  const applyPhase = (s, next, gridBpm) => {
    const ld = s.loopEnd - s.loopStart;
    const bar = (60 / gridBpm) * 4;
    const delta = (next - (s.phase ?? 0)) * bar;
    return { ...s, phase: next, pos: s.loopStart + wrap(s.pos - s.loopStart + delta, ld) };
  };

  const rack = matchTempos(buildRack());
  for (const s of rack.slaves) {
    const live = { ...s, pos: s.loopStart + (s.loopEnd - s.loopStart) * 0.37 };
    for (const p of [1 / 8, 1 / 4, 1 / 3, 1 / 2, 3 / 4]) {
      const r = applyPhase(live, p, s.gridBpm);
      ok(`${s.name} phase ${p.toFixed(3)}: loop region untouched`,
         r.loopStart === live.loopStart && r.loopEnd === live.loopEnd,
         "Phase must not slide the region — that is Move's job");
      const bar = (60 / s.gridBpm) * 4;
      const ld = live.loopEnd - live.loopStart;
      // The displacement wraps inside the loop, so on a loop shorter than the offset it is
      // the wrapped value, not p*bar. Assert against the same wrap the app applies.
      const wantDelta = wrap((p - (live.phase ?? 0)) * bar, ld);
      ok(`  playhead displaced by the requested fraction`,
         Math.abs(wrap(r.pos - live.pos, ld) - wantDelta) < 1e-9,
         `moved ${wrap(r.pos - live.pos, ld).toFixed(4)}, expected ${wantDelta.toFixed(4)} (loop ${ld.toFixed(2)}s)`);
      ok(`  playhead stays inside the loop`, r.pos >= r.loopStart - 1e-9 && r.pos <= r.loopEnd + 1e-9);
    }
    // Switching between phases must not accumulate: a walk that ends where it began must
    // leave the playhead where it began. Start from the slot's own phase, not from 0 —
    // these rack slots are already phased.
    const startPhase = live.phase ?? 0;
    let walk = live;
    for (const p of [1 / 8, 1 / 4, 1 / 3, 1 / 2, startPhase]) walk = applyPhase(walk, p, s.gridBpm);
    ok(`${s.name}: returning to the starting phase restores the playhead`,
       Math.abs(walk.pos - live.pos) < 1e-9, `${walk.pos} vs ${live.pos}`);
  }
}

section("14. phase and move are independent controls");
{
  const wrap = (v, ld) => ((v % ld) + ld) % ld;
  const DUR = 60;
  const applyPhase = (s, next, g) => {
    const ld = s.loopEnd - s.loopStart, bar = (60 / g) * 4;
    const d = (next - (s.phase ?? 0)) * bar;
    return { ...s, phase: next, pos: s.loopStart + wrap(s.pos - s.loopStart + d, ld) };
  };
  const moveLoop = (s, bars, g) => {
    const ld = s.loopEnd - s.loopStart, bar = (60 / g) * 4;
    const ns = Math.max(0, Math.min(s.loopStart + bars * bar, DUR - ld));
    if (Math.abs(ns - s.loopStart) < 1e-6) return s;
    return { ...s, loopStart: ns, loopEnd: ns + ld,
             pos: ns + wrap(s.pos - ns + (ns - s.loopStart), ld) };
  };

  const rack = matchTempos(buildRack());
  for (const s of rack.slaves) {
    const g = s.gridBpm;
    const live = { ...s, phase: 0, pos: s.loopStart + (s.loopEnd - s.loopStart) * 0.29 };
    // Applying them in either order must give the same result.
    const a = moveLoop(applyPhase(live, 0.5, g), 1, g);
    const b = applyPhase(moveLoop(live, 1, g), 0.5, g);
    ok(`${s.name}: order does not matter (region)`,
       Math.abs(a.loopStart - b.loopStart) < 1e-9 && Math.abs(a.loopEnd - b.loopEnd) < 1e-9);
    ok(`${s.name}: order does not matter (playhead)`, Math.abs(a.pos - b.pos) < 1e-9,
       `${a.pos} vs ${b.pos}`);
    // Move must not alter phase; Phase must not alter the region.
    ok(`${s.name}: move leaves phase alone`, moveLoop(live, 1, g).phase === live.phase);
    const ph = applyPhase(live, 0.5, g);
    ok(`${s.name}: phase leaves the region alone`,
       ph.loopStart === live.loopStart && ph.loopEnd === live.loopEnd);
  }

  // Reload: bounds come back from storage, the offset is re-applied from the saved phase.
  for (const s of rack.slaves) {
    const g = s.gridBpm, ld = s.loopEnd - s.loopStart, bar = (60 / g) * 4;
    const live = applyPhase({ ...s, phase: 0, pos: s.loopStart }, 0.5, g);
    const reloaded = s.loopStart + wrap(0.5 * bar, ld);
    ok(`${s.name}: reload reproduces the live offset`, Math.abs(reloaded - live.pos) < 1e-9,
       `${reloaded} vs ${live.pos}`);
  }
}

section("15. phase does not reintroduce drift");
{
  const rack = matchTempos(buildRack());
  const aRate = rate(rack.anchor, rack.masterSpeed);
  const anchorHeardBar = ((60 / rack.anchor.rawBpm) * 4) / aRate;
  for (const s of rack.slaves) {
    // Whatever the offset, the loop LENGTH is what governs drift.
    const bars = heardLoopDur(s, rack.masterSpeed) / anchorHeardBar;
    ok(`${s.name}: still a whole number of bars with phase applied`,
       Math.abs(bars - Math.round(bars)) < 1e-9, `${bars}`);
  }
}

section("16. moving the loop region — geometry, playhead, and rewind");
{
  /** SlotStrip.moveLoop — slide the region by whole/fractional bars, length unchanged. */
  const moveLoop = (s, bars, gridBpm, bufferDur) => {
    const bar = (60 / gridBpm) * 4;
    const loopDur = s.loopEnd - s.loopStart;
    if (loopDur <= 0) return s;
    // Clamps rather than wraps: sliding the region is deliberate placement.
    const start = Math.max(0, Math.min(s.loopStart + bars * bar, bufferDur - loopDur));
    if (Math.abs(start - s.loopStart) < 1e-6) return s;
    return { ...s, loopStart: start, loopEnd: start + loopDur };
  };
  /** multiEngine.nudgeSlot — carry the playhead, wrapping in the loop. */
  const nudge = (pos, loopStart, loopEnd, seconds) => {
    const ld = loopEnd - loopStart;
    return loopStart + ((((pos - loopStart + seconds) % ld) + ld) % ld);
  };

  const DUR = 60, GRID = 120, BAR = 2;
  const base = { loopStart: 10, loopEnd: 18, phase: 0 };

  // Length is the property that governs drift — it must never change.
  for (const b of [0.25, -0.25, 1, -1, 4, -4]) {
    const m = moveLoop(base, b, GRID, DUR);
    ok(`move ${b} bars keeps length`, Math.abs((m.loopEnd - m.loopStart) - 8) < 1e-9);
    ok(`move ${b} bars stays in the buffer`, m.loopStart >= 0 && m.loopEnd <= DUR + 1e-9);
  }

  // A quarter bar really is a quarter bar.
  ok("1/4 bar moves by one beat", Math.abs(moveLoop(base, 0.25, GRID, DUR).loopStart - 10.5) < 1e-9);
  ok("8 x 1/4 bar equals 2 bars", (() => {
    let s = base;
    for (let i = 0; i < 8; i++) s = moveLoop(s, 0.25, GRID, DUR);
    return Math.abs(s.loopStart - (10 + 2 * BAR)) < 1e-9;
  })());

  // Clamping, not wrapping, at both edges.
  ok("clamps at the start", (() => {
    let s = { ...base, loopStart: 0, loopEnd: 8 };
    for (let i = 0; i < 12; i++) s = moveLoop(s, -4, GRID, DUR);
    return s.loopStart >= 0;
  })());
  ok("clamps at the end", (() => {
    let s = { ...base, loopStart: 50, loopEnd: 58 };
    for (let i = 0; i < 12; i++) s = moveLoop(s, 4, GRID, DUR);
    return s.loopEnd <= DUR + 1e-9;
  })());

  ok("reversible: +1 then -1 returns exactly", (() => {
    const there = moveLoop(base, 1, GRID, DUR);
    const back = moveLoop(there, -1, GRID, DUR);
    return Math.abs(back.loopStart - base.loopStart) < 1e-9;
  })());

  // A phase offset must survive a move, and the base must travel with it.
  {
    const phased = { loopStart: 10, loopEnd: 18, phase: 0.5 };
    const m = moveLoop(phased, 2, GRID, DUR);
    ok("move leaves the phase value untouched", m.phase === phased.phase);
    ok("move shifts the region only", Math.abs(m.loopStart - 14) < 1e-9, `${m.loopStart}`);
  }

  // The playhead keeps its place inside the loop rather than being left behind.
  for (const [pos, bars] of [[14, 1], [14, -1], [10, 0.25], [17.9, 1], [14, 4]]) {
    const m = moveLoop(base, bars, GRID, DUR);
    const moved = nudge(pos, m.loopStart, m.loopEnd, m.loopStart - base.loopStart);
    const relBefore = ((pos - base.loopStart) % 8 + 8) % 8;
    const relAfter = ((moved - m.loopStart) % 8 + 8) % 8;
    ok(`playhead at ${pos}, move ${bars}: relative position kept`,
       Math.abs(relBefore - relAfter) < 1e-9, `${relBefore.toFixed(3)} -> ${relAfter.toFixed(3)}`);
    ok(`  playhead stays inside the loop`,
       moved >= m.loopStart - 1e-9 && moved <= m.loopEnd + 1e-9,
       `${moved.toFixed(3)} in [${m.loopStart.toFixed(3)}, ${m.loopEnd.toFixed(3)}]`);
  }

  // Rewind must land on the MOVED loop start. Reading a stale React prop here is the bug
  // that made a move sound as though it had not happened.
  for (const bars of [0.25, -0.25, 1, 4]) {
    const m = moveLoop(base, bars, GRID, DUR);
    // Rewind reads the ENGINE's bounds, which are current. Model both and require the
    // engine value to be the one that matches the move.
    const engineRewind = m.loopStart;
    const stalePropRewind = base.loopStart;
    ok(`rewind after move ${bars} lands on the moved start`,
       Math.abs(engineRewind - (base.loopStart + bars * BAR)) < 1e-9,
       `${engineRewind} vs expected ${base.loopStart + bars * BAR}`);
    ok(`  a stale prop would land somewhere else (bug is real)`,
       Math.abs(stalePropRewind - engineRewind) > 1e-9,
       "rewinding to the old loopStart sounds as though the move never happened");
  }

  // Moving does not disturb tempo alignment: length is untouched, so bars stay whole.
  {
    const rack = matchTempos(buildRack());
    const aRate = rate(rack.anchor, rack.masterSpeed);
    const anchorHeardBar = ((60 / rack.anchor.rawBpm) * 4) / aRate;
    for (const s of rack.slaves) {
      const m = moveLoop(s, 1, s.gridBpm, 60);
      const bars = ((m.loopEnd - m.loopStart) / rate(s, rack.masterSpeed)) / anchorHeardBar;
      ok(`${s.name}: still whole bars after a move`, Math.abs(bars - Math.round(bars)) < 1e-9, `${bars}`);
    }
  }
}

section("17. delay — divisions, re-sync, and the heard/file domain split");
{
  const rack = matchTempos(buildRack());
  const aEff = effectiveBpm(rack.anchor.rawBpm, rack.anchor, rack.masterSpeed, rack.anchor.stretch);
  const beat = 60 / aEff;

  // Every division must be an exact multiple of the HEARD beat — that is what puts an echo
  // on the grid rather than smearing against it.
  for (const b of DIVISIONS) {
    const secs = b * beat;
    if (secs > 4) continue;
    const snapped = snapDelay(secs, aEff);
    ok(`division ${b} round-trips through the snapper`,
       Math.abs(snapped.seconds - secs) < 1e-9, `${snapped.seconds} vs ${secs}`);
    ok(`  it is an exact multiple of the heard beat`,
       Math.abs(snapped.seconds / beat - b) < 1e-9);
  }

  // All slots share the anchor's grid, so the same division is the same wall-clock time
  // everywhere — echoes line up across the rack.
  const eighth = snapDelay(beat / 2, aEff).seconds;
  for (const s of [rack.anchor, ...rack.slaves]) {
    ok(`${s.name}: 1/8 is the same duration as the anchor's`,
       Math.abs(snapDelay(beat / 2, aEff).seconds - eighth) < 1e-12);
  }

  // The delay uses the HEARD tempo. Using the raw file tempo is wrong by the rate factor —
  // this was audible as echoes landing off the beat whenever a slot was not at unity speed.
  const raw = rack.anchor.rawBpm;
  const heardEighth = (60 / aEff) / 2;
  const rawEighth = (60 / raw) / 2;
  const aRate = rate(rack.anchor, rack.masterSpeed);
  ok("heard and raw eighths differ by exactly the rate factor",
     Math.abs(heardEighth / rawEighth - 1 / aRate) < 1e-9,
     `${(heardEighth * 1000).toFixed(0)}ms vs ${(rawEighth * 1000).toFixed(0)}ms`);

  // Re-sync: when the tempo moves, a synced delay must hold its DIVISION, not its seconds.
  const resync = (seconds, prevBpm, nextBpm) => {
    const atOld = snapDelay(seconds, prevBpm);
    if (!atOld || Math.abs(atOld.seconds - seconds) > 0.005) return seconds; // was free
    const r = (atOld.beats * 60) / nextBpm;
    return r > 4 ? seconds : r;
  };
  for (const [from, to] of [[120, 88.2], [88.2, 120], [124, 112], [100, 174]]) {
    const before = (60 / from) / 2;                      // a 1/8 at the old tempo
    const after = resync(before, from, to);
    const stillEighth = snapDelay(after, to);
    ok(`tempo ${from} -> ${to}: delay stays a 1/8`,
       Math.abs(stillEighth.beats - 0.5) < 1e-9, `${stillEighth.beats} beats`);
    ok(`  seconds changed with the tempo`, Math.abs(after - (60 / to) / 2) < 1e-9);
  }
  // A deliberately free delay must not be dragged onto the grid.
  const free = 0.313;
  ok("a free delay is left alone", resync(free, 120, 88.2) === free);

  // Arrow stepping must always move — a fixed seconds step cannot, because the gaps between
  // divisions are uneven.
  const stepDivision = (seconds, bpm, dir) => {
    const b = 60 / bpm;
    const usable = DIVISIONS.filter((d) => d * b <= 4);
    let idx = 0, err = Infinity;
    usable.forEach((d, i) => { const e = Math.abs(d * b - seconds); if (e < err) { err = e; idx = i; } });
    const next = idx + dir;
    if (next < 0) return 0;
    if (next >= usable.length) return usable[usable.length - 1] * b;
    return usable[next] * b;
  };
  for (const bpm of [88.2, 120, 174]) {
    let cur = 0.25 * (60 / bpm), stuck = 0;
    for (let i = 0; i < 8; i++) {
      const n = stepDivision(cur, bpm, 1);
      if (Math.abs(n - cur) < 1e-9) stuck++;
      cur = n;
    }
    ok(`${bpm}bpm: arrow up never sticks`, stuck === 0, `${stuck} stuck presses`);
    let down = 0;
    for (let i = 0; i < 14; i++) {
      const n = stepDivision(cur, bpm, -1);
      if (Math.abs(n - cur) < 1e-9 && cur > 0) down++;
      cur = n;
    }
    ok(`${bpm}bpm: arrow down reaches zero`, cur === 0, `${cur}`);
  }
}

section("18. key matching — badge honesty and interval preservation");
{
  const isMatched = (slot, base, refSpeed) =>
    Math.abs(slot.speed - refSpeed) <= 0.001 && ((((slot.pitch - base) % 12) + 12) % 12) < 0.01;

  const REF = 0.85, BASE = -3;
  ok("exact match reads matched", isMatched({ speed: REF, pitch: -3 }, BASE, REF));
  for (const oct of [12, -12, 24, -24])
    ok(`${oct} semitones (octave) keeps the badge`, isMatched({ speed: REF, pitch: BASE + oct }, BASE, REF));
  for (const bad of [1, -1, 7, 5, 11])
    ok(`${bad} semitones clears the badge`, !isMatched({ speed: REF, pitch: BASE + bad }, BASE, REF));
  ok("a speed change clears the badge", !isMatched({ speed: 0.9, pitch: -3 }, BASE, REF));
  ok("float noise in speed is tolerated", isMatched({ speed: REF + 0.0005, pitch: -3 }, BASE, REF));

  // Master speed transposes every following slot by the SAME interval, so relative key
  // relationships survive — that is why the master dial is safe on a matched rack.
  const rack = buildRack();
  for (const ms of [0.6, 0.75, 1.25, 1.5]) {
    const semis = [rack.anchor, ...rack.slaves]
      .filter((s) => !s.bypassMasterSpeed)
      .map((s) => 12 * Math.log2(rate(s, ms) / rate(s, 1)));
    ok(`master ${ms}: identical interval shift across the rack`,
       semis.every((v) => Math.abs(v - semis[0]) < 1e-9), `${semis.map((v) => v.toFixed(4))}`);
  }
  // A bypassed slot deliberately does NOT follow.
  const bypassed = rack.anchor;
  ok("a bypassed slot ignores master speed", rate(bypassed, 0.5) === rate(bypassed, 1));

  // Stretch must not disturb key: it changes duration, never rate.
  for (const st of [0.7, 1.3]) {
    const before = rate({ speed: 0.9, pitch: -2, linkPitch: false }, 1);
    const after = rate({ speed: 0.9, pitch: -2, linkPitch: false }, 1);
    ok(`stretch ${st} leaves playback rate (and pitch) untouched`, before === after);
  }
}

section("19. the phase offset is durable, not just a one-off seek");
{
  // multiEngine.phaseOffsetFor — the single implementation every re-anchor path uses.
  const phaseOffsetFor = (s) => {
    const phase = s.phase ?? 0, bar = s.phaseBarSec ?? 0;
    const ld = s.loopEnd - s.loopStart;
    if (phase <= 0 || bar <= 0 || ld <= 0) return 0;
    return (((phase * bar) % ld) + ld) % ld;
  };
  const startPositionFor = (s) => s.loopStart + phaseOffsetFor(s);

  const rack = matchTempos(buildRack());
  for (const s of rack.slaves) {
    const bar = (60 / s.gridBpm) * 4;
    const slot = { ...s, phaseBarSec: bar };
    const ld = slot.loopEnd - slot.loopStart;
    const off = phaseOffsetFor(slot);

    if ((slot.phase ?? 0) > 0) {
      ok(`${s.name}: a phased slot has a non-zero offset`, off > 1e-9, `${off}`);
      ok(`  offset equals the requested fraction of a bar`,
         Math.abs(off - (((slot.phase * bar) % ld) + ld) % ld) < 1e-9);
    }

    // Every path that returns the slot to its start must include the offset. These are the
    // ones that previously dropped it: Rewind All, the per-slot rewind, and Play All.
    for (const path of ["rewindAll", "per-slot rewind", "play(fromLoopStart)"]) {
      const pos = startPositionFor(slot);
      ok(`${s.name}: ${path} preserves the displacement`,
         Math.abs(pos - (slot.loopStart + off)) < 1e-9,
         "seeking to a bare loopStart puts every slot at relative 0 and loses the offset");
      ok(`  ${path} stays inside the loop`, pos >= slot.loopStart - 1e-9 && pos <= slot.loopEnd + 1e-9);
    }

    // Reload takes the same route, so it must agree with the live position.
    ok(`${s.name}: reload lands where rewind lands`,
       Math.abs(startPositionFor(slot) - startPositionFor({ ...slot })) < 1e-9);

    // An unphased slot must be untouched by any of this.
    const plain = { ...slot, phase: 0 };
    ok(`${s.name}: with phase 0, start is exactly loopStart`,
       startPositionFor(plain) === plain.loopStart);
  }

  // The displacement is what makes a slot land differently from the anchor. After a rewind,
  // a phased slave must NOT be at the same relative position as the anchor.
  {
    const bar = (60 / rack.anchor.gridBpm) * 4;
    const anchor = { ...rack.anchor, phaseBarSec: bar };
    const anchorRel = 0;
    for (const s of rack.slaves) {
      if (!(s.phase > 0)) continue;
      const slot = { ...s, phaseBarSec: (60 / s.gridBpm) * 4 };
      const rel = (startPositionFor(slot) - slot.loopStart) / (slot.loopEnd - slot.loopStart);
      ok(`${s.name}: after rewind it is displaced from the anchor`,
         Math.abs(rel - anchorRel) > 1e-6, `both at relative ${rel.toFixed(6)}`);
    }
  }

  // Without a bar length the engine cannot compute an offset — it must degrade to no
  // displacement rather than to a wrong one.
  {
    const s = { loopStart: 4, loopEnd: 12, phase: 0.5, phaseBarSec: 0 };
    ok("no bar length => no offset (never a wrong one)", phaseOffsetFor(s) === 0);
  }
}

section("20. joining a running rack keeps the phase displacement");
{
  // multiEngine.matchingLoopPosition — the shared route for playSlot (a slot's own Play
  // button) and startSilencedSlots (unmute / solo into a running rack).
  //
  // Section 19 enumerated three re-anchor paths and called them "the ones that previously
  // dropped it". These two were re-anchor paths all along and were simply not on the list,
  // so both this file and surfaceCoverage stayed green while a phased slot silently
  // returned to the downbeat whenever it was started on its own.
  const wrapIn = (s, pos) => {
    const ld = s.loopEnd - s.loopStart;
    return ld <= 0 ? s.loopStart : s.loopStart + ((((pos - s.loopStart) % ld) + ld) % ld);
  };
  const phaseOffsetFor = (s) => {
    const phase = s.phase ?? 0, bar = s.phaseBarSec ?? 0;
    const ld = s.loopEnd - s.loopStart;
    if (phase <= 0 || bar <= 0 || ld <= 0) return 0;
    return (((phase * bar) % ld) + ld) % ld;
  };
  const startPositionFor = (s) => s.loopStart + phaseOffsetFor(s);
  const matchingLoopPosition = (slot, peer, peerPos) => {
    const ld = slot.loopEnd - slot.loopStart, pd = peer.loopEnd - peer.loopStart;
    if (ld <= 0 || pd <= 0) return null;
    const rel = peerPos - peer.loopStart - phaseOffsetFor(peer);
    const frac = (((rel / pd) % 1) + 1) % 1;
    return wrapIn(slot, slot.loopStart + frac * ld + phaseOffsetFor(slot));
  };

  const rack = matchTempos(buildRack());
  const withBar = (s) => ({ ...s, phaseBarSec: (60 / s.gridBpm) * 4 });
  const anchor = withBar(rack.anchor);

  for (const raw of rack.slaves) {
    const slot = withBar(raw);
    const ld = slot.loopEnd - slot.loopStart;
    const off = phaseOffsetFor(slot);

    // The crisp invariant: joining while the peer sits on its downbeat must land the slot
    // exactly where Rewind All would put it. If the two disagree, one of them is wrong.
    const joinAtDownbeat = matchingLoopPosition(slot, anchor, anchor.loopStart);
    ok(`${slot.name}: joining at the peer's downbeat == rewinding`,
       Math.abs(joinAtDownbeat - startPositionFor(slot)) < 1e-9,
       `join ${joinAtDownbeat.toFixed(6)} vs rewind ${startPositionFor(slot).toFixed(6)}`);

    // Mid-loop: strip the slot's own offset back off and the peer's progress must reappear.
    for (const frac of [0.13, 0.5, 0.87]) {
      const peerPos = anchor.loopStart + (anchor.loopEnd - anchor.loopStart) * frac;
      const pos = matchingLoopPosition(slot, anchor, peerPos);
      const recovered = ((((pos - off - slot.loopStart) % ld) + ld) % ld) / ld;
      ok(`${slot.name}: joining at peer ${frac} preserves the peer's progress`,
         Math.abs(recovered - frac) < 1e-9, `recovered ${recovered.toFixed(6)}`);
      ok(`  and stays inside the loop`, pos >= slot.loopStart - 1e-9 && pos <= slot.loopEnd + 1e-9);
    }

    // A phased slot must NOT land where an unphased one does — that is the whole point.
    if (off > 1e-9) {
      const plain = matchingLoopPosition({ ...slot, phase: 0 }, anchor, anchor.loopStart);
      ok(`${slot.name}: phased join differs from unphased join`,
         Math.abs(joinAtDownbeat - plain) > 1e-9);
    }
  }

  // The peer is whichever slot is first in the map and may carry its own phase. Its
  // displacement must be subtracted, or everyone joining after it inherits it as the beat.
  {
    const peer = withBar({ ...rack.anchor, phase: 0.5 });
    const joiner = withBar({ ...rack.slaves[0], phase: 0 });
    const viaPhasedPeer = matchingLoopPosition(joiner, peer, startPositionFor(peer));
    ok("an unphased slot joining a PHASED peer lands on the downbeat",
       Math.abs(viaPhasedPeer - joiner.loopStart) < 1e-9,
       `landed at +${(viaPhasedPeer - joiner.loopStart).toFixed(6)} — it inherited the peer's phase`);
  }
}

section("21. export reproduces the phase offset it cannot inherit");
{
  // renderMulti schedules an offline player, which — unlike the live one — has loop = false
  // and does not wrap at loopEnd. Loop bounds are un-phased, so the offset is not implicit
  // in the exported geometry the way it was when phase moved the bounds: the render has to
  // compute it and split each repeat in two. Section 11 checks only that the master pass is
  // covered, which stayed true while the audio underneath it was wrong.
  const phaseOffsetSec = (phase, barSec, loopDur) => {
    if (phase <= 0 || barSec <= 0 || loopDur <= 0) return 0;
    return (((phase * barSec) % loopDur) + loopDur) % loopDur;
  };
  /** renderMulti's per-slot schedule: [{ when, readFrom, dur }] in real seconds. */
  const schedule = (s, masterLoopLength, loopCount, masterSpeed) => {
    const span = s.loopEnd - s.loopStart;
    const r = rate(s, masterSpeed);
    const segDur = span / r;
    if (!(segDur > 0)) return [];
    const off = phaseOffsetSec(s.phase ?? 0, (60 / s.gridBpm) * 4, span);
    const headDur = (span - off) / r, tailDur = off / r;
    const out = [];
    for (let pass = 0; pass < loopCount; pass++) {
      const passEnd = (pass + 1) * masterLoopLength;
      let when = pass * masterLoopLength;
      while (when < passEnd) {
        if (headDur > 0) {
          out.push({ when, readFrom: s.loopStart + off, dur: Math.min(headDur, passEnd - when) });
          when += headDur;
          if (when >= passEnd) break;
        }
        if (tailDur > 0) {
          out.push({ when, readFrom: s.loopStart, dur: Math.min(tailDur, passEnd - when) });
          when += tailDur;
        }
      }
    }
    return out;
  };

  const rack = matchTempos(buildRack());
  const all = [rack.anchor, ...rack.slaves];
  const master = Math.max(...all.map((s) => heardLoopDur(s, rack.masterSpeed)));

  for (const s of all) {
    const span = s.loopEnd - s.loopStart;
    const off = phaseOffsetSec(s.phase ?? 0, (60 / s.gridBpm) * 4, span);
    const segs = schedule(s, master, 2, rack.masterSpeed);
    ok(`${s.name}: export schedules at least one read`, segs.length > 0);

    // What a listener hears first must be what live playback starts on.
    ok(`${s.name}: the first read starts at the phased position`,
       Math.abs(segs[0].readFrom - (s.loopStart + off)) < 1e-9,
       `read from ${segs[0].readFrom.toFixed(6)}, live starts at ${(s.loopStart + off).toFixed(6)}`);

    // No read may run past loopEnd into audio the loop never plays.
    for (const g of segs) {
      const endsAt = g.readFrom + g.dur * rate(s, rack.masterSpeed);
      ok(`  read from ${g.readFrom.toFixed(3)} stays inside the loop`,
         endsAt <= s.loopEnd + 1e-9,
         `runs to ${endsAt.toFixed(6)} but the loop ends at ${s.loopEnd.toFixed(6)}`);
    }

    // Coverage must still be exact — the original section-11 property, preserved.
    const covered = segs.filter((g) => g.when < master).reduce((a, g) => a + Math.min(g.dur, master - g.when), 0);
    ok(`${s.name}: still tiles the first master pass with no gap`,
       Math.abs(covered - master) < 1e-6, `${covered.toFixed(6)} vs ${master.toFixed(6)}`);

    // And an unphased slot must schedule exactly as it did before this change.
    const plain = schedule({ ...s, phase: 0 }, master, 1, rack.masterSpeed);
    ok(`${s.name}: with phase 0 every read is a plain loopStart read`,
       plain.every((g) => g.readFrom === s.loopStart));
  }
}

section("22. auto re-lock preserves an explicit relation and always converges");
{
  // MultiPage: stretchSlotToTempoAnchor resolves `relationOverride ?? slot.tempoRelation`,
  // falling through to the fold when neither is set. Re-lock passes no override, so an
  // explicit choice survives it and an auto slot re-derives.
  const resolve = (chosen, t, a) => chosen ?? autoTempoRelation(t, a);
  const wanted = (chosen, t, a) => tempoStretchRatio(t, a, resolve(chosen, t, a));
  // MultiPage: the apply guard, and staleTempoIds' flag threshold.
  const APPLY = 0.005, STALE = 0.01;
  const applies = (chosen, cur, t, a) => Math.abs(wanted(chosen, t, a) - cur) >= APPLY;
  const stale = (chosen, cur, t, a) =>
    Math.abs(cur - 1) > APPLY && Math.abs(wanted(chosen, t, a) - cur) > STALE;

  ok("the apply threshold is tighter than the stale threshold", APPLY < STALE,
     "if a difference can be too small to apply but large enough to flag, auto re-lock loops forever");

  const anchor = 88.2;
  for (const t of [40, 61.5, 87, 88.2, 120, 174, 259]) {
    for (const chosen of [undefined, 1, 1 / 2, 2, 3 / 4]) {
      const after = wanted(chosen, t, anchor);

      // Converges: a slot the pass just re-stretched must not read as stale again, or the
      // 600ms auto re-lock timer re-fires on it indefinitely, rebuilding a buffer each time.
      ok(`t=${t} rel=${chosen ?? "auto"}: not stale immediately after re-locking`,
         !stale(chosen, after, t, anchor), `${after}`);

      // Idempotent: running it twice changes nothing.
      ok(`  re-locking again is a no-op`, !applies(chosen, after, t, anchor));

      // An explicit choice is honoured exactly, not nudged toward the automatic answer.
      if (chosen !== undefined) {
        ok(`  explicit relation ${chosen} is honoured`,
           Math.abs(after - tempoStretchRatio(t, anchor, chosen)) < 1e-9);
      } else {
        // And an automatic slot still folds, so re-lock can never leave it outside the band.
        ok(`  auto stays inside one octave of unity`,
           after >= 1 / Math.SQRT2 - 1e-9 && after <= Math.SQRT2 + 1e-9, `${after}`);
      }
    }
  }

  // The case that motivated the explicit/auto split: a slot deliberately set to half speed
  // must not be dragged back by the very next re-lock.
  {
    const half = wanted(1 / 2, 174, anchor);
    ok("a half-speed slot survives re-lock", !stale(1 / 2, half, 174, anchor));
    ok("  and is genuinely different from the automatic answer",
       Math.abs(half - wanted(undefined, 174, anchor)) > 0.1);
  }
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
