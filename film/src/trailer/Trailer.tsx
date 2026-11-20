import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { Caption } from '../components/Caption';
import { Finish } from '../components/Finish';
import { Wordmark } from '../components/Kit';
import { Mark } from '../components/Mark';
import { Mix } from '../components/Mix';
import { Screen } from '../components/Screen';
import { easeIn, easeInOut, easeOut, land, p } from '../lib/motion';
import { VH, VW, WIDE } from '../lib/take';
import { film, localCards, type TScene } from '../timeline';
import { DB, FONT, MONO, SERIF } from '../theme';

/**
 * The trailer (ADR-0036). The application in its own frame: the coat's navy, a gold eyebrow naming each of the
 * ten outcomes, the gold-over-scarlet piping the application draws under every page title, and the real application in
 * a window beneath, the camera pushing in on what the words are about. Every product shot is marked as demo data, and the
 * end card says what the application's own footer says. No address, no sign-up: this is an application a command runs,
 * not a site.
 */

const PLATE_W = 1400;
const PLATE_H = (VH * PLATE_W) / VW;
const PLATE_X = (1920 - PLATE_W) / 2;
const PLATE_Y = 236;
const PIPING_Y = 212;
const OVERLAP = 10;
const ID = 'trailer';

/** What the end card says beneath the mark: what the demo's own banner says. */
export const FINE_PRINT = 'Synthetic demo data.';

export function Trailer() {
  const tl = film(ID);
  const { fps } = useVideoConfig();
  const accent = DB.gold;
  const at = (id: string) => {
    const s = tl.scenes.find((x) => x.id === id);
    if (!s) throw new Error(`No scene ${id} in the trailer`);
    return s;
  };
  const open = at('t-open');
  const title = at('t-title');
  const end = at('t-end');
  const shots = tl.scenes.slice(tl.scenes.indexOf(title) + 1, tl.scenes.indexOf(end));
  const outcomes = shots.filter((s) => s.outcome);
  const first = shots[0];
  const windowFrom = first.from - 16;

  return (
    <AbsoluteFill style={{ background: DB.deep, fontFamily: FONT }}>
      <Ground />

      {/* The cold open: one line, in the serif of a page title. */}
      <Sequence from={open.from} durationInFrames={open.to - open.from + 10} name="open">
        <Opening scene={open} />
      </Sequence>

      <Sequence from={title.from} durationInFrames={title.to - title.from + 12} name="title">
        <TitleCard out={title.to - title.from - 12} />
      </Sequence>

      {/* The window rises in under the first outcome and leaves as one piece before the end card. */}
      <Sequence from={windowFrom} durationInFrames={end.from - windowFrom + 30} name="window">
        <Stage leaveAt={end.from - windowFrom}>
          <Plate />
          {shots.map((s, i) => {
            const early = i === 0 ? s.from - windowFrom : 0;
            return (
              <Sequence key={s.id} from={s.from - windowFrom - early} durationInFrames={s.to - s.from + early + (i < shots.length - 1 ? OVERLAP : 30)} name={s.id}>
                <Footage takeKey={`${ID}/${s.id}`} fadeIn={i > 0} offset={-early / fps} />
              </Sequence>
            );
          })}
        </Stage>
      </Sequence>

      {/* The masthead: eyebrow, words, piping and the ten marks. */}
      <Sequence from={first.from} durationInFrames={end.from - first.from} name="masthead">
        <Masthead shots={shots} outcomes={outcomes} origin={first.from} total={end.from - first.from} />
      </Sequence>
      {shots.map((s, i) => (
        <Sequence key={`c-${s.id}`} from={s.from} durationInFrames={s.to - s.from + 14} name={`words ${s.id}`}>
          {localCards(s).map((c, k) => (
            <div key={k} style={{ position: 'absolute', left: PLATE_X, top: 96, width: PLATE_W }}>
              <Caption text={c.text} from={c.from + (k === 0 && i === 0 ? 10 : 2)} to={c.to} accent={accent} size={c.text.length > 84 ? 42 : 48} maxWidth={PLATE_W} />
            </div>
          ))}
        </Sequence>
      ))}

      <Sequence from={end.from} durationInFrames={end.to - end.from} name="end">
        <EndCard />
      </Sequence>
      <Finish grain={0} vignette={0.36} />
      <Mix id={ID} />
    </AbsoluteFill>
  );
}

