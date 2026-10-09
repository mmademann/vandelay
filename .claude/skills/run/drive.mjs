/**
 * Headless-browser smoke driver for the multi page.
 *
 * Not a test suite — a way to confirm the real app launches, decodes audio, builds the Tone
 * graph and survives the transport actions without throwing. It asserts nothing about how
 * anything *sounds*; see CLAUDE.md "Testing" for why that gap is deliberate.
 *
 * Usage (see SKILL.md for the full recipe):
 *   node skills/run/drive.mjs --slots "id:drums,id:bass" --shots /tmp/shots
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * playwright-core is intentionally not a repo dependency, so it lives out of tree. ESM
 * ignores NODE_PATH, hence the explicit search rather than a bare specifier.
 */
async function loadChromium() {
  const tries = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    "/tmp/vandelay-drive/node_modules/playwright-core/index.mjs",
  ].filter(Boolean);
  for (const t of tries) {
    try { return (await import(t)).chromium; } catch { /* next */ }
  }
  throw new Error("playwright-core not found — see skills/run/SKILL.md for the install line");
}
const chromium = await loadChromium();

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const WEB = arg("url", "http://localhost:5173");
const API = arg("api", "http://localhost:5174");
const SHOTS = arg("shots", path.join(os.tmpdir(), "vandelay-shots"));

/**
 * Playwright pins a browser revision, so the path carries a build number that changes on
 * every upgrade. Glob for it rather than hardcoding, and fall back to the system Chrome —
 * the app needs no Playwright-specific browser behaviour.
 */
function findBrowser() {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      for (const name of ["Google Chrome for Testing", "Chromium"]) {
        const p = path.join(cache, dir, "chrome-mac-arm64", `${name}.app/Contents/MacOS/${name}`);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const sys = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(sys)) return sys;
  throw new Error("No Chromium found. Run: npx playwright install chromium");
}

/** Two real stem-separated tracks, so the run exercises decode rather than an empty rack. */
function defaultSlots() {
  const lib = JSON.parse(execSync(`curl -sf ${API}/api/stems/library`, { encoding: "utf8" }));
  if (lib.length < 2) throw new Error("Need at least 2 separated tracks in the stems library");
  return `${lib[0].id}:drums,${lib[1].id}:bass`;
}

const slots = arg("slots") ?? defaultSlots();
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: findBrowser(),
  // Autoplay policy: the app gates audio behind a real click anyway, but without this the
  // context stays suspended in headless and every position reads 0.
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 900 },
  // The export step saves a real file; without this Chromium cancels the download.
  acceptDownloads: true,
})).newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  // "Failed to load resource" duplicates the response handler, which has the URL and can
  // filter the favicon; drop the console copy so a missing favicon is not reported twice.
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`CONSOLE: ${m.text()}`);
});
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`HTTP ${r.status()}: ${r.url()}`);
});

const step = {};
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });
async function attempt(name, fn) {
  try { await fn(); step[name] = "ok"; }
  catch (e) { step[name] = `FAILED: ${e.message.split("\n")[0]}`; }
}

await page.goto(`${WEB}/?slots=${slots}`, { waitUntil: "domcontentloaded", timeout: 60000 });

// One waveform canvas appears per decoded slot. Decode is the slow part (fetch + decode of a
// full WAV), so this is the wait that matters — wait-idle never settles here.
const want = slots.split(",").length;
await page.waitForFunction((n) => document.querySelectorAll("canvas").length >= n, want, { timeout: 120000 });
await page.waitForTimeout(2000);
await shot("01-loaded");

