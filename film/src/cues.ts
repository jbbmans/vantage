import { scene as sceneOf, type TScene } from './timeline';

export function cues(filmId: string, sceneId: string, fps = 30) {
  const s: TScene = sceneOf(filmId, sceneId);
  const f = (sec: number) => Math.round((sec - s.start) * fps);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}$]/gu, '');
  const words = s.lines.flatMap((l) => l.words);
  return {
    scene: s,
    dur: s.to - s.from,
    w(word: string, { nth = 0, end = false }: { nth?: number; end?: boolean } = {}) {
      const hits = words.filter((x) => norm(x.word) === norm(word));
      const hit = hits[nth] ?? hits[0];
      if (!hit) return f(s.lines[0]?.start ?? s.start);
      return f(end ? hit.end : hit.start);
    },
    line(i: number) { const l = s.lines[i]; return { from: f(l.start), to: f(l.end) }; },
    /** Frames for each word of a line, for word-synced type. */
    wordsOf(i: number) { return s.lines[i].words.map((x) => ({ word: x.word, at: f(x.start) })); },
  };
}
