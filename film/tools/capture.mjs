import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const require = createRequire(join(REPO, 'package.json'));
const { chromium } = require('playwright');

export const VIEW = { width: 1440, height: 810 };
export const SCALE = 2;
export const FPS = 30;
const PUB = join(ROOT, 'public');
const FF_DIR = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const FILM_CSS = `
  [aria-label="Synthetic demo"] { display: none !important; }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  html { scrollbar-width: none; }
  *, *::before, *::after { caret-color: transparent !important; }
`;

export async function launch() {
  return chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : undefined });
}

/** A fresh synthetic workspace, as the Marine or as the section lead. */
export async function openDemo(browser, base, { persona = 'marine', theme = 'light' } = {}) {
  const context = await browser.newContext({
    baseURL: base, viewport: VIEW, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: theme,
  });
  await context.addInitScript(({ css, theme }) => {
    try { localStorage.setItem('vantage.theme', theme); } catch { /* private mode */ }
    const add = () => { const s = document.createElement('style'); s.dataset.film = '1'; s.textContent = css; document.documentElement.appendChild(s); };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  }, { css: FILM_CSS, theme });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'networkidle' });
  if (persona === 'leader') {
    await page.request.post('/api/demo/persona', { data: { persona: 'leader' }, headers: { 'x-vantage-client': '1' } });
    await page.goto('/', { waitUntil: 'networkidle' });
  }
  await page.mouse.move(VIEW.width - 2, VIEW.height - 2);
  return { context, page };
}

