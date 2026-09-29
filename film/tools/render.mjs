import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'out');
const FF_DIR = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
const ENV = { ...process.env, LD_LIBRARY_PATH: FF_DIR };
const BROWSER = process.env.REMOTION_BROWSER || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const DEMO = process.env.VANTAGE_DEMO_URL || 'http://localhost:8798';
const INSTANCE = process.env.VANTAGE_FILM_INSTANCE_URL || 'http://localhost:8799';
/** Films shot on a fresh accounts-mode instance, in the order they must run: setup needs it empty. */
const ON_INSTANCE = ['setup', 'governance', 'first-week'];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const wanted = args.filter((a) => !a.startsWith('--'));
const log = (...m) => console.log('film:', ...m);

const ENCODE = {
  hero: { crf: 17, encodingMaxRate: '8M', encodingBufferSize: '16M' },
  chapter: { crf: 21, encodingMaxRate: '3500k', encodingBufferSize: '7000k' },
};

const keepGrain = ({ args }) => {
  const i = args.indexOf('libx264');
  return i < 0 ? args : [...args.slice(0, i + 1), '-tune', 'grain', ...args.slice(i + 1)];
};

async function demoServer() {
  const up = async () => { try { return (await fetch(`${DEMO}/api/health`)).ok; } catch { return false; } };
  if (await up()) return null;
  if (!existsSync(join(REPO, 'dist', 'index.html'))) {
    log('building the application for the demo');
    const b = spawnSync('npm', ['run', '-s', 'build'], { cwd: REPO, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('npm run build failed');
  }
  log('starting the synthetic demo');
  const child = spawn(process.execPath, ['tests/browser/demo-server.ts'], { cwd: REPO, env: { ...process.env, VANTAGE_DEMO_PORT: new URL(DEMO).port || '8798' }, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { if (await up()) return child; await new Promise((r) => setTimeout(r, 250)); }
  child.kill();
  throw new Error('the demo server did not start');
}

/** Always a fresh instance: the setup film begins from an empty one. */
async function instanceServer() {
  const up = async () => { try { return (await fetch(`${INSTANCE}/api/health`)).ok; } catch { return false; } };
  if (await up()) throw new Error(`something is already listening on ${INSTANCE}; stop it so the setup film can start from an empty instance`);
  log('starting a fresh film instance');
  const child = spawn(process.execPath, ['film/tools/instance.ts'], { cwd: REPO, env: { ...process.env, VANTAGE_FILM_INSTANCE_PORT: new URL(INSTANCE).port || '8799' }, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { if (await up()) return child; await new Promise((r) => setTimeout(r, 250)); }
  child.kill();
  throw new Error('the film instance did not start');
}

/** The poster: the logo for the ad and the tour, the title card for a chapter. */
function posterFrame(tl) {
  const s = tl.id === 'hero' ? tl.scenes.find((x) => x.id === 'title') : tl.id === 'ad' ? tl.scenes.find((x) => x.id === 'ad-logo') : tl.scenes[0];
  return Math.round(s.from + (s.to - s.from) * 0.85);
}

/** Fonts and brand art come from the application, so the films always match it. */
function stagePublic() {
  for (const dir of ['fonts', 'brand']) {
    rmSync(join(ROOT, 'public', dir), { recursive: true, force: true });
    cpSync(join(REPO, 'public', dir), join(ROOT, 'public', dir), { recursive: true });
  }
  measureStills();
}

/** Each still's pixel size, read from its PNG header, so a still is never drawn stretched. */
export function measureStills() {
  const dir = join(ROOT, 'public', 'screens');
  const sizes = {};
  if (existsSync(dir)) for (const f of readdirSync(dir)) {
    if (!f.endsWith('.png')) continue;
    const b = readFileSync(join(dir, f));
    sizes[f.slice(0, -4)] = [b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  mkdirSync(join(ROOT, 'src', 'generated'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'generated', 'stills.json'), JSON.stringify(sizes, null, 1));
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // 1. Timeline: cards timed for reading, on the beat.
  stagePublic();
  const { buildTimelines } = await import('./timeline.mjs');
  const timelines = buildTimelines();
  const ids = Object.keys(timelines).filter((id) => !wanted.length || wanted.includes(id));
  if (!ids.length) throw new Error(`no such film: ${wanted.join(', ')}`);

  // 3. Capture.
  if (!flag('--reuse-shots')) {
    const server = await demoServer();
    const instance = ids.some((id) => ON_INSTANCE.includes(id)) ? await instanceServer() : null;
    try {
      const { FILMS } = await import(`./shots.mjs?${Date.now()}`);
      const { launch, collectTakes } = await import('./capture.mjs');
      const browser = await launch();
      const order = [...ids].sort((a, b) => (ON_INSTANCE.indexOf(a) + 1 || 99) - (ON_INSTANCE.indexOf(b) + 1 || 99));
      for (const id of order) { log(`capturing ${id}`); await FILMS[id](browser); }
      await browser.close();
      collectTakes();
      measureStills();
    } finally { server?.kill(); instance?.kill(); }
  }

  if (flag('--capture-only')) { log('captured; stopping as asked'); return; }

  // 4. Score and mix.
  const { score } = await import(`./score.mjs?${Date.now()}`);
  for (const id of ids) { const r = score(id); log(`scored ${id}: ${r.seconds.toFixed(1)}s, ${r.style}`); }

  // 5. Render.
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, renderStill, selectComposition } = await import('@remotion/renderer');
  log('bundling');
  const serveUrl = await bundle({ entryPoint: join(ROOT, 'src', 'index.ts'), publicDir: join(ROOT, 'public'), onProgress: () => {} });
  const made = [];
  for (const id of ids) {
    const composition = await selectComposition({ serveUrl, id, browserExecutable: BROWSER });
    const output = join(OUT, `${id}.mp4`);
    const t0 = Date.now(); let last = -1;
    await renderMedia({
      serveUrl, composition, codec: 'h264', outputLocation: output, browserExecutable: BROWSER,
      audioCodec: 'aac', audioBitrate: '192k', x264Preset: 'slow', pixelFormat: 'yuv420p', colorSpace: 'bt709',
      ...(id === 'hero' || id === 'ad' ? { ...ENCODE.hero, ffmpegOverride: keepGrain } : ENCODE.chapter),
      concurrency: Number(process.env.FILM_CONCURRENCY || 3),
      onProgress: ({ progress }) => { const p = Math.floor(progress * 10); if (p !== last) { last = p; process.stdout.write(`\rfilm: rendering ${id} ${p * 10}%   `); } },
    });
    process.stdout.write('\n');
    const poster = join(OUT, `${id}.jpg`);
    await renderStill({ serveUrl, composition, frame: posterFrame(timelines[id]), output: poster, imageFormat: 'jpeg', jpegQuality: 86, browserExecutable: BROWSER });
    log(`rendered ${id} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    made.push(id);
  }

  // 6. Publish.
  if (flag('--draft')) { log(`drafts in ${OUT}; nothing published`); return; }
  const dest = join(REPO, 'public', 'videos', 'films');
  mkdirSync(dest, { recursive: true });
  const indexPath = join(REPO, 'src', 'config', 'films.generated.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const today = new Date().toISOString().slice(0, 10);
  const url = (file) => `/videos/films/${file}?v=${createHash('sha256').update(readFileSync(join(dest, file))).digest('hex').slice(0, 10)}`;
  for (const id of made) {
    const tl = timelines[id];
    const slot = tl.slot;
    const r = spawnSync(join(FF_DIR, 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(OUT, `${id}.mp4`), '-c', 'copy', '-movflags', '+faststart', join(dest, `${slot}.mp4`)], { env: ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`faststart ${id}: ${r.stderr}`);
    copyFileSync(join(OUT, `${id}.jpg`), join(dest, `${slot}.jpg`));
    // No narration: the words are on screen, so there is nothing for a caption track to add.
    rmSync(join(dest, `${slot}.vtt`), { force: true });
    index[slot] = { src: url(`${slot}.mp4`), poster: url(`${slot}.jpg`), seconds: Math.round(tl.seconds), published: today, textOnly: true };
    log(`published ${slot}`);
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
