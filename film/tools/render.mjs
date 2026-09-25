import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'out');
const FF_DIR = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
const ENV = { ...process.env, LD_LIBRARY_PATH: FF_DIR };
const BROWSER = process.env.REMOTION_BROWSER || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const DEMO = process.env.VANTAGE_DEMO_URL || 'http://localhost:8798';

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

function posterFrame(tl) {
  if (tl.id === 'hero') { const s = tl.scenes.find((x) => x.id === 'title'); return Math.round(s.from + (s.to - s.from) * 0.8); }
  const s = tl.scenes[2] ?? tl.scenes[1];
  return Math.round(s.from + (s.to - s.from) * 0.7);
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // 1–2. Voice and timeline.
  const { voiceAll } = await import('./voice.mjs');
  const manifest = await voiceAll({ check: flag('--no-voice') });
  const { buildTimelines, captionsFor } = await import('./timeline.mjs');
  const timelines = buildTimelines(manifest);
  const ids = Object.keys(timelines).filter((id) => !wanted.length || wanted.includes(id));
  if (!ids.length) throw new Error(`no such film: ${wanted.join(', ')}`);
  for (const id of ids) writeFileSync(join(OUT, `${id}.vtt`), captionsFor(timelines[id]));
  const unvoiced = ids.filter((id) => timelines[id].estimated > 0);
  if (unvoiced.length) log(`narration still estimated for: ${unvoiced.join(', ')} — ${flag('--allow-unvoiced') ? 'publishing with music and captions only, as asked' : 'these render as drafts and are not published'}`);

  // 3. Capture.
  if (!flag('--reuse-shots')) {
    const server = await demoServer();
    try {
      const { FILMS } = await import(`./shots.mjs?${Date.now()}`);
      const { launch, collectTakes } = await import('./capture.mjs');
      const browser = await launch();
      for (const id of ids) { log(`capturing ${id}`); await FILMS[id](browser); }
      await browser.close();
      collectTakes();
    } finally { server?.kill(); }
  }

  // 4. Score and mix.
  const { score } = await import(`./score.mjs?${Date.now()}`);
  for (const id of ids) { const r = score(id); log(`mixed ${id}: ${r.voiced ? `${r.voiced} lines of voice` : 'music only'}`); }

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
      ...(id === 'hero' ? { ...ENCODE.hero, ffmpegOverride: keepGrain } : ENCODE.chapter),
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
  for (const id of made) {
    const tl = timelines[id];
    const voiced = tl.estimated === 0;
    if (!voiced && !flag('--allow-unvoiced')) { log(`not publishing ${id}: ${tl.estimated} lines have no recorded voice`); continue; }
    const slot = tl.slot;
    const r = spawnSync(join(FF_DIR, 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(OUT, `${id}.mp4`), '-c', 'copy', '-movflags', '+faststart', join(dest, `${slot}.mp4`)], { env: ENV, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`faststart ${id}: ${r.stderr}`);
    copyFileSync(join(OUT, `${id}.jpg`), join(dest, `${slot}.jpg`));
    copyFileSync(join(OUT, `${id}.vtt`), join(dest, `${slot}.vtt`));
    index[slot] = { src: `/videos/films/${slot}.mp4`, poster: `/videos/films/${slot}.jpg`, captions: `/videos/films/${slot}.vtt`, seconds: Math.round(tl.seconds), published: today, voiced };
    log(`published ${slot}`);
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
