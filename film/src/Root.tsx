import { Composition } from 'remotion';
import { Chapter } from './chapters/Chapter';
import { Ad, Tour } from './story/Story';
import { loadFonts } from './fonts';
import { FPS, H, W } from './theme';
import { TIMELINES } from './timeline';

loadFonts();

export function Root() {
  return (
    <>
      <Composition id="ad" component={Ad} durationInFrames={TIMELINES.ad.frames} fps={FPS} width={W} height={H} />
      <Composition id="hero" component={Tour} durationInFrames={TIMELINES.hero.frames} fps={FPS} width={W} height={H} />
      {Object.values(TIMELINES).filter((t) => t.kind === 'chapter').map((t) => (
        <Composition key={t.id} id={t.id} component={Chapter} defaultProps={{ id: t.id }} durationInFrames={t.frames} fps={FPS} width={W} height={H} />
      ))}
    </>
  );
}
