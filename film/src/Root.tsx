import { Composition } from 'remotion';
import { Chapter } from './chapters/Chapter';
import { Hero } from './hero/Hero';
import { loadFonts } from './fonts';
import { FPS, H, W } from './theme';
import { TIMELINES } from './timeline';

loadFonts();

const CHAPTERS = ['quick-log', 'queue', 'reading-a-balance', 'record', 'report-studio', 'unit-dashboard', 'first-week', 'visibility', 'import', 'analysis', 'counseling', 'setup', 'governance'];

export function Root() {
  return (
    <>
      <Composition id="hero" component={Hero} durationInFrames={TIMELINES.hero.frames} fps={FPS} width={W} height={H} />
      {CHAPTERS.map((id) => (
        <Composition key={id} id={id} component={Chapter} defaultProps={{ id }} durationInFrames={TIMELINES[id].frames} fps={FPS} width={W} height={H} />
      ))}
    </>
  );
}
