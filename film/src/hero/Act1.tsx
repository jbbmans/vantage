import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Counter, Dust, Glass, Mono, money } from '../components/Kit';
import { Mark } from '../components/Mark';
import { Eyebrow, Super } from '../components/Super';
import type { cues } from '../cues';
import { easeIn, easeInOut, easeOut, land, p, rand } from '../lib/motion';
import { C, FONT, MONO } from '../theme';

type Cues = ReturnType<typeof cues>;

/** Words of a line, with a line break before the word at `breakAt`, for Super. */
export function lineWords(c: Cues, line: number, breakAt?: number, lead = 3) {
  const ws = c.wordsOf(line);
  const words: string[] = []; const at: number[] = [];
  ws.forEach((w, i) => { if (i === breakAt) { words.push('\n'); at.push(w.at); } words.push(w.word); at.push(w.at - lead); });
  return { words, at };
}

/* ── open: somewhere tonight ─────────────────────────────────────────────────────────────────── */

export function Open({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const glow = p(f, 0, 90, easeInOut);
  // "Somewhere tonight, a Marine / is finishing work / that no one will ever see."
  const { words, at } = lineWords(c, 0, 4);
  const dimFrom = words.indexOf('that');
  const unseen = c.w('see', { end: true });
  const leave = p(f, d - 14, d, easeIn);
  return (
    <AbsoluteFill style={{ background: '#02060d' }}>
      {/* A screen, late, somewhere across the room. */}
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

      <div style={{ position: 'absolute', left: 150, top: 120, fontFamily: MONO, fontSize: 22, color: 'rgba(201,213,232,0.55)', letterSpacing: '0.08em', opacity: p(f, 12, 40) * (1 - leave) }}>
        21<span style={{ opacity: Math.floor(f / 15) % 2 ? 0.2 : 1 }}>:</span>47 <span style={{ color: 'rgba(201,213,232,0.3)' }}>· G-8 BE</span>
      </div>

      <div style={{ position: 'absolute', left: 150, top: 330, width: 1600, opacity: 1 - leave }}>
        <Super words={words.slice(0, dimFrom)} at={at.slice(0, dimFrom)} size={96} weight={500} tracking={-0.04} lineHeight={1.1} />
        <div style={{ opacity: 1 - p(f, unseen + 10, unseen + 40, easeInOut) * 0.85, filter: `blur(${p(f, unseen + 10, unseen + 40) * 6}px)` }}>
          <Super words={words.slice(dimFrom)} at={at.slice(dimFrom)} size={96} weight={500} tracking={-0.04} lineHeight={1.1} color="rgba(201,213,232,0.6)" />
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ── detail: thirty reconciliations, a gap caught ────────────────────────────────────────────── */

export function Detail({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const thirty = c.w('thirty');
  const gap = c.w('gap');
  const caught = c.w('caught');
  return (
    <AbsoluteFill>
      <Backdrop glow={0.8} contours={0.05} />
      <Dust n={40} seed={5} max={0.2} />
      <div style={{ position: 'absolute', left: 150, top: 250 }}>
        <div style={{ fontFamily: FONT, fontSize: 340, fontWeight: 600, letterSpacing: '-0.06em', lineHeight: 0.9, color: C.white, opacity: p(f, thirty - 6, thirty + 6) }}>
          <Counter to={30} at={thirty - 4} frames={22} />
        </div>
        <Eyebrow text="Reconciliations" at={thirty + 6} style={{ marginTop: 26, fontSize: 24 }} />
      </div>
      <FundingGap at={gap - 18} caught={caught} style={{ position: 'absolute', right: 150, top: 300, width: 860 }} />
    </AbsoluteFill>
  );
}

/** Requisition funding against the candidate increase: the gap, and the moment it is caught. */
export function FundingGap({ at, caught, style }: { at: number; caught: number; style?: React.CSSProperties }) {
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
                background: `repeating-linear-gradient(135deg, rgba(224,161,58,0.9) 0 6px, rgba(224,161,58,0.25) 6px 12px)` }} />}
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

/* ── scatter: by morning it is gone ──────────────────────────────────────────────────────────── */

export function Scatter({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const gone = c.w('gone');
  const sheet = c.w('spreadsheet');
  const inbox = c.w('inbox');
  const memory = c.w('memory');
  const { durationInFrames: d } = useVideoConfig();
  const dissolve = p(f, gone - 10, gone + 26, easeIn);
  const dark = p(f, gone - 20, gone + 30);
  const end = p(f, d - 30, d, easeInOut);
  return (
    <AbsoluteFill>
      <Backdrop glow={0.8 * (1 - dark * 0.7)} contours={0.05 * (1 - dark)} />
      {/* The same work, coming apart. */}
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - dissolve, filter: `blur(${dissolve * 16}px)`, transform: `translateY(${-dissolve * 60}px) scale(${1 + dissolve * 0.06})` }}>
        <div style={{ position: 'absolute', left: 150, top: 250, fontFamily: FONT, fontSize: 340, fontWeight: 600, letterSpacing: '-0.06em', lineHeight: 0.9, color: C.white }}>30</div>
        <div style={{ position: 'absolute', left: 150, top: 590 }}><Eyebrow text="Reconciliations" at={-40} style={{ fontSize: 24 }} /></div>
        <FundingGap at={-60} caught={-30} style={{ position: 'absolute', right: 150, top: 300, width: 860 }} />
      </div>
      <Embers from={gone - 8} />
      <div style={{ position: 'absolute', inset: 0, perspective: 1800, perspectiveOrigin: '50% 45%', opacity: 1 - end }}>
        <Fragment at={sheet - 10} next={inbox - 6} x={-560} y={-40} rz={-4}><Spreadsheet /></Fragment>
        <Fragment at={inbox - 10} next={memory - 6} x={0} y={70} rz={2}><Inbox /></Fragment>
        <Fragment at={memory - 10} next={d - 34} x={560} y={-30} rz={5}><Sticky /></Fragment>
      </div>
    </AbsoluteFill>
  );
}

/** Specks lifting off where the work was. */
function Embers({ from }: { from: number }) {
  const f = useCurrentFrame();
  if (f < from) return null;
  const t = f - from;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {Array.from({ length: 160 }, (_, i) => {
        const r1 = rand(i + 11); const r2 = rand(i + 211); const r3 = rand(i + 411);
        const x0 = r1 < 0.45 ? 150 + r2 * 420 : 1000 + r2 * 760;
        const y0 = 280 + r3 * 460;
        const life = 40 + r3 * 50;
        const k = Math.min(1, t / life);
        const x = x0 + (r2 - 0.3) * 240 * k + Math.sin(t / 12 + i) * 8;
        const y = y0 - (80 + r1 * 260) * k;
        const o = (1 - k) * (0.3 + r1 * 0.6) * Math.min(1, t / 6);
        const s = 2 + r3 * 4;
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: s, height: s, borderRadius: 1, background: r2 > 0.7 ? `rgba(63,208,189,${o})` : `rgba(210,222,245,${o})` }} />;
      })}
    </div>
  );
}

