import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Caption, DemoTag, Kicker } from '../components/Caption';
import { Finish } from '../components/Finish';
import { Wordmark } from '../components/Kit';
import { Mark } from '../components/Mark';
import { Mix } from '../components/Mix';
import { Screen } from '../components/Screen';
import { easeIn, easeInOut, easeOut, land, p } from '../lib/motion';
import { endCamera, takeOf, VH, VW, WIDE, type Cam } from '../lib/take';
import { film, localCards } from '../timeline';
import { C, FONT, MONO } from '../theme';

const PLATE_W = 1460;
const BAR = 30;
const PLATE_H = (VH * PLATE_W) / VW + BAR;
const PLATE_X = (1920 - PLATE_W) / 2;
const PLATE_Y = 214;
const OVERLAP = 8;

export function Chapter({ id }: { id: string }) {
  const tl = film(id);
  const accent = tl.accent;
  const [titleScene, ...rest] = tl.scenes;
  const endScene = rest[rest.length - 1];
  const shots = rest.slice(0, -1);
  const starts: Cam[] = [];
  let cam: Cam = WIDE;
  for (const s of shots) { starts.push(cam); cam = endCamera(takeOf(`${id}/${s.id}`), cam); }
  const n = String(tl.n).padStart(2, '0');
  const windowFrom = titleScene.to - 18;

  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT }}>
      <Backdrop glow={0.95} contours={0.06} accent={accent} />
      <Finish grain={0.03} vignette={0} />

      {/* The window rises in under the title with its first frame already in it, and leaves as one piece. */}
      <Sequence from={windowFrom} durationInFrames={endScene.from - windowFrom + 40} name="window">
        <Stage leaveAt={endScene.from - windowFrom}>
          <Frame />
          {shots.map((s, i) => {
            const early = i === 0 ? s.from - windowFrom : 0;
            return (
              <Sequence key={s.id} from={s.from - windowFrom - early} durationInFrames={s.to - s.from + early + (i < shots.length - 1 ? OVERLAP : 40)} name={s.id}>
                <Footage takeKey={`${id}/${s.id}`} startCam={starts[i]} fadeIn={i > 0} offset={-early / 30} />
              </Sequence>
            );
          })}
          <Glass />
        </Stage>
      </Sequence>

      {/* The words. */}
      {shots.map((s, i) => (
        <Sequence key={`c-${s.id}`} from={s.from} durationInFrames={s.to - s.from + 14} name={`card ${s.id}`}>
          {localCards(s).map((c, k) => (
            <div key={k} style={{ position: 'absolute', left: PLATE_X, top: 94, width: PLATE_W - 240 }}>
              <Caption text={c.text} from={c.from + (k === 0 && i === 0 ? 8 : 2)} to={c.to} accent={accent} />
            </div>
          ))}
        </Sequence>
      ))}
      <Sequence from={shots[0].from} durationInFrames={endScene.from - shots[0].from} name="header">
        <Header n={n} title={tl.title} accent={accent} steps={shots.map((s) => s.from - shots[0].from)} total={endScene.from - shots[0].from} />
      </Sequence>

      <Sequence from={titleScene.from} durationInFrames={titleScene.to - titleScene.from + 10} name="title">
        <TitleCard n={n} title={tl.title} accent={accent} out={titleScene.to - titleScene.from - 14} />
      </Sequence>
      <Sequence from={endScene.from} durationInFrames={endScene.to - endScene.from} name="end">
        <EndCard n={n} title={tl.title} accent={accent} />
      </Sequence>
      <Finish grain={0} vignette={0.34} />
      <Mix id={id} />
    </AbsoluteFill>
  );
}

/** Everything in the window moves together: it rises in, and at the end it steps back and fades. */
function Stage({ leaveAt, children }: { leaveAt: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = land(f, fps, 0, 20);
  const out = p(f, leaveAt, leaveAt + 26, easeIn);
  return (
    <AbsoluteFill style={{
      transform: `translateY(${(1 - k) * 420 + out * 40}px) scale(${1 - out * 0.08})`, transformOrigin: '50% 60%',
      opacity: Math.min(1, k * 1.6) * (1 - out), filter: out > 0.01 ? `blur(${out * 10}px)` : undefined,
    }}>{children}</AbsoluteFill>
  );
}

/** The window's frame: a title bar and a deep shadow. */
function Frame() {
  return (
    <div style={{ position: 'absolute', left: PLATE_X, top: PLATE_Y, width: PLATE_W, height: PLATE_H }}>
      <div style={{ position: 'absolute', inset: -1, borderRadius: 18, background: '#0d1a2e', boxShadow: '0 0 0 1px rgba(255,255,255,0.10), 0 80px 160px -50px rgba(0,0,0,0.85), 0 30px 60px -30px rgba(2,8,20,0.7)' }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: PLATE_W, height: BAR, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16 }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c, opacity: 0.85 }} />)}
      </div>
    </div>
  );
}

