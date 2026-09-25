import { Audio, staticFile } from 'remotion';
import media from '../generated/media.json';

export function Mix({ id }: { id: string }) {
  const m = (media as { mixes: Record<string, { file: string }> }).mixes[id];
  return m ? <Audio src={staticFile(m.file)} /> : null;
}
