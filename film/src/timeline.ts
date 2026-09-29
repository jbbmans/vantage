import data from './generated/timelines.json';

export interface TCard { text: string; start: number; end: number; from: number; to: number }
export interface TScene { id: string; cue: string | null; start: number; end: number; from: number; to: number; cards: TCard[] }
export interface TFilm {
  id: string; title: string; slot: string; kind: 'ad' | 'hero' | 'chapter'; n: number | null; accent: string;
  music: { bpm: number }; fps: number; beat: number; seconds: number; frames: number; scenes: TScene[];
}

export const TIMELINES = data as unknown as Record<string, TFilm>;

export const film = (id: string) => {
  const f = TIMELINES[id];
  if (!f) throw new Error(`No timeline for ${id}; run tools/timeline.mjs`);
  return f;
};

export const scene = (filmId: string, sceneId: string) => {
  const s = film(filmId).scenes.find((x) => x.id === sceneId);
  if (!s) throw new Error(`No scene ${sceneId} in ${filmId}`);
  return s;
};

/** A scene's cards with frames counted from the scene's own start, for use inside its Sequence. */
export const localCards = (s: TScene) => s.cards.map((c) => ({ text: c.text, from: c.from - s.from, to: c.to - s.from }));