/** A faint sheen over the whole window, drawn once above the footage. */
function Glass() {
  return (
    <div style={{ position: 'absolute', left: PLATE_X, top: PLATE_Y + BAR, width: PLATE_W, height: PLATE_H - BAR, borderRadius: '0 0 18px 18px', overflow: 'hidden', pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(125deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 28%)' }} />
    </div>
  );
}

function Footage({ takeKey, startCam, fadeIn, offset }: { takeKey: string; startCam: Cam; fadeIn: boolean; offset: number }) {
  const f = useCurrentFrame();
  const o = fadeIn ? p(f, 0, OVERLAP - 1, easeInOut) : 1;
  return (
    <div style={{ position: 'absolute', left: PLATE_X, top: PLATE_Y + BAR, width: PLATE_W, height: PLATE_H - BAR, borderRadius: '0 0 18px 18px', overflow: 'hidden', opacity: o }}>
      <Screen take={takeKey} width={PLATE_W} startCam={startCam} chrome={false} radius={0} offset={offset} />
    </div>
  );
}

function Header({ n, title, accent, steps, total }: { n: string; title: string; accent: string; steps: number[]; total: number }) {
  const f = useCurrentFrame();
  const o = p(f, 6, 26) * (1 - p(f, total - 16, total));
  const current = steps.filter((s) => f >= s).length;
  return (
    <AbsoluteFill style={{ opacity: o, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: PLATE_X, top: 50 }}>
        <Kicker accent={accent}><Mark size={24} still /><span>Field guide {n}</span><span style={{ color: 'rgba(201,213,232,0.55)' }}>·</span><span style={{ color: C.soft }}>{title}</span></Kicker>
      </div>
      <div style={{ position: 'absolute', right: PLATE_X, top: 52, display: 'flex', alignItems: 'center', gap: 22 }}>
        <DemoTag />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {steps.map((_, i) => <span key={i} style={{ width: i < current ? 22 : 8, height: 6, borderRadius: 3, background: i < current ? accent : 'rgba(201,213,232,0.22)', transition: 'none' }} />)}
        </div>
        <span style={{ fontFamily: MONO, fontSize: 15, color: C.soft, letterSpacing: '0.06em' }}>{current} / {steps.length}</span>
      </div>
    </AbsoluteFill>
  );
}

function TitleCard({ n, title, accent, out }: { n: string; title: string; accent: string; out: number }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leave = p(f, out, out + 14, easeInOut);
  const words = title.split(' ');
  const rule = p(f, 10, 40, easeOut);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 200px', opacity: 1 - leave, transform: `translateY(${-leave * 60}px)`, filter: leave > 0.01 ? `blur(${leave * 8}px)` : undefined }}>
      <div style={{ marginTop: -120 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 38 }}>
          <Mark size={62} at={2} />
          <Kicker accent={accent} at={8} style={{ fontSize: 21 }}><span style={{ width: 44 * rule, height: 2, background: accent, display: 'inline-block' }} />Field guide {n}</Kicker>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 150, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 0.98, color: '#fff' }}>
          {words.map((w, i) => {
            const t = land(f, fps, 10 + i * 4, 18);
            return <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', opacity: Math.min(1, t * 1.3), transform: `translateY(${(1 - t) * 40}px)`, filter: t < 0.98 ? `blur(${(1 - t) * 10}px)` : undefined }}>{w}{i < words.length - 1 ? ' ' : ''}</span>;
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function EndCard({ n, title, accent }: { n: string; title: string; accent: string }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const i = p(f, 16, 40);
  const black = p(f, durationInFrames - 14, durationInFrames - 1, easeInOut);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ opacity: i, transform: `translateY(${(1 - i) * 20}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        <Mark size={104} at={14} />
        <Wordmark size={34} spacing={0.36} />
        <div style={{ fontFamily: FONT, fontSize: 21, color: C.soft, letterSpacing: '0.02em' }}>Field guide {n} · {title}</div>
        <div style={{ marginTop: 18, fontFamily: FONT, fontSize: 24, fontWeight: 600, color: accent, letterSpacing: '0.02em', opacity: p(f, 30, 50) }}>vantageusmc.com</div>
      </div>
      <AbsoluteFill style={{ background: '#000', opacity: black }} />
    </AbsoluteFill>
  );
}
