import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Glass, Mono, Reveal, Shot, money } from '../components/Kit';
import { Screen } from '../components/Screen';
import { Eyebrow, Super } from '../components/Super';
import { SyntheticTag } from '../components/Tag';
import type { cues } from '../cues';
import { easeInOut, easeOut, land, p } from '../lib/motion';
import { C, FONT } from '../theme';

type Cues = ReturnType<typeof cues>;

/** A short statement that arrives, holds, and gives way to the next. */
function Beat({ text, at, out, size = 76, color, gradient }: { text: string; at: number; out?: number; size?: number; color?: string; gradient?: string }) {
  return <Super words={text} at={at} out={out} size={size} weight={600} tracking={-0.04} lineHeight={1.04} color={color} gradient={gradient} stagger={2} />;
}

/* ── capture: say it once ────────────────────────────────────────────────────────────────────── */

export function Capture({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const enter = land(f, fps, 0, 22);
  const reads = c.w('reads');
  const shows = c.w('shows');
  const ry = -17 + p(f, 0, d, easeInOut) * 9;
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} />
      <div style={{ position: 'absolute', left: 150, top: 300, width: 600 }}>
        <Eyebrow text="Quick Log" at={4} />
        <div style={{ position: 'relative', marginTop: 34, height: 260 }}>
          <div style={{ position: 'absolute' }}><Beat text="Say it once." at={c.w('say') - 4} out={reads - 10} /></div>
          <div style={{ position: 'absolute' }}><Beat text="It reads the numbers." at={reads - 2} out={shows - 10} /></div>
          <div style={{ position: 'absolute' }}><Beat text="You check. Then it saves." at={shows - 2} /></div>
        </div>
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2200, perspectiveOrigin: '70% 50%' }}>
        <div style={{ position: 'absolute', left: 770, top: 200, transformStyle: 'preserve-3d', transformOrigin: '0% 50%',
          transform: `translate3d(${(1 - enter) * 260}px, 0, ${(1 - enter) * -400}px) rotateY(${ry}deg) rotateX(3deg)`, opacity: Math.min(1, enter * 1.3) }}>
          <Screen take="hero/capture" width={1050} />
        </div>
      </div>
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── queue: one queue, claim it ──────────────────────────────────────────────────────────────── */

export function Queue({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const enter = land(f, fps, 0, 22);
  const claim = c.w('claim');
  const ry = 16 - p(f, 0, d, easeInOut) * 9;
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2200, perspectiveOrigin: '30% 50%' }}>
        <div style={{ position: 'absolute', left: 110, top: 190, transformStyle: 'preserve-3d', transformOrigin: '100% 50%',
          transform: `translate3d(${(1 - enter) * -260}px, 0, ${(1 - enter) * -400}px) rotateY(${ry}deg) rotateX(3deg)`, opacity: Math.min(1, enter * 1.3) }}>
          <Screen take="hero/queue" width={1180} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1390, top: 340, width: 440 }}>
        <Eyebrow text="Work" at={4} />
        <div style={{ marginTop: 30 }}><Beat text="One queue." at={c.w('one') - 3} size={72} /></div>
        <div style={{ marginTop: 18 }}><Beat text="Claim it." at={claim - 3} size={72} color={C.soft} /></div>
        <div style={{ marginTop: 6 }}><Beat text="It’s yours." at={c.w('yours') - 3} size={72} gradient="linear-gradient(100deg,#fff,#3fd0bd)" /></div>
      </div>
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── case: cited, evidenced, verified ───────────────────────────────────────────────────────── */

