import data from './generated/timelines.json';

export interface Word { word: string; start: number; end: number }
export interface TLine { id: string; text: string; start: number; end: number; from: number; to: number; file: string | null; words: Word[] }
export interface TScene { id: string; cue: string | null; start: number; end: number; from: number; to: number; lines: TLine[] }
export interface TFilm { id: string; title: string; slot: string; fps: number; seconds: number; frames: number; estimated: number; scenes: TScene[] }

export const TIMELINES = data as unknown as Record<string, TFilm>;

export const film = (id: string) => {
  const f = TIMELINES[id];
  if (!f) throw new Error(`No timeline for ${id}; run tools/render.mjs --timeline`);
  return f;
};

export const scene = (filmId: string, sceneId: string) => {
  const s = film(filmId).scenes.find((x) => x.id === sceneId);
  if (!s) throw new Error(`No scene ${sceneId} in ${filmId}`);
  return s;
};

/** Frame (film-absolute) at which a word of a line begins; matches loosely, ignoring punctuation. */
export const wordFrame = (s: TScene, lineIndex: number, word: string, fps = 30, nth = 0) => {
  const line = s.lines[lineIndex];
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9$]/g, '');
  const hits = line.words.filter((w) => norm(w.word) === norm(word));
  const w = hits[nth] || hits[0];
  return Math.round((w ? w.start : line.start) * fps);
};