/** One place work goes to be lost: it arrives out of the dark, and falls back into it. */
function Fragment({ at, next, x, y, rz, children }: { at: number; next: number; x: number; y: number; rz: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const i = land(f, fps, at, 20);
  const fall = p(f, next, next + 60, easeIn);
  const z = -600 * (1 - i) - 900 * fall;
  const o = Math.min(1, i * 1.4) * (1 - fall * 0.85);
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transformStyle: 'preserve-3d', transform: `translate(-50%,-50%) translate3d(${x}px, ${y + fall * 120}px, ${z}px) rotateZ(${rz + fall * 6}deg) rotateX(${fall * 18}deg) scale(1.22)`, opacity: o, filter: fall > 0.02 ? `blur(${fall * 6}px)` : undefined }}>
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
    ['M67854-26-RC-00176', '0002', 'open', '6,270.00', '37', ''],
  ];
  return (
    <div style={{ width: 620, borderRadius: 14, overflow: 'hidden', background: '#f4f6f8', boxShadow: '0 50px 100px -30px rgba(0,0,0,0.8)', fontFamily: FONT }}>
      <div style={{ height: 40, background: '#1f7a4d', color: '#fff', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 15, fontWeight: 600, letterSpacing: '0.01em' }}>ULO_recon_FINAL_v3 (2).xlsx</div>
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
    ['FW: FW: tracker', 'use this one not the other one', false],
  ] as const;
  return (
    <div style={{ width: 600, borderRadius: 14, overflow: 'hidden', background: '#fff', boxShadow: '0 50px 100px -30px rgba(0,0,0,0.8)', fontFamily: FONT }}>
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
    <div style={{ width: 320, height: 300, background: 'linear-gradient(170deg, #ffe98a, #f7d95c)', boxShadow: '0 40px 80px -24px rgba(0,0,0,0.7)', padding: '34px 30px', fontFamily: FONT, fontSize: 30, lineHeight: 1.25, color: '#3a3320', fontStyle: 'italic', fontWeight: 500, letterSpacing: '-0.01em' }}>
      ask SSgt D. about the 448-2 <br />— before Friday!!
      <div style={{ marginTop: 26, fontSize: 22, opacity: 0.7 }}>(the MIPR one)</div>
    </div>
  );
}

/* ── title: Vantage keeps it ─────────────────────────────────────────────────────────────────── */

export function Title({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const flash = Math.max(0, 1 - f / 26);
  const bloom = p(f, 0, 70, easeOut);
  const { words, at } = lineWords(c, 0, undefined, 2);
  const keepFrom = words.findIndex((w) => /keeps/i.test(w));
  const push = 1 + p(f, 0, 150, easeInOut) * 0.035;
  return (
    <AbsoluteFill style={{ background: '#02060d' }}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 520px at 50% 44%, rgba(47,107,255,${0.34 * bloom}), rgba(63,208,189,${0.08 * bloom}) 45%, transparent 72%)` }} />
      {/* The hit: a flare that races across and is gone. */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 432, height: 4, background: `linear-gradient(90deg, transparent, rgba(160,220,255,${0.9 * flash}) 30%, rgba(255,255,255,${flash}) 50%, rgba(160,220,255,${0.9 * flash}) 70%, transparent)`, filter: 'blur(1.5px)', transform: `scaleX(${0.3 + (1 - flash) * 1.2})` }} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, rgba(255,255,255,${0.55 * flash ** 2}), transparent 40%)` }} />
      <Dust n={70} seed={9} max={0.3} rise={0.2} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${push})` }}>
        <div style={{ marginTop: -80 }}><Mark size={190} at={1} /></div>
        <div style={{ marginTop: 56, display: 'flex', gap: 28, alignItems: 'baseline' }}>
          <Super words={words.slice(0, keepFrom)} at={at.slice(0, keepFrom)} size={124} weight={600} tracking={-0.045} />
          <Super words={words.slice(keepFrom)} at={at.slice(keepFrom)} size={124} weight={600} tracking={-0.045}
            gradient="linear-gradient(100deg, #ffffff 0%, #bff3ea 45%, #3fd0bd 100%)" />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
