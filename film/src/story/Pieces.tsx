import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Counter, Dust, Glass, Mono, Shot, Wordmark, money } from '../components/Kit';
import { Mark } from '../components/Mark';
import { Screen } from '../components/Screen';
import { easeIn, easeInOut, easeOut, land, p, rand } from '../lib/motion';
import { MOMENTS } from '../moments';
import { C, FONT, MONO } from '../theme';

const S = (sec: number) => Math.round(sec * 30);

/** A number rolling up, with what it counts beneath it. */
export function BigCount({ to, label, accent, size = 300, style }: { to: number; label: string; accent: string; size?: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const at = S(MOMENTS.counter.at);
  return (
    <div style={style}>
      <div style={{ fontFamily: FONT, fontSize: size, fontWeight: 600, letterSpacing: '-0.06em', lineHeight: 0.9, color: '#fff', opacity: p(f, at - 6, at + 6) }}>
        <Counter to={to} at={at} frames={S(MOMENTS.counter.dur)} />
      </div>
      <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 16, fontFamily: FONT, fontSize: 24, fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color: accent, opacity: p(f, at + 10, at + 26) }}>
        <span style={{ width: 44 * p(f, at + 10, at + 30), height: 2, background: accent }} />{label}
      </div>
    </div>
  );
}

/** A requisition short of what the award needs, and the check that caught it. */
export function FundingGap({ at, caught, style }: { at: number; caught: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const i = p(f, at, at + 20);
  const avail = 150000; const need = 277500;
  const W = 640;
  const barA = p(f, at + 4, at + 30, easeOut) * (avail / need) * W;
  const barB = p(f, at + 10, at + 36, easeOut) * W;
  const hatch = p(f, at + 30, at + 46);
  const stamp = land(f, fps, caught, 14);
  return (
    <div style={{ ...style, opacity: i, transform: `translateY(${(1 - i) * 30}px)` }}>
      <Glass pad={40}>
        <Mono style={{ color: C.teal, letterSpacing: '0.18em', fontSize: 15 }}>2-WAY UMT · SYN-26-P-0047</Mono>
        <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 600, color: C.white, marginTop: 10, letterSpacing: '-0.02em' }}>Decide on requisition funding</div>
        {[
          { label: 'Requisition funding available', v: avail, w: barA, color: C.cobalt },
          { label: 'Candidate award increase', v: need, w: barB, color: 'rgba(201,213,232,0.7)' },
        ].map((r, k) => (
          <div key={k} style={{ marginTop: k ? 22 : 34 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT, fontSize: 20, color: C.soft }}><span>{r.label}</span><span style={{ color: C.white, fontVariantNumeric: 'tabular-nums' }}>{money(r.v, k === 1)}</span></div>
            <div style={{ position: 'relative', marginTop: 10, height: 14, width: W, borderRadius: 7, background: 'rgba(255,255,255,0.06)' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, height: 14, width: r.w, borderRadius: 7, background: r.color }} />
              {k === 0 && <div style={{ position: 'absolute', left: (avail / need) * W + 3, top: 0, height: 14, width: (1 - avail / need) * W - 3, borderRadius: 7, opacity: hatch,
                background: 'repeating-linear-gradient(135deg, rgba(224,161,58,0.9) 0 6px, rgba(224,161,58,0.25) 6px 12px)' }} />}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 14, fontFamily: FONT, fontSize: 21, color: C.amber, opacity: hatch }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: C.amber }} />Short by {money(need - avail)}
        </div>
        <div style={{ position: 'absolute', right: 34, bottom: 30, transform: `scale(${0.6 + stamp * 0.4}) rotate(${(1 - stamp) * -8}deg)`, opacity: Math.min(1, stamp * 1.4),
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderRadius: 999, background: 'rgba(63,208,189,0.12)', boxShadow: 'inset 0 0 0 1px rgba(63,208,189,0.5)', fontFamily: FONT, fontSize: 20, fontWeight: 600, color: C.teal }}>
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="M4 10.5 8.2 14.5 16 6" fill="none" stroke={C.teal} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="20" strokeDashoffset={20 * (1 - p(f, caught + 2, caught + 14))} /></svg>
          Caught: amend the requisition first
        </div>
      </Glass>
    </div>
  );
}

