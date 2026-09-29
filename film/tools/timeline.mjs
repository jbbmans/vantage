import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILMS, readingSeconds } from '../src/script.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FPS = 30;

/**
 * Scene and card timings. Each card gets the time it takes to read, rounded up to the next half bar of its
 * film's tempo, so every change of card lands on the music's beat. A scene's floor gives slow actions room.
 */
export function buildTimelines() {
  const films = {};
  for (const film of FILMS) {
    const beat = 60 / film.music.bpm;
    const unit = beat * 2;
    const quant = (s) => Math.max(1, Math.ceil(s / unit - 1e-6)) * unit;
    let t = 0;
    const scenes = [];
    for (const [k, scene] of film.scenes.entries()) {
      const start = t;
      const isTitle = film.kind === 'chapter' && k === 0;
      const isEnd = k === film.scenes.length - 1 && !scene.cards.some((c) => c.trim());
      const floor = isTitle ? 3.6 : isEnd ? 4.6 : 0;
      const cards = scene.cards.map((text) => ({ text, seconds: quant(Math.max(readingSeconds(text, film.kind), text.trim() ? 2.4 : 0.5)) }));
      const natural = cards.reduce((n, c) => n + c.seconds, 0);
      const total = quant(Math.max(natural, scene.min ?? 0, floor));
      cards[cards.length - 1].seconds += total - natural;
      let c0 = start;
      const out = cards.map((c) => { const card = { text: c.text, start: c0, end: c0 + c.seconds }; c0 += c.seconds; return card; });
      scenes.push({ id: scene.id, cue: scene.cue ?? null, start, end: start + total, cards: out });
      t = start + total;
    }
    const f = (s) => Math.round(s * FPS);
    films[film.id] = {
      id: film.id, title: film.title, slot: film.slot, kind: film.kind, n: film.n ?? null, accent: film.accent, music: film.music,
      fps: FPS, beat, seconds: t, frames: f(t),
      scenes: scenes.map((s) => ({ ...s, from: f(s.start), to: f(s.end), cards: s.cards.map((c) => ({ ...c, from: f(c.start), to: f(c.end) })) })),
    };
  }
  mkdirSync(join(ROOT, 'src', 'generated'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'generated', 'timelines.json'), JSON.stringify(films, null, 1));
  return films;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const films = buildTimelines();
  for (const f of Object.values(films)) console.log(`${f.id.padEnd(18)} ${f.seconds.toFixed(1).padStart(5)}s  ${f.scenes.length} scenes  ${f.music.bpm} bpm`);
}