await attempt("tempoAnchor", async () => {
  await page.getByRole("button", { name: /Set Tempo Anchor/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(800);
});

// First Play is also what builds the Tone graph — nothing before this proves audio works.
await attempt("playAll", async () => {
  await page.getByRole("button", { name: /Play All/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(3000);
});
await shot("02-playing");

await attempt("phase", async () => {
  // Phase is a stepped knob, not the button grid it used to be. Knobs take arrow keys while
  // hovered (no focus), so hover the last slot's Phase and step it up four divisions.
  const phaseKnob = page.locator("div").filter({ has: page.locator("span", { hasText: /^Phase$/ }) }).last();
  await phaseKnob.locator("svg").hover({ timeout: 10000 });
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(1200);
  const shown = await phaseKnob.locator("span").last().innerText();
  if (/on beat/.test(shown)) throw new Error(`phase knob did not move: ${shown}`);
  step.phaseValue = shown;
});
await attempt("move", async () => {
  await page.getByRole("button", { name: /1\/4 ▶/ }).last().click({ timeout: 10000 });
  await page.waitForTimeout(1000);
});
await attempt("rewindAll", async () => {
  await page.getByRole("button", { name: /^⏮/ }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
});
await shot("03-phase-move-rewind");

// Mute then unmute: the path where a phased slot rejoins a running rack. Historically this
// silently dropped the phase offset (see CLAUDE.md invariant 20).
await attempt("muteUnmute", async () => {
  // Match MUTE *and* MUTED. The label flips on the first click, so a locator anchored to
  // "MUTE$" stops matching this slot and the second click silently lands on a different
  // slot's button — muting two slots instead of toggling one, while still reporting ok.
  const m = page.getByRole("button", { name: /^\W*MUTED?$/i }).nth(1);
  await m.click({ timeout: 10000 }); await page.waitForTimeout(900);
  step.mutedLabels = await page.getByRole("button", { name: /^\W*MUTED?$/i }).allInnerTexts();
  await m.click(); await page.waitForTimeout(1200);
  step.unmutedLabels = await page.getByRole("button", { name: /^\W*MUTED?$/i }).allInnerTexts();
});

// The Fade half of the split mute control. Mute never stops the player, so this is a level
// ramp — the slot has to still be running (and still in phase) when it comes back.
await attempt("muteFade", async () => {
  const slot = page.locator("span").filter({ has: page.getByRole("button", { name: /^\W*MUTED?$/i }) }).nth(1);
  const fade = slot.getByRole("button", { name: /^Fade$/ });
  await fade.click({ timeout: 10000 });
  await page.waitForTimeout(1200);
  step.mutedAfterFade = await slot.getByRole("button", { name: /^\W*MUTED?$/i }).innerText();
  if (!/MUTED/i.test(step.mutedAfterFade)) throw new Error(`fade did not mute: ${step.mutedAfterFade}`);
  await fade.click();
  await page.waitForTimeout(1200);
  const back = await slot.getByRole("button", { name: /^\W*MUTED?$/i }).innerText();
  if (/MUTED/i.test(back)) throw new Error(`fade did not unmute: ${back}`);
  // The slot must still be running: a faded mute that stopped the player would leave the
  // rack's loops out of phase with each other, which is the whole reason it is a ramp.
  const playing = await page.evaluate(() => document.body.innerText.includes("Pause All"));
  if (!playing) throw new Error("rack stopped during a faded mute");
});

await attempt("matchTempos", async () => {
  await page.getByRole("button", { name: /Match Tempos/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(9000);   // stretch is synchronous and slow — one buffer per slot
});
await shot("04-matched");

// The merged tempo dropdown — one control per non-anchor slot that sets the relation and,
// when the delay is already on a division, the delay that shares a pulse with it. Two
// separate dropdowns used to do this; the count below is what stops them coming back.
await attempt("tempoDropdown", async () => {
  const picker = page.locator("select").filter({ hasText: /bpm/ });
  const n = await picker.count();
  step.tempoPickers = n;
  // One slot is the anchor and has no relation to itself, so a two-slot rack has exactly one.
  if (n !== want - 1) throw new Error(`expected ${want - 1} tempo dropdowns, found ${n}`);
  const sel = picker.first();
  const before = await sel.inputValue();
  const values = await sel.locator("option").evaluateAll((os) =>
    os.map((o) => o.value).filter((v) => v !== ""));
  const next = values.find((v) => v !== before);
  if (!next) throw new Error("dropdown offered no other relation");
  step.tempoRows = values.length;
  await sel.selectOption(next);
  await page.waitForTimeout(6000);   // picking a row re-stretches the slot
  const after = await sel.inputValue();
  step.relationBefore = before;
  step.relationAfter = after;
  if (after === before) throw new Error(`relation did not change: still ${after}`);
});
await shot("05-tempo-row");

// Position readout under each waveform ("0:04/9:16"). Whole seconds only, so this catches a
// slot that is grossly adrift but NOT a sub-second phase error — read the shots for those.
step.positions = await page.evaluate(() =>
  [...document.querySelectorAll("canvas")].map(
    (c) => c.closest("div")?.parentElement?.querySelector("div.pointer-events-none")?.textContent?.trim() ?? "?"));

// Record: the only check that the LIVE graph makes sound. Export renders through a separate
// offline chain, so a live-only fault — a send disconnected from master, a bypass raised
// without its counterpart lowered — passes every other check here. This taps the live master.
await attempt("recordLive", async () => {
  const rec = page.getByRole("button", { name: /● Rec/ }).first();
  await rec.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: /■ Stop/ }).first().click({ timeout: 10000 });
  // Stopping does not download: it encodes, then offers the take with a filename box. The
  // file only exists once Save is pressed.
  const save = page.getByRole("button", { name: /^Save$/ }).first();
  await save.waitFor({ timeout: 120000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    save.click(),
  ]);
  const out = path.join(SHOTS, "take.wav");
  await download.saveAs(out);
  const buf = fs.readFileSync(out);
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  step.recBytes = buf.length;
  step.recPeak = peak;
  if (buf.length < 50000) throw new Error(`take too small: ${buf.length} bytes`);
  if (peak < 500) throw new Error(`live output is silent (peak ${peak})`);
});

// Reverb at 0% — the bypass path. In algorithmic mode Tone.Reverb at wet 0 passes the DRY
// signal, so the reverb branch is also the slot's only route to the master. Removing it to
// save convolution silences the slot unless a dry path is raised in the same step. Nothing
// else here covers it: export renders through a separate offline chain that has no bypass.
await attempt("recordDry", async () => {
  // The knob is <div><div><svg/></div><span>Reverb</span><span>value</span></div>, so walk
  // from the label to its sibling svg — filtering divs matches every ancestor as well.
  // locator("span") first: getByText can resolve to an ancestor div, which has no preceding
  // sibling div and so never finds the knob's svg.
  const labels = page.locator("span").filter({ hasText: /^Reverb$/ });
  const n = await labels.count();
  for (let i = 0; i < n; i++) {
    // The knob's wrapper div, not the <svg> inside it: XPath has no default namespace, so
    // `//svg` never matches an SVG element. Double-click resets a knob to its default, and
    // Reverb's default is 0 — which is exactly the bypass path this is here to exercise.
    await labels.nth(i).locator("xpath=preceding-sibling::div").first().dblclick({ timeout: 10000 });
  }
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /● Rec/ }).first().click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /■ Stop/ }).first().click({ timeout: 10000 });
  const save = page.getByRole("button", { name: /^Save$/ }).first();
  await save.waitFor({ timeout: 120000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    save.click(),
  ]);
  const out = path.join(SHOTS, "take-dry.wav");
  await download.saveAs(out);
  const buf = fs.readFileSync(out);
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  step.dryPeak = peak;
  if (peak < 500) throw new Error(`silent with reverb bypassed (peak ${peak})`);
});
// A take left pending blocks Export with "Save the current take first", which would report
// as an export failure rather than as the recording step that actually went wrong.
await attempt("clearPendingTake", async () => {
  const discard = page.getByRole("button", { name: /^Discard$/ }).first();
  if (await discard.count()) await discard.click({ timeout: 5000 });
});

// Export: the offline render. CLAUDE.md called this out as never actually having been run —
// tests and reasoning only, no file ever produced. Rendering one here is the cheapest way to
// catch a graph that only exists in the live context (the convolver bug did exactly that),
// an empty master, or a throw in Tone.Offline. It still says nothing about how it SOUNDS.
await attempt("export", async () => {
  await page.getByRole("button", { name: /↓ Export/ }).first().click({ timeout: 10000 });
  const submit = page.getByRole("button", { name: /^Export (WAV|MP3|FLAC)/i }).first();
  await submit.waitFor({ timeout: 10000 });
  // The render is offline but not fast: the master loop is the LONGEST slot loop, so a rack
  // holding a full 11-minute track renders 11 minutes of audio through every effects chain.
  // Timed, and reported, because a slow render and a hung one look identical from here.
  const started = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 600000 }),
    submit.click(),
  ]);
  step.exportSeconds = Math.round((Date.now() - started) / 1000);
  const out = path.join(SHOTS, "export.wav");
  await download.saveAs(out);
  const bytes = fs.statSync(out).size;
  step.exportBytes = bytes;
  step.exportName = download.suggestedFilename();
  // A WAV header alone is 44 bytes and silence compresses to nothing useful — anything this
  // small means the render produced no audio, which is the failure worth catching.
  if (bytes < 100000) throw new Error(`export too small: ${bytes} bytes`);
  // Non-silent: scan the PCM for a sample above the noise floor. A rack that renders an
  // empty master still yields a correctly-sized file of zeroes.
  const buf = fs.readFileSync(out);
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  step.exportPeak = peak;
  if (peak < 500) throw new Error(`export is silent (peak ${peak})`);
});
await shot("05-exported");

console.log(JSON.stringify({ slots, shots: SHOTS, step, errorCount: errors.length, errors: errors.slice(0, 25) }, null, 2));
await browser.close();
process.exit(errors.some((e) => e.startsWith("PAGEERROR")) ? 1 : 0);