export function Case({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cited = c.w('procedures');
  const evidence = c.w('evidence');
  const verified = c.w('verified');
  const a = land(f, fps, cited - 12, 20);
  const b = land(f, fps, evidence - 8, 18);
  const v = land(f, fps, verified - 6, 16);
  const items = [
    { text: 'Cited procedures.', at: c.w('cases') },
    { text: 'Evidence before action.', at: evidence - 2 },
    { text: 'Resolved only when verified.', at: verified - 8 },
  ];
  const active = f >= items[2].at ? 2 : f >= items[1].at ? 1 : 0;
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} />
      <div style={{ position: 'absolute', left: 150, top: 330, width: 760 }}>
        <Eyebrow text="Every case" at={2} />
        <div style={{ marginTop: 30, display: 'grid', gap: 10 }}>
          {items.map((it, k) => (
            <div key={k} style={{ opacity: k === active ? 1 : 0.34, transition: 'none' }}>
              <Super words={it.text} at={it.at} size={66} weight={600} tracking={-0.035} stagger={2} />
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2000, perspectiveOrigin: '75% 45%' }}>
        <div style={{ position: 'absolute', left: 1230, top: 90, transformStyle: 'preserve-3d', transform: `translate3d(${(1 - a) * 200}px, ${(1 - a) * 40}px, ${(1 - a) * -300}px) rotateY(-16deg) rotateX(4deg)`, opacity: Math.min(1, a * 1.4) }}>
          <Shot src="hero-procedure" natural={[760, 1354]} width={500} />
        </div>
        <div style={{ position: 'absolute', left: 880, top: 560, transformStyle: 'preserve-3d', transform: `translate3d(${(1 - b) * -120}px, ${(1 - b) * 80}px, ${80 + (1 - b) * -300}px) rotateY(-12deg) rotateX(4deg)`, opacity: Math.min(1, b * 1.4) }}>
          <Shot src="hero-gate" natural={[1424, 728]} width={760} glow={p(f, evidence, evidence + 20) * (1 - p(f, verified - 10, verified + 10))} />
        </div>
        <div style={{ position: 'absolute', left: 150, top: 700, transformOrigin: '0 50%', transform: `scale(${0.7 + v * 0.3})`, opacity: Math.min(1, v * 1.5) }}>
          <VerifiedChip at={verified - 4} />
        </div>
      </div>
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

function VerifiedChip({ at }: { at: number }) {
  const f = useCurrentFrame();
  const k = p(f, at + 4, at + 16);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 28px', borderRadius: 999, background: 'rgba(4,20,30,0.85)', boxShadow: `inset 0 0 0 1.5px rgba(63,208,189,0.6), 0 0 60px rgba(63,208,189,${0.35 * k}), 0 30px 60px -20px rgba(0,0,0,0.8)`, fontFamily: FONT, fontSize: 26, fontWeight: 600, color: '#fff' }}>
      <svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="none" stroke={C.teal} strokeWidth="2.4" strokeDasharray="82" strokeDashoffset={82 * (1 - p(f, at, at + 14))} /><path d="M9 15.5 13.2 19.5 21 11" fill="none" stroke={C.teal} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="20" strokeDashoffset={20 * (1 - k)} /></svg>
      Verified: the UMT cleared <span style={{ color: C.mute, fontWeight: 500 }}>→ Resolve</span>
    </div>
  );
}

/* ── balance: read in the order the money moves ──────────────────────────────────────────────── */

const PHASES = [
  { key: 'commitment', label: 'Commitment', sub: 'Requisition', v: 6_000_000 },
  { key: 'obligation', label: 'Obligation', sub: 'Award', v: 5_000_000 },
  { key: 'delivered', label: 'Delivered', sub: 'Receipt', v: 3_000_000 },
  { key: 'paid', label: 'Paid', sub: 'Disbursement', v: 3_000_000 },
];

export function Balance({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ocmt = c.w('commitments');
  const udou = c.w('undelivered');
  const order = c.w('order');
  const card = land(f, fps, 0, 22);
  const BAR = 860;
  const max = PHASES[0].v;
  const flowK = p(f, order - 4, order + 46, easeInOut);
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.07} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2400 }}>
        <div style={{ position: 'absolute', left: 230, top: 150, width: 1460, transform: `translateY(${(1 - card) * 60}px) rotateX(${(1 - card) * 16 + 4 - p(f, 0, 190) * 4}deg)`, opacity: Math.min(1, card * 1.3) }}>
          <Glass pad={56}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontFamily: FONT, fontSize: 34, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>What the figures show</div>
              <Mono>ONE DOCUMENT · ONE LINE · ONE SCOPE</Mono>
            </div>
            <div style={{ marginTop: 64, display: 'grid', gap: 64 }}>
              {PHASES.map((ph, k) => {
                const grow = p(f, 6 + k * 6, 40 + k * 6, easeOut);
                const w = (ph.v / max) * BAR * grow;
                const lit = flowK * 4 - k;
                const light = Math.max(0, Math.min(1, lit)) * (1 - Math.max(0, Math.min(1, lit - 1)) * 0.6);
                const gap = k === 1 ? { from: 5_000_000, to: 6_000_000, at: ocmt, label: 'OCMT', open: 1_000_000 }
                  : k === 2 ? { from: 3_000_000, to: 5_000_000, at: udou, label: 'UDOU', open: 2_000_000 } : null;
                const g = gap ? p(f, gap.at - 6, gap.at + 12) : 0;
                return (
                  <div key={ph.key} style={{ display: 'grid', gridTemplateColumns: '200px 1fr 230px', alignItems: 'center', gap: 28 }}>
                    <div>
                      <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 600, color: light > 0.3 ? '#fff' : C.soft }}>{ph.label}</div>
                      <Mono style={{ fontSize: 14 }}>{ph.sub.toUpperCase()}</Mono>
                    </div>
                    <div style={{ position: 'relative', height: 26 }}>
                      <div style={{ position: 'absolute', inset: 0, width: BAR, borderRadius: 13, background: 'rgba(255,255,255,0.05)' }} />
                      <div style={{ position: 'absolute', left: 0, top: 0, height: 26, width: w, borderRadius: 13, background: `linear-gradient(90deg, ${C.cobaltUi}, ${C.cobalt})`, boxShadow: `0 0 ${30 * light}px rgba(63,208,189,${0.7 * light})` }} />
                      {gap && (
                        <div style={{ position: 'absolute', left: (gap.from / max) * BAR + 4, top: 0, height: 26, width: ((gap.to - gap.from) / max) * BAR - 4, borderRadius: 13, opacity: g, boxShadow: `0 0 ${40 * g}px rgba(224,161,58,${0.35 * g})`,
                          background: 'repeating-linear-gradient(135deg, rgba(224,161,58,0.95) 0 7px, rgba(224,161,58,0.28) 7px 14px)' }} />
                      )}
                      {gap && (
                        <div style={{ position: 'absolute', left: (gap.from / max) * BAR, top: -44, opacity: g, transform: `translateY(${(1 - g) * 10}px)`, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderRadius: 999, background: 'rgba(224,161,58,0.14)', boxShadow: 'inset 0 0 0 1px rgba(224,161,58,0.55)', fontFamily: FONT, fontSize: 18, fontWeight: 600, color: C.amber, whiteSpace: 'nowrap' }}>
                          {gap.label} <span style={{ color: '#f3d49a', fontWeight: 500 }}>{money(gap.open)} open</span>
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: FONT, fontSize: 26, fontWeight: 500, color: '#fff', fontVariantNumeric: 'tabular-nums', opacity: grow }}>{money(ph.v)}</div>
                  </div>
                );
              })}
            </div>
            {/* The order money moves: a pulse down the phases. */}
            <div style={{ position: 'absolute', left: 56 + 200 + 28 - 34, top: 190, width: 4, height: 3 * (48 + 64) + 10, borderRadius: 2, background: 'rgba(255,255,255,0.06)', opacity: p(f, order - 10, order) }}>
              <div style={{ width: 4, height: `${flowK * 100}%`, borderRadius: 2, background: `linear-gradient(180deg, rgba(63,208,189,0.2), ${C.teal})`, boxShadow: `0 0 16px ${C.teal}` }} />
            </div>
          </Glass>
        </div>
      </div>
      <Reveal at={order - 2} style={{ position: 'absolute', left: 230, bottom: 110, fontFamily: FONT, fontSize: 30, color: C.soft, letterSpacing: '-0.01em' }}>
        Commitment → obligation → delivered → paid. <span style={{ color: '#fff' }}>The gap between two phases is what is open.</span>
      </Reveal>
    </AbsoluteFill>
  );
}
