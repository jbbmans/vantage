import type { FC } from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { Finish } from '../components/Finish';
import { Mix } from '../components/Mix';
import { cues } from '../cues';
import { film } from '../timeline';
import { C, FONT } from '../theme';
import { Detail, Open, Scatter, Title } from './Act1';
import { Balance, Capture, Case, Queue } from './Act2';
import { Credit, End, Lead, Report, Sealed, Trust } from './Act3';

type Scene = FC<{ c: ReturnType<typeof cues> }>;
const SCENES: Record<string, Scene> = {
  open: Open, detail: Detail, scatter: Scatter, title: Title, capture: Capture, queue: Queue, case: Case,
  balance: Balance, sealed: Sealed, credit: Credit, report: Report, lead: Lead, trust: Trust, end: End,
};

/**
 * The hero film. Every scene is laid on the timeline built from the voice, and cut hard on the
 * boundary: the edit is the voice's rhythm. Grain and vignette go over everything, last.
 */
export function Hero() {
  const tl = film('hero');
  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT }}>
      {tl.scenes.map((s) => {
        const Comp = SCENES[s.id];
        if (!Comp) throw new Error(`No picture for hero scene ${s.id}`);
        return (
          <Sequence key={s.id} from={s.from} durationInFrames={s.to - s.from} name={s.id}>
            <Comp c={cues('hero', s.id)} />
          </Sequence>
        );
      })}
      <Finish grain={0.045} vignette={0.5} />
      <Mix id="hero" />
    </AbsoluteFill>
  );
}
