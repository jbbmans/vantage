import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILMS, estimateSeconds } from '../src/script.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FPS = 30;

export function buildTimelines(manifest) {
  const films = {};
  for (const film of FILMS) {
    let t = 0;
    const scenes = [];
    let estimated = 0;
    for (const scene of film.scenes) {
      const start = t;
      let cursor = start + (scene.lead ?? 0.3);
      const lines = scene.lines.map((line, i) => {
        const vo = manifest[line.id];
        const seconds = vo?.voiced && vo.seconds ? vo.seconds : estimateSeconds(line.text);
        if (!(vo?.voiced)) estimated++;
        const ls = cursor;
        const le = ls + seconds;
        cursor = le + (i < scene.lines.length - 1 ? (line.gap ?? 0.2) : 0);
        const words = vo?.voiced && vo.words?.length
          ? vo.words.map((w) => ({ word: w.word, start: ls + w.start, end: ls + w.end }))
          : spreadWords(line.text, ls, le);
        return { id: line.id, text: line.text, start: ls, end: le, file: vo?.voiced ? vo.file : null, words };
      });
      const natural = cursor + (scene.tail ?? 0.5);
      const end = Math.max(natural, start + (scene.min ?? 0));
      scenes.push({ id: scene.id, cue: scene.cue ?? null, start, end, lines });
      t = end;
    }
    const f = (s) => Math.round(s * FPS);
    films[film.id] = {
      id: film.id, title: film.title, slot: film.slot, fps: FPS, seconds: t, frames: f(t), estimated,
      score: film.score,
      scenes: scenes.map((s) => ({ ...s, from: f(s.start), to: f(s.end), lines: s.lines.map((l) => ({ ...l, from: f(l.start), to: f(l.end) })) })),
    };
  }
  mkdirSync(join(ROOT, 'src', 'generated'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'generated', 'timelines.json'), JSON.stringify(films, null, 1));
  return films;
}

function spreadWords(text, start, end) {
  const words = text.split(/\s+/).filter(Boolean);
  const weight = words.map((w) => w.length + 2);
  const total = weight.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((word, i) => { const d = ((end - start) * weight[i]) / total; const w = { word, start: t, end: t + d }; t += d; return w; });
}

const vttTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export function captionsFor(timeline) {
  const MAX = 62;
  const cues = [];
  const push = (ws) => cues.push({ start: ws[0].start, end: ws[ws.length - 1].end + 0.25, text: ws.map((w) => w.word).join(' ') });
  const split = (ws) => {
    const text = ws.map((w) => w.word).join(' ');
    if (text.length <= MAX || ws.length < 4) { push(ws); return; }
    let best = 0; let bestScore = Infinity; let left = 0;
    for (let i = 0; i < ws.length - 1; i++) {
      left += ws[i].word.length + 1;
      const pause = /[,;:—]$/.test(ws[i].word) ? 30 : 0;
      const clause = /^(and|but|that|which|so|with|or|before|when)$/i.test(ws[i + 1].word) ? 12 : 0;
      const score = Math.abs(left - (text.length - left)) - pause - clause;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    split(ws.slice(0, best + 1)); split(ws.slice(best + 1));
  };
  for (const scene of timeline.scenes) for (const line of scene.lines) {
    let sentence = [];
    for (const w of line.words) {
      sentence.push(w);
      if (/[.?!]["”’]?$/.test(w.word)) { split(sentence); sentence = []; }
    }
    if (sentence.length) split(sentence);
  }
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n')}`;
}
