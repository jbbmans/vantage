import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Finish } from '../components/Finish';
import { Mix } from '../components/Mix';
import { Mark } from '../components/Mark';
import { Screen } from '../components/Screen';
import { Eyebrow, Super } from '../components/Super';
import { SyntheticTag } from '../components/Tag';
import { cues } from '../cues';
import { easeInOut, easeOut, p } from '../lib/motion';
import { endCamera, takeOf, VH, VW, WIDE, type Cam } from '../lib/take';
import { film } from '../timeline';
import { C, FONT } from '../theme';

/** Chapter order and the line under each title. */
export const CHAPTER_META: Record<string, { n: number; lede: string }> = {
  'quick-log': { n: 1, lede: 'A record in one sentence.' },
  queue: { n: 2, lede: 'From the queue to a verified outcome.' },
  'reading-a-balance': { n: 3, lede: 'The FMRA desk reference, and its diagnoser.' },
  record: { n: 4, lede: 'What counts, and what never does.' },
  'report-studio': { n: 5, lede: 'JEPES and FITREP input, written from the facts.' },
  'unit-dashboard': { n: 6, lede: 'The section at a glance, and what the numbers cannot say.' },
};

const PLATE_W = 1640;
const PLATE_H = (VH * PLATE_W) / VW;
const PLATE_X = (1920 - PLATE_W) / 2;
const PLATE_Y = (1080 - PLATE_H) / 2 - 6;
const OVERLAP = 8;

export function Chapter({ id }: { id: string }) {
  const tl = film(id);
  const meta = CHAPTER_META[id];
  const [titleScene, ...shots] = tl.scenes;
  // Each take starts where the last one left the camera, so the move is continuous across scenes.
  const starts: Cam[] = [];
  let cam: Cam = WIDE;
  for (const s of shots) { starts.push(cam); cam = endCamera(takeOf(`${id}/${s.id}`), cam); }
  const endLen = 64;

  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT }}>
      <Backdrop glow={0.9} contours={0.06} />
      {/* Grain under the product only: it dithers the backdrop's gradients without touching the UI. */}
      <Finish grain={0.035} vignette={0} />
      <Sequence from={titleScene.from} durationInFrames={titleScene.to - titleScene.from + 20} name="title">
        <TitleCard filmId={id} sceneId={titleScene.id} n={meta.n} lede={meta.lede} out={titleScene.to - titleScene.from - 16} />
      </Sequence>
      {shots.map((s, i) => (
        <Sequence key={s.id} from={s.from} durationInFrames={s.to - s.from + (i < shots.length - 1 ? OVERLAP : 0)} name={s.id}>
          <Shot takeKey={`${id}/${s.id}`} startCam={starts[i]} first={i === 0} fadeIn={i > 0} end={i === shots.length - 1 ? s.to - s.from - endLen : null} />
        </Sequence>
      ))}
      <Sequence from={shots[0].from} durationInFrames={tl.frames - shots[0].from} name="labels">
        <Labels title={tl.title} n={meta.n} total={tl.frames - shots[0].from - endLen} />
      </Sequence>
      <Sequence from={tl.frames - endLen} durationInFrames={endLen} name="end">
        <EndCard title={tl.title} n={meta.n} />
      </Sequence>
      {/* No grain over the product: it costs legibility and bitrate. */}
      <Finish grain={0} vignette={0.38} />
      <Mix id={id} />
    </AbsoluteFill>
  );
}

function TitleCard({ filmId, sceneId, n, lede, out }: { filmId: string; sceneId: string; n: number; lede: string; out: number }) {
  const f = useCurrentFrame();
  const c = cues(filmId, sceneId);
  const words = c.wordsOf(0);
  const leave = p(f, out, out + 14, easeInOut);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 180px', opacity: 1 - leave, transform: `translateY(${-leave * 50}px)`, filter: leave > 0.01 ? `blur(${leave * 8}px)` : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 34 }}>
        <Mark size={64} at={2} />
        <Eyebrow text={`Field guide · ${String(n).padStart(2, '0')}`} at={6} />
      </div>
      <Super words={words.map((w) => w.word)} at={words.map((w) => w.at - 4)} size={148} weight={600} tracking={-0.05} />
      <div style={{ marginTop: 26, fontSize: 40, color: C.soft, fontWeight: 400, letterSpacing: '-0.015em', opacity: p(f, words[words.length - 1].at + 4, words[words.length - 1].at + 24), transform: `translateY(${(1 - p(f, words[words.length - 1].at + 4, words[words.length - 1].at + 24)) * 14}px)` }}>{lede}</div>
    </AbsoluteFill>
  );
}

function Shot({ takeKey, startCam, first, fadeIn, end }: { takeKey: string; startCam: Cam; first: boolean; fadeIn: boolean; end: number | null }) {
  const f = useCurrentFrame();
  const enter = first ? p(f, 2, 30, easeOut) : 1;
  const o = fadeIn ? p(f, 0, OVERLAP - 1, easeInOut) : 1;
  const recede = end != null ? p(f, end, end + 30, easeInOut) : 0;
  return (
    <AbsoluteFill style={{ opacity: o * enter }}>
      <div style={{
        position: 'absolute', left: PLATE_X, top: PLATE_Y,
        transform: `translateY(${(1 - enter) * 90}px) scale(${(0.955 + enter * 0.045) * (1 - recede * 0.07)})`,
        filter: recede > 0.01 ? `blur(${recede * 10}px) brightness(${1 - recede * 0.55})` : first && enter < 0.99 ? `blur(${(1 - enter) * 10}px)` : undefined,
      }}>
        <Screen take={takeKey} width={PLATE_W} startCam={startCam} />
      </div>
    </AbsoluteFill>
  );
}

function Labels({ title, n, total }: { title: string; n: number; total: number }) {
  const f = useCurrentFrame();
  const o = p(f, 10, 40) * (1 - p(f, total - 10, total + 20));
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: PLATE_X + 4, bottom: 26, display: 'flex', alignItems: 'center', gap: 12, fontSize: 17, letterSpacing: '0.02em', color: 'rgba(201,213,232,0.7)', opacity: o }}>
        <span style={{ fontWeight: 600, color: C.teal, letterSpacing: '0.16em', fontSize: 14 }}>{String(n).padStart(2, '0')}</span>
        <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)' }} />
        <span>{title}</span>
      </div>
      <div style={{ opacity: o }}><SyntheticTag at={0} /></div>
      <div style={{ position: 'absolute', left: PLATE_X, right: PLATE_X, bottom: 16, height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 2, opacity: o }}>
        <div style={{ width: `${Math.min(100, (f / total) * 100)}%`, height: '100%', background: 'linear-gradient(90deg, rgba(63,208,189,0.3), rgba(63,208,189,0.8))', borderRadius: 2 }} />
      </div>
    </AbsoluteFill>
  );
}

function EndCard({ title, n }: { title: string; n: number }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const i = p(f, 14, 40);
  const black = p(f, durationInFrames - 12, durationInFrames - 1, easeInOut);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ opacity: i, transform: `translateY(${(1 - i) * 20}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <Mark size={96} at={12} />
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: '0.34em', color: C.white, marginRight: '-0.34em' }}>VANTAGE</div>
        <div style={{ fontSize: 20, color: C.soft, letterSpacing: '0.02em' }}>Field guide · {String(n).padStart(2, '0')} · {title}</div>
      </div>
      <AbsoluteFill style={{ background: '#000', opacity: black }} />
    </AbsoluteFill>
  );
}