/** A signed-in (or signed-out) page on the accounts-mode film instance, dressed like the demo. */
export async function openInstance(browser, base, login = null) {
  const context = await browser.newContext({ baseURL: base, viewport: VIEW, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript(({ css }) => {
    try { localStorage.setItem('vantage.theme', 'light'); } catch { /* private mode */ }
    const add = () => { const s = document.createElement('style'); s.dataset.film = '1'; s.textContent = css; document.documentElement.appendChild(s); };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  }, { css: FILM_CSS });
  const page = await context.newPage();
  if (login) {
    const res = await page.request.post('/api/auth/login', { data: login, headers: { 'x-vantage-client': '1' } });
    if (!res.ok()) throw new Error(`film instance sign-in as ${login.username}: ${res.status()} ${await res.text()}`);
    await page.goto('/', { waitUntil: 'networkidle' });
  }
  await page.mouse.move(VIEW.width - 2, VIEW.height - 2);
  return { context, page };
}

export async function settle(page, ms = 250) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

/** A still, in public/screens. Full page, a clip, or one element. */
export async function still(page, name, opts = {}) {
  mkdirSync(join(PUB, 'screens'), { recursive: true });
  await settle(page);
  const path = join(PUB, 'screens', `${name}.png`);
  const el = opts.locator ? opts.locator.first() : opts.selector ? page.locator(opts.selector).first() : null;
  if (el) { await el.scrollIntoViewIfNeeded(); await settle(page, 150); await el.screenshot({ path, animations: 'disabled' }); }
  else await page.screenshot({ path, fullPage: Boolean(opts.fullPage), clip: opts.clip });
  const box = el ? await el.boundingBox() : null;
  return { name, path, box };
}

let cursorAt = { x: VIEW.width * 0.62, y: VIEW.height * 0.9 };

export function take(page, film, scene) {
  const dir = join(PUB, 'footage', film, scene);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const events = [];
  const cursor0 = { ...cursorAt };
  let t = 0;
  let n = 0;

  const snap = async () => {
    const file = `f${String(n++).padStart(5, '0')}.jpg`;
    await page.screenshot({ path: join(dir, file), type: 'jpeg', quality: 92 });
    frames.push({ file, t: Number(t.toFixed(4)) });
  };
  const loc = (target) => (typeof target === 'string' ? page.locator(target) : target).first();
  const boxOf = async (target) => {
    const box = await loc(target).boundingBox();
    if (!box) throw new Error(`${film}/${scene}: nothing visible at ${typeof target === 'string' ? target : target.toString()}`);
    return box;
  };
  const move = (x, y, dur) => { events.push({ t, type: 'move', x, y, dur }); cursorAt = { x, y }; t += dur; };

  const reveal = async (target, { anchor = 0.38, seconds } = {}) => {
    const box = await boxOf(target);
    if (box.y >= 8 && box.y + Math.min(box.height, VIEW.height * 0.6) <= VIEW.height - 8) return;
    if (await loc(target).evaluate((el) => Boolean(el.closest('[role=dialog], [role=alertdialog]')))) return;
    const y0 = await page.evaluate(() => window.scrollY);
    const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const to = Math.max(0, Math.min(max, y0 + box.y - VIEW.height * anchor));
    if (Math.abs(to - y0) < 4) return;
    await api.scroll(to, seconds ?? Math.min(1.3, 0.55 + Math.abs(to - y0) / 1400));
  };

  const api = {
    page,
    get t() { return t; },
    /** Let time pass with the screen as it is. */
    hold(seconds) { t += seconds; },
    /** Hold until this many seconds into the scene (no-op if already past). */
    until(seconds) { if (seconds > t) t = seconds; },
    async start() { await settle(page); await snap(); },
    reveal,
    async focus(target, { zoom = 1.35, ease = 0.9, pad = 40, dx = 0, dy = 0 } = {}) {
      const box = typeof target === 'object' && 'width' in target && 'x' in target && !('first' in target) ? target : await boxOf(target);
      events.push({ t, type: 'focus', box: { x: box.x - pad + dx, y: box.y - pad + dy, width: box.width + pad * 2, height: box.height + pad * 2 }, zoom, ease });
    },
    wide({ ease = 0.9 } = {}) { events.push({ t, type: 'wide', ease }); },
    /** Move the drawn cursor to an element and click it; the click is real. */
    async click(target, { travel = 0.55, after = 0.35, scroll = true, force = false } = {}) {
      if (scroll) await reveal(target);
      const box = await boxOf(target);
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      move(x, y, travel);
      events.push({ t, type: 'click', x, y });
      await loc(target).click({ force });
      await page.mouse.move(VIEW.width - 2, VIEW.height - 2);
      t += 0.12;
      await settle(page, 220);
      await snap();
      t += after;
    },
    /** Point at something without clicking. */
    async point(target, { travel = 0.55, scroll = true } = {}) {
      if (scroll) await reveal(target);
      const box = await boxOf(target);
      move(box.x + box.width / 2, box.y + box.height / 2, travel);
    },
    async hover(target, { travel = 0.55, after = 0.3, scroll = true } = {}) {
      if (scroll) await reveal(target);
      const box = await boxOf(target);
      move(box.x + box.width / 2, box.y + box.height / 2, travel);
      await loc(target).hover();
      await page.waitForTimeout(900);
      await snap();
      t += after;
    },
    async press(key, { after = 0.3, show = true } = {}) {
      if (show) events.push({ t, type: 'key', key });
      await page.keyboard.press(key);
      await settle(page, 220);
      await snap();
      t += after;
    },
    /** Type at a steady, readable pace: one captured frame per character. */
    async type(target, text, { cps = 17, clear = false } = {}) {
      if (target) {
        await reveal(target);
        const box = await boxOf(target);
        move(box.x + Math.min(box.width / 2, 120), box.y + box.height / 2, 0.45);
        events.push({ t, type: 'click', x: cursorAt.x, y: cursorAt.y });
        await loc(target).click();
        if (clear) await page.keyboard.press('ControlOrMeta+a');
        await page.mouse.move(VIEW.width - 2, VIEW.height - 2);
        t += 0.2;
        await snap();
      }
      for (const ch of text) {
        events.push({ t, type: 'char', ch });
        await page.keyboard.type(ch);
        await page.waitForTimeout(8);
        await snap();
        t += 1 / cps;
      }
      await settle(page, 150);
      await snap();
    },
    /** Scroll the page smoothly: one frame per video frame. */
    async scroll(y, seconds = 1.1) {
      const from = await page.evaluate(() => window.scrollY);
      const steps = Math.max(2, Math.round(seconds * FPS));
      for (let i = 1; i <= steps; i++) {
        const p = i / steps;
        const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
        await page.evaluate((v) => window.scrollTo(0, v), from + (y - from) * e);
        await snap();
        t += 1 / FPS;
      }
    },
    /** A hard change of screen: the composition dissolves across it. */
    async goto(path) {
      events.push({ t, type: 'cut' });
      await page.goto(path, { waitUntil: 'networkidle' });
      await settle(page, 300);
      await snap();
    },
    cut() { events.push({ t, type: 'cut' }); },
    /** Something the app does by itself (a toast, a reload): capture it now. */
    async capture(ms = 150) { await settle(page, ms); await snap(); },
    async finish(duration) {
      const end = Math.max(duration ?? t, t + 0.2);
      if (duration && t > duration + 0.05) console.warn(`  ${film}/${scene}: the action runs ${(t - duration).toFixed(2)}s past its scene`);
      writeFileSync(join(dir, 'take.json'), JSON.stringify({ film, scene, fps: FPS, scale: SCALE, view: VIEW, duration: end, cursor0, frames, events }, null, 1));
      return { dir, frames: frames.length, duration: end };
    },
  };
  return api;
}

/** Every take's frames and events in one file the composition imports. */
export function collectTakes() {
  const out = {};
  const root = join(PUB, 'footage');
  if (existsSync(root)) for (const film of readdirSync(root)) for (const scene of readdirSync(join(root, film))) {
    const f = join(root, film, scene, 'take.json');
    if (!existsSync(f)) continue;
    const tk = JSON.parse(readFileSync(f, 'utf8'));
    out[`${film}/${scene}`] = { ...tk, frames: tk.frames.map((x) => ({ src: `footage/${film}/${scene}/${x.file}`, t: x.t })) };
  }
  mkdirSync(join(ROOT, 'src', 'generated'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'generated', 'takes.json'), JSON.stringify(out));
  return out;
}

/** Keyframes on a virtual clock → an exact 30 fps H.264 clip beside them. */
export function assemble(dir, frames, duration) {
  const list = frames.map((f, i) => {
    const next = i < frames.length - 1 ? frames[i + 1].t : duration;
    return `file '${f.file}'\nduration ${Math.max(1 / FPS, next - f.t).toFixed(4)}`;
  });
  list.push(`file '${frames[frames.length - 1].file}'`);
  writeFileSync(join(dir, 'frames.txt'), list.join('\n'));
  const out = `${dir}.mp4`;
  const r = spawnSync(join(FF_DIR, 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
    '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-t', duration.toFixed(3), out,
  ], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: FF_DIR } });
  if (r.status !== 0) throw new Error(`assemble ${dir}: ${r.stderr}`);
  return out;
}