/** Six months going by, a beat each. */
export function Months({ accent }: { accent: string }) {
  const f = useCurrentFrame();
  const names = ['MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP'];
  const { at, step, count } = MOMENTS.months;
  const idx = Math.max(0, Math.min(count, Math.floor((f - S(at)) / S(step)) + 1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
      <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: '0.3em', color: 'rgba(201,213,232,0.55)', opacity: p(f, 0, 12) }}>2026</div>
      <div style={{ display: 'flex', gap: 34 }}>
        {names.map((n, i) => {
          const on = i === idx;
          const past = i < idx;
          const lit = p(f, S(at + (i - 1) * step), S(at + (i - 1) * step) + 6);
          return (
            <div key={n} style={{ fontFamily: FONT, fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em', color: on ? '#fff' : past ? 'rgba(201,213,232,0.28)' : 'rgba(201,213,232,0.14)',
              transform: `translateY(${on ? -8 * lit : 0}px)`, textShadow: on ? `0 0 40px ${accent}` : undefined }}>{n}</div>
          );
        })}
      </div>
      <div style={{ width: 1100, height: 2, background: 'rgba(255,255,255,0.08)', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: 2, width: `${(idx / (names.length - 1)) * 100}%`, background: accent, boxShadow: `0 0 16px ${accent}` }} />
      </div>
    </div>
  );
}

/** The work coming apart: a spreadsheet, an inbox and a note, one after another, then falling away. */
export function Scattered({ fall }: { fall: number }) {
  const at = (k: number) => S(MOMENTS.scatter.first + k * MOMENTS.scatter.step) - 10;
  return (
    <>
      <Embers from={fall - 20} />
      <div style={{ position: 'absolute', inset: 0, perspective: 1800, perspectiveOrigin: '50% 45%' }}>
        <Fragment at={at(0)} next={fall} x={-500} y={40} rz={-4}><Spreadsheet /></Fragment>
        <Fragment at={at(1)} next={fall + 4} x={0} y={120} rz={2}><Inbox /></Fragment>
        <Fragment at={at(2)} next={fall + 8} x={540} y={50} rz={5}><Sticky /></Fragment>
      </div>
    </>
  );
}

function Embers({ from }: { from: number }) {
  const f = useCurrentFrame();
  if (f < from) return null;
  const t = f - from;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {Array.from({ length: 140 }, (_, i) => {
        const r1 = rand(i + 11); const r2 = rand(i + 211); const r3 = rand(i + 411);
        const x0 = 260 + r2 * 1400; const y0 = 380 + r3 * 460;
        const life = 40 + r3 * 50; const k = Math.min(1, t / life);
        const x = x0 + (r2 - 0.3) * 240 * k + Math.sin(t / 12 + i) * 8;
        const y = y0 - (80 + r1 * 260) * k;
        const o = (1 - k) * (0.3 + r1 * 0.6) * Math.min(1, t / 6);
        const s = 2 + r3 * 4;
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: s, height: s, borderRadius: 1, background: r2 > 0.7 ? `rgba(63,208,189,${o})` : `rgba(210,222,245,${o})` }} />;
      })}
    </div>
  );
}

function Fragment({ at, next, x, y, rz, children }: { at: number; next: number; x: number; y: number; rz: number; children: ReactNode }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const i = land(f, fps, at, 20);
  const fall = p(f, next, next + 40, easeIn);
  const z = -600 * (1 - i) - 900 * fall;
  const o = Math.min(1, i * 1.4) * (1 - fall * 0.9);
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transformStyle: 'preserve-3d', transform: `translate(-50%,-50%) translate3d(${x}px, ${y + fall * 120}px, ${z}px) rotateZ(${rz + fall * 6}deg) rotateX(${fall * 18}deg) scale(1.12)`, opacity: o, filter: fall > 0.02 ? `blur(${fall * 6}px)` : undefined }}>
      {children}
    </div>
  );
}

