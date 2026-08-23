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
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

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

await attempt("matchTempos", async () => {
  await page.getByRole("button", { name: /Match Tempos/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(9000);   // stretch is synchronous and slow — one buffer per slot
});
await shot("04-matched");

// Position readout under each waveform ("0:04/9:16"). Whole seconds only, so this catches a
// slot that is grossly adrift but NOT a sub-second phase error — read the shots for those.
step.positions = await page.evaluate(() =>
  [...document.querySelectorAll("canvas")].map(
    (c) => c.closest("div")?.parentElement?.querySelector("div.pointer-events-none")?.textContent?.trim() ?? "?"));

console.log(JSON.stringify({ slots, shots: SHOTS, step, errorCount: errors.length, errors: errors.slice(0, 25) }, null, 2));
await browser.close();
process.exit(errors.some((e) => e.startsWith("PAGEERROR")) ? 1 : 0);
