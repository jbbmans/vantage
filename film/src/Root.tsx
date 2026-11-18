import { Composition } from 'remotion';
import { Chapter } from './chapters/Chapter';
import { Trailer } from './trailer/Trailer';
import { loadFonts } from './fonts';
import { FPS, H, W } from './theme';
import { TIMELINES } from './timeline';

loadFonts();

export function Root() {
  return (
    <>
      <Composition id="trailer" component={Trailer} durationInFrames={TIMELINES.trailer.frames} fps={FPS} width={W} height={H} />
      {Object.values(TIMELINES).filter((t) => t.kind === 'chapter').map((t) => (
        <Composition key={t.id} id={t.id} component={Chapter} defaultProps={{ id: t.id }} durationInFrames={t.frames} fps={FPS} width={W} height={H} />
      ))}
    </>
  );
}