function Spreadsheet() {
  const cols = ['Document', 'Line', 'Status', 'Amount', 'Aged', 'Notes'];
  const rows = [
    ['M67854-26-RC-00112', '0003', 'open', '41,806.12', '94', 'recon?'],
    ['M67854-26-RC-00087', '0001', 'open', '12,400.00', '63', ''],
    ['M67854-26-RC-00154', '0002', '??', '3,318.40', '121', 'ask D.'],
    ['M67854-26-RC-00201', '0001', 'closed', '980.00', '12', ''],
    ['M67854-26-RC-00093', '0004', 'open', '27,150.00', '88', 'dup?'],
    ['M67854-26-RC-00110', '0001', 'open', '1,120.00', '41', ''],
  ];
  return (
    <div style={{ width: 620, borderRadius: 14, overflow: 'hidden', background: '#f4f6f8', boxShadow: '0 50px 100px -30px rgba(0,0,0,0.8)', fontFamily: FONT }}>
      <div style={{ height: 40, background: '#1f7a4d', color: '#fff', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 15, fontWeight: 600 }}>ULO_recon_FINAL_v3 (2).xlsx</div>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 60px 70px 110px 56px 1fr', fontSize: 13 }}>
        {cols.map((h) => <div key={h} style={{ padding: '7px 8px', background: '#e3e7ec', color: '#445', fontWeight: 600, borderRight: '1px solid #cfd5dc', borderBottom: '1px solid #cfd5dc' }}>{h}</div>)}
        {rows.flat().map((v, k) => <div key={k} style={{ padding: '7px 8px', color: v === '??' ? '#b3261e' : '#223', background: k % 12 < 6 ? '#fff' : '#fafbfc', borderRight: '1px solid #e2e6ea', borderBottom: '1px solid #e2e6ea', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden' }}>{v}</div>)}
      </div>
    </div>
  );
}

function Inbox() {
  const mail = [
    ['RE: RE: FW: Q4 UMT status', 'Where are we on the 2-way list?', true],
    ['ULO recon — updated', 'see attached, v3', true],
    ['Need the 448-2 by COB', 'MIPR acknowledgement still missing', false],
    ['RE: funding question', 'Requisition shows 1,500 avail…', true],
  ] as const;
  return (
    <div style={{ width: 580, borderRadius: 14, overflow: 'hidden', background: '#fff', boxShadow: '0 50px 100px -30px rgba(0,0,0,0.8)', fontFamily: FONT }}>
      <div style={{ height: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: '1px solid #e6e9ee', fontSize: 16, fontWeight: 600, color: '#1a2233' }}>Inbox <span style={{ fontSize: 13, color: '#6b7488', fontWeight: 500 }}>1,284 unread</span></div>
      {mail.map(([s, b, unread], k) => (
        <div key={k} style={{ display: 'flex', gap: 12, padding: '13px 20px', borderBottom: '1px solid #eef0f4' }}>
          <span style={{ width: 8, height: 8, marginTop: 7, borderRadius: 4, background: unread ? '#2563eb' : 'transparent', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: unread ? 600 : 500, color: '#1a2233' }}>{s}</div>
            <div style={{ fontSize: 13, color: '#6b7488', marginTop: 2 }}>{b}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Sticky() {
  return (
    <div style={{ width: 320, height: 290, background: 'linear-gradient(170deg, #ffe98a, #f7d95c)', boxShadow: '0 40px 80px -24px rgba(0,0,0,0.7)', padding: '34px 30px', fontFamily: FONT, fontSize: 30, lineHeight: 1.25, color: '#3a3320', fontStyle: 'italic', fontWeight: 500 }}>
      ask SSgt D. about the 448-2 <br />before Friday!!
      <div style={{ marginTop: 26, fontSize: 22, opacity: 0.7 }}>(the MIPR one)</div>
    </div>
  );
}

/** The mark lands with a flash, and the name under it. */
export function LogoHit({ accent }: { accent: string }) {
  const f = useCurrentFrame();
  const flash = Math.max(0, 1 - f / 26);
  const bloom = p(f, 0, 70, easeOut);
  const push = 1 + p(f, 0, 150, easeInOut) * 0.035;
  return (
    <AbsoluteFill style={{ background: '#02060d' }}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 520px at 50% 46%, rgba(47,107,255,${0.34 * bloom}), rgba(63,208,189,${0.08 * bloom}) 45%, transparent 72%)` }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 470, height: 4, background: `linear-gradient(90deg, transparent, rgba(160,220,255,${0.9 * flash}) 30%, rgba(255,255,255,${flash}) 50%, rgba(160,220,255,${0.9 * flash}) 70%, transparent)`, filter: 'blur(1.5px)', transform: `scaleX(${0.3 + (1 - flash) * 1.2})` }} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 42%, rgba(255,255,255,${0.55 * flash ** 2}), transparent 40%)` }} />
      <Dust n={70} seed={9} max={0.3} rise={0.2} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${push})` }}>
        <div style={{ marginTop: -40 }}><Mark size={200} at={1} /></div>
        <div style={{ marginTop: 52, opacity: p(f, 10, 26), transform: `translateY(${(1 - p(f, 10, 30)) * 16}px)` }}><Wordmark size={64} spacing={0.36} /></div>
        <div style={{ marginTop: 22, width: 120 * p(f, 22, 46), height: 2, background: accent, boxShadow: `0 0 18px ${accent}` }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** The real application in a window, tilted a touch and settling flat as the scene goes on. */
export function AppWindow({ take, width = 1440, left, top, tilt = 1, enterFrom = 'below' }: { take: string; width?: number; left: number; top: number; tilt?: number; enterFrom?: 'below' | 'right' }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const k = land(f, fps, 0, 22);
  const settle = p(f, 0, d, easeInOut);
  const out = p(f, d - 10, d, easeIn);
  const dx = enterFrom === 'right' ? (1 - k) * 300 : 0;
  const dy = enterFrom === 'below' ? (1 - k) * 260 : 0;
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2600, perspectiveOrigin: '50% 30%' }}>
      <div style={{
        position: 'absolute', left, top, transformStyle: 'preserve-3d',
        transform: `translate3d(${dx}px, ${dy}px, ${(1 - k) * -300}px) rotateX(${(7 - settle * 5) * tilt}deg) rotateY(${(-5 + settle * 4) * tilt}deg)`,
        opacity: Math.min(1, k * 1.4) * (1 - out * 0.3), filter: k < 0.98 ? `blur(${(1 - k) * 8}px)` : undefined,
      }}>
        <div style={{ position: 'relative', width, borderRadius: 18, overflow: 'hidden', background: '#0d1a2e', boxShadow: '0 0 0 1px rgba(255,255,255,0.10), 0 90px 170px -50px rgba(0,0,0,0.9)' }}>
          <div style={{ height: 30, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16 }}>
            {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c, opacity: 0.85 }} />)}
          </div>
          <Screen take={take} width={width} chrome={false} radius={0} />
        </div>
      </div>
    </div>
  );
}

const ENTRIES = [
  { who: 'You', text: 'recorded current award amount: $91,250.00 (DAI)', chip: 'Read by hand', hash: '9c41·e07a' },
  { who: 'You', text: 'recorded invoice amount: $45,000.00 (DAI)', chip: 'Read by hand', hash: '3f9a·c1d2' },
  { who: 'You', text: 'calculated candidate award adjustment: +$2,775.00', chip: 'Calculate the candidate adjustment', hash: '7b20·94e6' },
  { who: 'You', text: 'decided: amend the requisition first', chip: '“Requisition shows $1,500.00 against +$2,775.00.”', hash: 'd5e8·1a3b' },
  { who: 'You', text: 'handed this to SSgt Morgan Diaz', chip: '“The requisition amendment is next.”', hash: '0e6c·b8f4' },
  { who: 'SSgt Morgan Diaz', text: 'submitted: amend the requisition', chip: 'SYN-REQ-AMD-1', hash: 'a217·5dc9' },
];

/** The case history arriving entry by entry, each signed over the one before, then sealed. */
export function HistoryChain({ style }: { style?: CSSProperties }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const seal = land(f, fps, Math.round(d * MOMENTS.history.seal) - 4, 12);
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2200, perspectiveOrigin: '70% 50%' }}>
      <div style={{ position: 'absolute', width: 880, transform: `rotateY(-10deg) rotateX(4deg) translateY(${-p(f, 0, 170) * 30}px)`, transformStyle: 'preserve-3d', ...style }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22, transform: `scale(${0.8 + seal * 0.2})`, transformOrigin: '100% 50%', opacity: Math.min(1, seal * 1.4) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderRadius: 999, background: 'rgba(4,20,30,0.85)', boxShadow: `inset 0 0 0 1.5px rgba(63,208,189,0.6), 0 0 ${70 * seal}px rgba(63,208,189,0.35)`, fontFamily: FONT, fontSize: 22, fontWeight: 600, color: '#fff' }}>
            <svg width="24" height="26" viewBox="0 0 24 26"><path d="M12 1.5 21.5 5v7.2c0 5.9-4 10.2-9.5 12.3C6.5 22.4 2.5 18.1 2.5 12.2V5L12 1.5Z" fill="rgba(63,208,189,0.15)" stroke={C.teal} strokeWidth="2" /><path d="M7.5 13 10.8 16.2 16.8 10" fill="none" stroke={C.teal} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            History sealed · 13 entries
          </div>
        </div>
        <div style={{ position: 'relative', display: 'grid', gap: 14 }}>
          <div style={{ position: 'absolute', left: 30, top: 34, bottom: 34, width: 2, background: `linear-gradient(180deg, rgba(63,208,189,${0.2 + seal * 0.7}), rgba(63,208,189,0.15))`, boxShadow: seal > 0.1 ? `0 0 ${14 * seal}px rgba(63,208,189,0.8)` : undefined }} />
          {ENTRIES.map((e, k) => {
            const i = land(f, fps, S(MOMENTS.history.first + k * MOMENTS.history.step) - 4, 16);
            return (
              <div key={k} style={{ position: 'relative', paddingLeft: 64, opacity: Math.min(1, i * 1.5), transform: `translateY(${(1 - i) * 40}px) translateZ(${(1 - i) * -120}px)` }}>
                <div style={{ position: 'absolute', left: 22, top: 30, width: 18, height: 18, borderRadius: 9, background: C.ink, boxShadow: `inset 0 0 0 2px ${C.teal}, 0 0 ${12 * i}px rgba(63,208,189,0.7)` }} />
                <div style={{ borderRadius: 18, background: '#fff', padding: '18px 24px', boxShadow: '0 30px 60px -30px rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: FONT, fontSize: 21, color: '#0f172a', letterSpacing: '-0.01em' }}><b style={{ fontWeight: 600 }}>{e.who}</b> {e.text}</div>
                    <div style={{ marginTop: 8, display: 'inline-block', fontFamily: FONT, fontSize: 16, color: e.chip === 'Read by hand' ? '#1d4ed8' : '#475569', background: e.chip === 'Read by hand' ? '#eef3ff' : '#f1f4f8', borderRadius: 8, padding: '4px 10px' }}>{e.chip}</div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 15, color: '#64748b', whiteSpace: 'nowrap', marginTop: 4 }}>{e.hash}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SENTENCE = [
  { t: 'Reconciled 30 ULOs worth $41,806.12', cite: 1 },
  { t: ' and cleared 12 UMTs,', cite: 2 },
  { t: ' with zero findings at review.', cite: 0 },
];

/** JEPES input written from the record, each claim citing the entry it came from. */
export function ReportDoc({ top = 300 }: { top?: number }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const doc = land(f, fps, 0, 22);
  const typeFrom = S(MOMENTS.report.type); const typeTo = typeFrom + Math.round(d * 0.28);
  const cites = Math.round(d * MOMENTS.report.cite);
  const total = SENTENCE.reduce((n, s) => n + s.t.length, 0);
  const typed = Math.floor(p(f, typeFrom, typeTo, (x) => x) * total);
  let used = 0;
  const src = [
    { n: 1, title: 'Reconciled 30 ULOs totaling $41,806.12 in SABRS', meta: '23 Sep 26 · 30 ULOs · $41.8K reconciled', y: top + 20 },
    { n: 2, title: 'Cleared 12 unmatched transactions in DAI', meta: '18 Sep 26 · 12 UMTs', y: top + 210 },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2400, perspectiveOrigin: '40% 60%' }}>
      <div style={{ position: 'absolute', left: 150, top, width: 1000, transform: `translate3d(0, ${(1 - doc) * 80}px, ${(1 - doc) * -300}px) rotateX(${8 - p(f, 0, 220) * 6}deg) rotateY(6deg)`, opacity: Math.min(1, doc * 1.3), transformStyle: 'preserve-3d' }}>
        <div style={{ borderRadius: 22, background: '#fbfbf9', padding: '44px 56px 48px', boxShadow: '0 70px 140px -40px rgba(0,0,0,0.85)' }}>
          <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.16em', color: '#64748b' }}>2026-07-01 TO 2026-09-30</div>
          <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 48, color: '#0f172a', marginTop: 10, letterSpacing: '-0.01em' }}>FY26 Q4 JEPES input</div>
          <div style={{ marginTop: 28, borderRadius: 16, boxShadow: 'inset 0 0 0 1px #e2e8f0', padding: '22px 26px' }}>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, color: '#0f172a' }}><span style={{ fontFamily: MONO, fontSize: 14, color: '#94a3b8', marginRight: 12 }}>01</span>Mission accomplishment</div>
            <div style={{ marginTop: 16, minHeight: 110, fontFamily: 'Georgia, serif', fontSize: 29, lineHeight: 1.45, color: '#1e293b' }}>
              {SENTENCE.map((s, k) => {
                const show = s.t.slice(0, Math.max(0, Math.min(s.t.length, typed - used)));
                const done = typed - used >= s.t.length;
                used += s.t.length;
                const ci = s.cite ? p(f, cites + (s.cite - 1) * 8, cites + (s.cite - 1) * 8 + 10) : 0;
                return (
                  <span key={k}>{show}{s.cite > 0 && done && (
                    <sup style={{ display: 'inline-block', marginLeft: 4, padding: '1px 8px', borderRadius: 7, fontFamily: FONT, fontSize: 16, fontWeight: 600, color: '#fff', background: C.cobaltUi, opacity: ci, transform: `translateY(${(1 - ci) * 6}px) scale(${0.7 + ci * 0.3})` }}>{s.cite}</sup>
                  )}</span>
                );
              })}
              <span style={{ display: 'inline-block', width: 2, height: 30, marginLeft: 2, background: '#2563eb', verticalAlign: '-4px', opacity: typed < total ? (Math.floor(f / 8) % 2 ? 1 : 0.2) : 0 }} />
            </div>
          </div>
        </div>
      </div>
      {src.map((s) => {
        const k = land(f, fps, cites + (s.n - 1) * 8, 16);
        return (
          <div key={s.n} style={{ position: 'absolute', left: 1250, top: s.y, width: 540, transform: `translate3d(${(1 - k) * 120}px, 0, ${(1 - k) * -200}px) rotateY(-10deg)`, opacity: Math.min(1, k * 1.4) }}>
            <Glass pad={24} radius={20}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <div style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 10, background: C.cobaltUi, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, fontWeight: 600, fontSize: 18 }}>{s.n}</div>
                <div>
                  <div style={{ fontFamily: FONT, fontSize: 21, color: '#fff', fontWeight: 500, lineHeight: 1.3 }}>{s.title}</div>
                  <div style={{ marginTop: 6 }}><Mono style={{ fontSize: 14 }}>{s.meta}</Mono></div>
                </div>
              </div>
            </Glass>
          </div>
        );
      })}
    </div>
  );
}

/** A still of the product, tilting slowly, with a light passing over it. */
export function StillShot({ src, width, left, top, sweep = true }: { src: string; width: number; left: number; top: number; sweep?: boolean }) {
  const f = useCurrentFrame();
  const { durationInFrames: d, fps } = useVideoConfig();
  const k = p(f, 0, d, easeInOut);
  const enter = land(f, fps, 0, 22);
  const light = p(f, 10, 70, easeInOut);
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2600, perspectiveOrigin: '50% 40%' }}>
      <div style={{ position: 'absolute', left, top, transform: `translate3d(${(1 - enter) * 100 - k * 40}px, ${(1 - enter) * 80}px, ${(1 - enter) * -300}px) rotateX(${10 - k * 6}deg) rotateY(${6 - k * 10}deg)`, opacity: Math.min(1, enter * 1.3) }}>
        <div style={{ position: 'relative' }}>
          <Shot src={src} width={width} />
          {sweep && (
            <div style={{ position: 'absolute', inset: 0, borderRadius: 20, overflow: 'hidden', pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: -200, bottom: -200, width: 260, left: -400 + light * (width + 800), transform: 'rotate(18deg)', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)' }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Private by default: a ring closes around the mark. */
export function Ring({ accent }: { accent: string }) {
  const f = useCurrentFrame();
  const ring = p(f, 6, 60, easeInOut);
  const R = 260;
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(700px 520px at 50% 56%, rgba(20,184,166,${0.12 * ring}), transparent 70%)` }} />
      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: 30 }, (_, i) => Array.from({ length: 17 }, (_, j) => {
          const x = 60 + i * 62; const y = 40 + j * 62; const dd = Math.hypot(x - 960, y - 600);
          return dd > R + 30 ? <circle key={`${i}-${j}`} cx={x} cy={y} r="1.4" fill="rgba(201,213,232,0.16)" opacity={Math.max(0, 1 - (dd - R) / 700) * ring} /> : null;
        }))}
        <circle cx="960" cy="600" r={R} fill="none" stroke={accent} strokeOpacity="0.75" strokeWidth="2" strokeDasharray={2 * Math.PI * R} strokeDashoffset={2 * Math.PI * R * (1 - ring)} transform="rotate(-90 960 600)" />
        <circle cx="960" cy="600" r={R + 18} fill="none" stroke="rgba(63,208,189,0.15)" strokeWidth="1" strokeDasharray="4 10" opacity={ring} />
        {Array.from({ length: 24 }, (_, i) => {
          const r = 80 + rand(i + 3) * (R - 110);
          const a = rand(i + 50) * Math.PI * 2 + (f / 30) * (0.25 + rand(i + 90) * 0.5) * (i % 2 ? 1 : -1);
          return <circle key={i} cx={960 + Math.cos(a) * r} cy={600 + Math.sin(a) * r} r={2 + rand(i) * 2.5} fill={i % 3 ? 'rgba(201,213,232,0.8)' : C.teal} opacity={ring * (0.4 + rand(i + 7) * 0.6)} />;
        })}
      </svg>
      <div style={{ position: 'absolute', left: 960 - 50, top: 600 - 50, opacity: ring }}><Mark size={100} still /></div>
    </>
  );
}