/** The coat: deep navy, lifted a little towards the top, as the masthead is. */
function Ground() {
  const f = useCurrentFrame();
  const drift = Math.sin(f / 240) * 3;
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(1500px 760px at ${50 + drift}% -8%, rgba(26,48,92,0.95), rgba(12,25,48,0.6) 46%, transparent 76%),
        radial-gradient(900px 420px at 12% 104%, rgba(222,178,72,0.07), transparent 70%),
        linear-gradient(180deg, ${DB.navy} 0%, ${DB.deep} 100%)`,
    }} />
  );
}

/** The application's piping: a gold pinline over a scarlet stripe, drawn in from the left. */
function Piping({ width, at = 0, style }: { width: number; at?: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const k = p(f, at, at + 28, easeInOut);
  return (
    <div style={{ width: width * k, ...style }}>
      <div style={{ height: 2, background: DB.gold }} />
      <div style={{ height: 2 }} />
      <div style={{ height: 4, background: DB.scarlet }} />
    </div>
  );
}

function Opening({ scene }: { scene: TScene }) {
  const cards = localCards(scene);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      {cards.map((c, i) => (
        <div key={i} style={{ position: 'absolute', left: 240, right: 240, top: 430, display: 'flex', justifyContent: 'center' }}>
          <Caption text={c.text} from={c.from + 8} to={c.to} accent={DB.gold} size={76} align="center" maxWidth={1400}
            style={{ fontFamily: SERIF, fontWeight: 400, letterSpacing: '-0.012em', lineHeight: 1.12 }} />
        </div>
      ))}
    </AbsoluteFill>
  );
}

function TitleCard({ out }: { out: number }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leave = p(f, out, out + 12, easeInOut);
  const bloom = p(f, 0, 50, easeOut);
  return (
    <AbsoluteFill style={{ opacity: 1 - leave, filter: leave > 0.01 ? `blur(${leave * 8}px)` : undefined }}>
      <AbsoluteFill style={{ background: `radial-gradient(760px 420px at 50% 44%, rgba(222,178,72,${0.10 * bloom}), transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ marginTop: -60, transform: `scale(${0.96 + 0.04 * land(f, fps, 0, 20)})` }}><Mark size={180} at={1} /></div>
        <div style={{ marginTop: 46, opacity: p(f, 10, 26), transform: `translateY(${(1 - p(f, 10, 30)) * 14}px)` }}><Wordmark size={62} spacing={0.36} /></div>
        <Piping width={360} at={18} style={{ marginTop: 34 }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Everything in the window moves together: it rises in, and at the end it steps back and fades. */
function Stage({ leaveAt, children }: { leaveAt: number; children: ReactNode }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = land(f, fps, 0, 20);
  const out = p(f, leaveAt, leaveAt + 24, easeIn);
  return (
    <AbsoluteFill style={{
      transform: `translateY(${(1 - k) * 380 + out * 36}px) scale(${1 - out * 0.06})`, transformOrigin: '50% 60%',
      opacity: Math.min(1, k * 1.6) * (1 - out), filter: out > 0.01 ? `blur(${out * 10}px)` : undefined,
    }}>{children}</AbsoluteFill>
  );
}

/** The window: no browser chrome, a gold hairline and a deep navy shadow, as a plate on the coat. */
function Plate() {
  return (
    <div style={{
      position: 'absolute', left: PLATE_X - 1, top: PLATE_Y - 1, width: PLATE_W + 2, height: PLATE_H + 2, borderRadius: 10,
      boxShadow: '0 0 0 1px rgba(222,178,72,0.32), 0 70px 150px -50px rgba(0,0,0,0.85), 0 26px 60px -30px rgba(2,8,20,0.75)',
    }} />
  );
}

function Footage({ takeKey, fadeIn, offset }: { takeKey: string; fadeIn: boolean; offset: number }) {
  const f = useCurrentFrame();
  const o = fadeIn ? p(f, 0, OVERLAP - 1, easeInOut) : 1;
  return (
    <div style={{ position: 'absolute', left: PLATE_X, top: PLATE_Y, width: PLATE_W, height: PLATE_H, borderRadius: 9, overflow: 'hidden', opacity: o }}>
      <Screen take={takeKey} width={PLATE_W} startCam={WIDE} chrome={false} radius={0} offset={offset} />
    </div>
  );
}

/**
 * The eyebrow names the outcome on screen (gold, with a short rule, as on every page's masthead); the ten marks say
 * how far through the ten the film is; "Demo data" stands beside them the whole time the application is on screen.
 */
function Masthead({ shots, outcomes, origin, total }: { shots: TScene[]; outcomes: TScene[]; origin: number; total: number }) {
  const f = useCurrentFrame();
  const o = p(f, 4, 22) * (1 - p(f, total - 14, total));
  const now = origin + f;
  const current = [...shots].reverse().find((s) => now >= s.from) ?? shots[0];
  const done = outcomes.filter((s) => now >= s.from).length;
  const n = current.outcome ? outcomes.indexOf(current) + 1 : 0;
  const since = now - current.from;
  const swap = p(since, 0, 10, easeOut);
  return (
    <AbsoluteFill style={{ opacity: o, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: PLATE_X, top: 52, height: 26, display: 'flex', alignItems: 'center', gap: 14, fontFamily: FONT, fontSize: 18, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', color: DB.gold }}>
        <span style={{ width: 40, height: 2, background: DB.gold }} />
        <span style={{ opacity: swap, transform: `translateY(${(1 - swap) * 8}px)`, display: 'flex', gap: 14 }}>
          {current.outcome ? <><span style={{ fontFamily: MONO, letterSpacing: '0.08em' }}>{String(n).padStart(2, '0')}</span><span>{current.outcome}</span></> : <span>Vantage</span>}
        </span>
      </div>
      <div style={{ position: 'absolute', right: PLATE_X, top: 52, height: 26, display: 'flex', alignItems: 'center', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} aria-hidden>
          {outcomes.map((s, i) => <span key={s.id} style={{ width: i < done ? 20 : 8, height: 5, borderRadius: 1, background: i < done ? DB.gold : 'rgba(201,210,227,0.24)' }} />)}
        </div>
        <span style={{ fontFamily: MONO, fontSize: 15, color: DB.soft, letterSpacing: '0.06em', minWidth: 62, textAlign: 'right' }}>{String(done).padStart(2, '0')} / {outcomes.length}</span>
        <span style={{ fontFamily: FONT, fontSize: 15, letterSpacing: '0.08em', color: 'rgba(201,210,227,0.7)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: DB.gold }} />Demo data
        </span>
      </div>
      <div style={{ position: 'absolute', left: PLATE_X, top: PIPING_Y }}><Piping width={PLATE_W} at={0} /></div>
    </AbsoluteFill>
  );
}

function EndCard() {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const black = p(f, d - 16, d - 1, easeInOut);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ marginTop: -50 }}><Mark size={132} at={6} /></div>
        <div style={{ marginTop: 40, opacity: p(f, 16, 32), transform: `translateY(${(1 - p(f, 16, 36)) * 14}px)` }}><Wordmark size={46} spacing={0.36} /></div>
        <Piping width={300} at={24} style={{ marginTop: 30 }} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 72, textAlign: 'center', fontFamily: FONT, fontSize: 21, color: 'rgba(201,210,227,0.72)', letterSpacing: '0.02em', opacity: p(f, 30, 50) }}>
        {FINE_PRINT}
      </div>
      <AbsoluteFill style={{ background: '#000', opacity: black }} />
    </AbsoluteFill>
  );
}