/** The last card: the mark, the name, where to find it. */
export function EndLogo({ accent, fine = true }: { accent: string; fine?: boolean }) {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const out = p(f, d - 22, d - 2, easeInOut);
  const bloom = p(f, 0, 80);
  return (
    <AbsoluteFill style={{ background: '#02060d' }}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 600px at 50% 46%, rgba(47,107,255,${0.26 * bloom}), rgba(63,208,189,${0.06 * bloom}) 50%, transparent 75%)` }} />
      <Dust n={60} seed={31} max={0.25} rise={0.15} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ marginTop: -40 }}><Mark size={150} at={4} /></div>
        <div style={{ marginTop: 44, opacity: p(f, 14, 30), transform: `translateY(${(1 - p(f, 14, 34)) * 16}px)` }}><Wordmark size={48} spacing={0.36} /></div>
        <div style={{ marginTop: 40, fontFamily: FONT, fontSize: 36, fontWeight: 600, color: accent, letterSpacing: '0.01em', opacity: p(f, 28, 48), transform: `translateY(${(1 - p(f, 28, 50)) * 12}px)` }}>vantageusmc.com</div>
      </AbsoluteFill>
      {fine && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 60, textAlign: 'center', fontFamily: FONT, fontSize: 18, color: 'rgba(201,213,232,0.5)', letterSpacing: '0.02em', opacity: p(f, 40, 60) }}>
          Demo data. Not an official DoD or USMC system.
        </div>
      )}
      <AbsoluteFill style={{ background: '#000', opacity: out }} />
    </AbsoluteFill>
  );
}

/** A case follows its procedure; a step that needs evidence says so; the verified outcome closes it. */
export function CaseStills() {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const a = land(f, fps, 4, 20);
  const b = land(f, fps, Math.round(d * 0.3), 18);
  const verified = Math.round(d * 0.6);
  const v = land(f, fps, verified, 16);
  const k = p(f, verified + 4, verified + 16);
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2000, perspectiveOrigin: '75% 45%' }}>
      <div style={{ position: 'absolute', left: 1270, top: 120, transformStyle: 'preserve-3d', transform: `translate3d(${(1 - a) * 200}px, ${(1 - a) * 40}px, ${(1 - a) * -300}px) rotateY(-16deg) rotateX(4deg)`, opacity: Math.min(1, a * 1.4) }}>
        <Shot src="hero-procedure" width={460} />
      </div>
      <div style={{ position: 'absolute', left: 900, top: 560, transformStyle: 'preserve-3d', transform: `translate3d(${(1 - b) * -120}px, ${(1 - b) * 80}px, ${80 + (1 - b) * -300}px) rotateY(-12deg) rotateX(4deg)`, opacity: Math.min(1, b * 1.4) }}>
        <Shot src="hero-gate" width={720} glow={p(f, Math.round(d * 0.3), Math.round(d * 0.3) + 20) * (1 - p(f, verified - 10, verified + 10))} />
      </div>
      <div style={{ position: 'absolute', left: 150, top: 760, transformOrigin: '0 50%', transform: `scale(${0.7 + v * 0.3})`, opacity: Math.min(1, v * 1.5) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 28px', borderRadius: 999, background: 'rgba(4,20,30,0.85)', boxShadow: `inset 0 0 0 1.5px rgba(63,208,189,0.6), 0 0 60px rgba(63,208,189,${0.35 * k}), 0 30px 60px -20px rgba(0,0,0,0.8)`, fontFamily: FONT, fontSize: 26, fontWeight: 600, color: '#fff' }}>
          <svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="none" stroke={C.teal} strokeWidth="2.4" strokeDasharray="82" strokeDashoffset={82 * (1 - p(f, verified, verified + 14))} /><path d="M9 15.5 13.2 19.5 21 11" fill="none" stroke={C.teal} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="20" strokeDashoffset={20 * (1 - k)} /></svg>
          Verified: the UMT cleared
        </div>
      </div>
    </div>
  );
}

/** What each person did, counted from the case itself, with the Marine's own line lit. */
export function CreditBlock({ accent }: { accent: string }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const card = land(f, fps, 4, 20);
  const hi = p(f, Math.round(d * 0.45), Math.round(d * 0.45) + 18);
  return (
    <>
      <div style={{ position: 'absolute', left: 150, top: 400, display: 'flex', gap: 80 }}>
        {[{ n: 40, label: 'documents researched', at: 8 }, { n: 66, label: 'verified outcomes', at: 16 }].map((x) => (
          <div key={x.label} style={{ opacity: p(f, x.at, x.at + 12) }}>
            <div style={{ fontFamily: FONT, fontSize: 170, fontWeight: 600, letterSpacing: '-0.055em', lineHeight: 0.9, color: '#fff' }}><Counter to={x.n} at={x.at} frames={30} /></div>
            <div style={{ marginTop: 14, fontFamily: FONT, fontSize: 24, color: C.soft }}>{x.label}</div>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2000, perspectiveOrigin: '80% 50%' }}>
        <div style={{ position: 'absolute', left: 1130, top: 330, transform: `translate3d(${(1 - card) * 160}px, 0, ${(1 - card) * -300}px) rotateY(-14deg) rotateX(3deg)`, opacity: Math.min(1, card * 1.3) }}>
          <div style={{ position: 'relative' }}>
            <Shot src="hero-who" width={640} />
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 20, boxShadow: `0 0 0 ${2 * hi}px ${accent}, 0 0 ${60 * hi}px rgba(63,208,189,0.3)`, opacity: hi }} />
          </div>
        </div>
      </div>
    </>
  );
}

const PHASES = [
  { key: 'commitment', label: 'Commitment', sub: 'Requisition', v: 6_000_000 },
  { key: 'obligation', label: 'Obligation', sub: 'Award', v: 5_000_000 },
  { key: 'delivered', label: 'Delivered', sub: 'Receipt', v: 3_000_000 },
  { key: 'paid', label: 'Paid', sub: 'Disbursement', v: 3_000_000 },
];

/** A document's four figures, read in the order money moves, with what is still open marked. */
export function BalanceChart({ top = 250 }: { top?: number }) {
  const f = useCurrentFrame();
  const { fps, durationInFrames: d } = useVideoConfig();
  const card = land(f, fps, 0, 22);
  const BAR = 860;
  const max = PHASES[0].v;
  const ocmt = Math.round(d * 0.3); const udou = Math.round(d * 0.45); const order = Math.round(d * 0.6);
  const flowK = p(f, order - 4, order + 46, easeInOut);
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 2400 }}>
      <div style={{ position: 'absolute', left: 230, top, width: 1460, transform: `translateY(${(1 - card) * 60}px) rotateX(${(1 - card) * 16 + 4 - p(f, 0, 190) * 4}deg)`, opacity: Math.min(1, card * 1.3) }}>
        <Glass pad={52}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontFamily: FONT, fontSize: 32, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>What the figures show</div>
            <Mono>ONE DOCUMENT · ONE LINE · ONE SCOPE</Mono>
          </div>
          <div style={{ marginTop: 56, display: 'grid', gap: 56 }}>
            {PHASES.map((ph, k) => {
              const grow = p(f, 6 + k * 6, 40 + k * 6, easeOut);
              const w = (ph.v / max) * BAR * grow;
              const lit = flowK * 4 - k;
              const light = Math.max(0, Math.min(1, lit)) * (1 - Math.max(0, Math.min(1, lit - 1)) * 0.6);
              const gap = k === 1 ? { from: 5_000_000, to: 6_000_000, at: ocmt, label: 'OCMT', open: 1_000_000 } : k === 2 ? { from: 3_000_000, to: 5_000_000, at: udou, label: 'UDOU', open: 2_000_000 } : null;
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
                    {gap && <div style={{ position: 'absolute', left: (gap.from / max) * BAR + 4, top: 0, height: 26, width: ((gap.to - gap.from) / max) * BAR - 4, borderRadius: 13, opacity: g, boxShadow: `0 0 ${40 * g}px rgba(224,161,58,${0.35 * g})`, background: 'repeating-linear-gradient(135deg, rgba(224,161,58,0.95) 0 7px, rgba(224,161,58,0.28) 7px 14px)' }} />}
                    {gap && <div style={{ position: 'absolute', left: (gap.from / max) * BAR, top: -44, opacity: g, transform: `translateY(${(1 - g) * 10}px)`, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderRadius: 999, background: 'rgba(224,161,58,0.14)', boxShadow: 'inset 0 0 0 1px rgba(224,161,58,0.55)', fontFamily: FONT, fontSize: 18, fontWeight: 600, color: C.amber, whiteSpace: 'nowrap' }}>{gap.label} <span style={{ color: '#f3d49a', fontWeight: 500 }}>{money(gap.open)} open</span></div>}
                  </div>
                  <div style={{ textAlign: 'right', fontFamily: FONT, fontSize: 26, fontWeight: 500, color: '#fff', fontVariantNumeric: 'tabular-nums', opacity: grow }}>{money(ph.v)}</div>
                </div>
              );
            })}
          </div>
        </Glass>
      </div>
    </div>
  );
}

/** A late screen across a dark room: where the unseen work happens. */
export function LateScreen() {
  const f = useCurrentFrame();
  const glow = p(f, 0, 90, easeInOut);
  return (
    <>
      <div style={{ position: 'absolute', right: -120, top: 170, width: 1100, height: 700, perspective: 1600, opacity: glow }}>
        <div style={{ width: '100%', height: '100%', transform: `rotateY(-28deg) rotateX(4deg) scale(${1 + f * 0.0004})`, transformOrigin: '100% 50%', borderRadius: 18, overflow: 'hidden',
          background: 'radial-gradient(ellipse at 40% 40%, rgba(90,140,255,0.22), rgba(20,40,90,0.08) 60%, transparent 80%)', boxShadow: '0 0 220px 40px rgba(47,107,255,0.10)' }}>
          <svg width="100%" height="100%" style={{ opacity: 0.35 }}>
            {Array.from({ length: 22 }, (_, i) => <line key={`h${i}`} x1="0" x2="1100" y1={i * 32} y2={i * 32} stroke="rgba(160,190,255,0.25)" strokeWidth="1" />)}
            {Array.from({ length: 9 }, (_, i) => <line key={`v${i}`} y1="0" y2="700" x1={i * 130} x2={i * 130} stroke="rgba(160,190,255,0.2)" strokeWidth="1" />)}
            {Array.from({ length: 40 }, (_, i) => { const r = rand(i + 4); const col = Math.floor(r * 8); const row = Math.floor(rand(i + 40) * 21); return <rect key={i} x={col * 130 + 14} y={row * 32 + 11} width={40 + rand(i + 90) * 60} height="9" rx="2" fill={`rgba(190,210,255,${0.25 + rand(i) * 0.3})`} />; })}
            <rect x={3 * 130} y={9 * 32} width="130" height="32" fill="none" stroke="rgba(63,208,189,0.8)" strokeWidth="2" opacity={0.5 + 0.5 * Math.sin(f / 9)} />
          </svg>
        </div>
      </div>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 70% at 20% 55%, rgba(2,6,13,0.9), transparent 70%)' }} />
      <Dust n={50} seed={3} max={0.25} rise={0.12} />
      <div style={{ position: 'absolute', left: 150, top: 150, fontFamily: MONO, fontSize: 22, color: 'rgba(201,213,232,0.55)', letterSpacing: '0.08em', opacity: p(f, 12, 40) }}>
        21<span style={{ opacity: Math.floor(f / 15) % 2 ? 0.2 : 1 }}>:</span>47 <span style={{ color: 'rgba(201,213,232,0.3)' }}>· G-8 BE</span>
      </div>
    </>
  );
}
