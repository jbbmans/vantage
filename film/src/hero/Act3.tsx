import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Counter, Dust, Glass, Mono, Reveal, Shot, Wordmark } from '../components/Kit';
import { Mark } from '../components/Mark';
import { Eyebrow, Super } from '../components/Super';
import { SyntheticTag } from '../components/Tag';
import type { cues } from '../cues';
import { easeIn, easeInOut, land, p, rand } from '../lib/motion';
import { C, FONT, MONO } from '../theme';
import { lineWords } from './Act1';

type Cues = ReturnType<typeof cues>;

/* ── sealed: every entry signed into the history ─────────────────────────────────────────────── */

const ENTRIES = [
  { who: 'You', text: 'recorded current award amount: $91,250.00 (DAI)', chip: 'Read by hand', hash: '9c41·e07a' },
  { who: 'You', text: 'recorded invoice amount: $45,000.00 (DAI)', chip: 'Read by hand', hash: '3f9a·c1d2' },
  { who: 'You', text: 'calculated candidate award adjustment: +$2,775.00', chip: 'Calculate the candidate adjustment', hash: '7b20·94e6' },
  { who: 'You', text: 'decided: amend the requisition first', chip: '“Requisition shows $1,500.00 against +$2,775.00.”', hash: 'd5e8·1a3b' },
  { who: 'You', text: 'handed this to SSgt Morgan Diaz', chip: '“The requisition amendment is next.”', hash: '0e6c·b8f4' },
  { who: 'SSgt Morgan Diaz', text: 'submitted: amend the requisition', chip: 'SYN-REQ-AMD-1', hash: 'a217·5dc9' },
];

export function Sealed({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const l0 = c.line(0);
  const nothing = c.w('nothing');
  const step = Math.max(8, Math.min(16, (nothing - 14 - l0.from) / ENTRIES.length));
  const seal = land(f, fps, nothing - 6, 12);
  return (
    <AbsoluteFill>
      <Backdrop glow={0.9} contours={0.05} />
      <div style={{ position: 'absolute', left: 150, top: 350, width: 640 }}>
        <Eyebrow text="History" at={2} />
        <div style={{ marginTop: 30 }}><Super words="Signed into the history." at={c.w('signed') - 4} size={70} weight={600} tracking={-0.04} stagger={2} /></div>
        <div style={{ marginTop: 22 }}><Super words="Nothing happens quietly." at={nothing - 2} size={70} weight={600} tracking={-0.04} stagger={2} color={C.soft} /></div>
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2200, perspectiveOrigin: '70% 50%' }}>
        <div style={{ position: 'absolute', left: 900, top: 150, width: 880, transform: `rotateY(-10deg) rotateX(4deg) translateY(${-p(f, 0, 170) * 30}px)`, transformStyle: 'preserve-3d' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22, transform: `scale(${0.8 + seal * 0.2})`, transformOrigin: '100% 50%', opacity: Math.min(1, seal * 1.4) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderRadius: 999, background: 'rgba(4,20,30,0.85)', boxShadow: `inset 0 0 0 1.5px rgba(63,208,189,0.6), 0 0 ${70 * seal}px rgba(63,208,189,0.35)`, fontFamily: FONT, fontSize: 22, fontWeight: 600, color: '#fff' }}>
              <svg width="24" height="26" viewBox="0 0 24 26"><path d="M12 1.5 21.5 5v7.2c0 5.9-4 10.2-9.5 12.3C6.5 22.4 2.5 18.1 2.5 12.2V5L12 1.5Z" fill="rgba(63,208,189,0.15)" stroke={C.teal} strokeWidth="2" /><path d="M7.5 13 10.8 16.2 16.8 10" fill="none" stroke={C.teal} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              History sealed · 13 entries
            </div>
          </div>
          <div style={{ position: 'relative', display: 'grid', gap: 14 }}>
            {/* The chain: each entry signed over the one before it. */}
            <div style={{ position: 'absolute', left: 30, top: 34, bottom: 34, width: 2, background: `linear-gradient(180deg, rgba(63,208,189,${0.2 + seal * 0.7}), rgba(63,208,189,0.15))`, boxShadow: seal > 0.1 ? `0 0 ${14 * seal}px rgba(63,208,189,0.8)` : undefined }} />
            {ENTRIES.map((e, k) => {
              const at = l0.from - 4 + k * step;
              const i = land(f, fps, at, 16);
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
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── credit: to the Marine who did the work ──────────────────────────────────────────────────── */

export function Credit({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const credit = c.w('credit');
  const marine = c.w('marine');
  const card = land(f, fps, 4, 20);
  const hi = p(f, marine - 4, marine + 14);
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} hue="warm" />
      <div style={{ position: 'absolute', left: 150, top: 250 }}>
        <Eyebrow text="Your record" at={2} />
        <div style={{ marginTop: 36, display: 'flex', gap: 80 }}>
          {[{ n: 40, label: 'documents researched', at: credit - 10 }, { n: 66, label: 'verified outcomes', at: credit - 2 }].map((x) => (
            <div key={x.label} style={{ opacity: p(f, x.at, x.at + 12) }}>
              <div style={{ fontFamily: FONT, fontSize: 190, fontWeight: 600, letterSpacing: '-0.055em', lineHeight: 0.9, color: '#fff' }}><Counter to={x.n} at={x.at} frames={30} /></div>
              <div style={{ marginTop: 14, fontFamily: FONT, fontSize: 26, color: C.soft }}>{x.label}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 70, width: 780 }}><Super words="Credited to the Marine who did the work." at={marine - 16} size={58} weight={600} tracking={-0.035} stagger={2} /></div>
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2000, perspectiveOrigin: '80% 50%' }}>
        <div style={{ position: 'absolute', left: 1130, top: 300, transform: `translate3d(${(1 - card) * 160}px, 0, ${(1 - card) * -300}px) rotateY(-14deg) rotateX(3deg)`, opacity: Math.min(1, card * 1.3) }}>
          <div style={{ position: 'relative' }}>
            <Shot src="hero-who" natural={[760, 478]} width={660} />
            {/* The Marine's own line, lit. */}
            <div style={{ position: 'absolute', left: 22, top: 148, width: 616, height: 80, borderRadius: 16, boxShadow: `0 0 0 ${2 * hi}px rgba(63,208,189,0.9), 0 0 ${60 * hi}px rgba(63,208,189,0.35)`, opacity: hi }} />
          </div>
        </div>
      </div>
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── report: the record, already written ─────────────────────────────────────────────────────── */

const SENTENCE = [
  { t: 'Reconciled 30 ULOs worth $41,806.12', cite: 1 },
  { t: ' and cleared 12 UMTs,', cite: 2 },
  { t: ' with zero findings at review.', cite: 0 },
];

export function Report({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const written = c.w('written');
  const cites = c.w('cites');
  const doc = land(f, fps, 0, 22);
  const total = SENTENCE.reduce((n, s) => n + s.t.length, 0);
  const typed = Math.floor(p(f, written - 20, written + 40, (x) => x) * total);
  let used = 0;
  const src = [
    { n: 1, title: 'Reconciled 30 ULOs totaling $41,806.12 in SABRS', meta: '23 Sep 26 · 30 ULOs · $41.8K reconciled', y: 330 },
    { n: 2, title: 'Cleared 12 unmatched transactions in DAI', meta: '18 Sep 26 · 12 UMTs', y: 520 },
  ];
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} />
      <div style={{ position: 'absolute', left: 150, top: 110 }}><Eyebrow text="Report Studio" at={2} /></div>
      <div style={{ position: 'absolute', left: 150, top: 170, width: 900 }}>
        <Super words="Already written. Every line cited." at={c.w('record') - 4} size={60} weight={600} tracking={-0.035} stagger={2} />
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2400, perspectiveOrigin: '40% 60%' }}>
        <div style={{ position: 'absolute', left: 150, top: 330, width: 1000, transform: `translate3d(0, ${(1 - doc) * 80}px, ${(1 - doc) * -300}px) rotateX(${8 - p(f, 0, 220) * 6}deg) rotateY(6deg)`, opacity: Math.min(1, doc * 1.3), transformStyle: 'preserve-3d' }}>
          <div style={{ borderRadius: 22, background: '#fbfbf9', padding: '46px 56px 50px', boxShadow: '0 70px 140px -40px rgba(0,0,0,0.85)' }}>
            <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.16em', color: '#64748b' }}>2026-07-01 TO 2026-09-30</div>
            <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 50, color: '#0f172a', marginTop: 10, letterSpacing: '-0.01em' }}>FY26 Q4 JEPES input</div>
            <div style={{ marginTop: 30, borderRadius: 16, boxShadow: 'inset 0 0 0 1px #e2e8f0', padding: '22px 26px' }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 24, color: '#0f172a' }}><span style={{ fontFamily: MONO, fontSize: 14, color: '#94a3b8', marginRight: 12 }}>01</span>Mission accomplishment</div>
              <div style={{ marginTop: 16, minHeight: 110, fontFamily: "Georgia, serif", fontSize: 29, lineHeight: 1.45, color: '#1e293b' }}>
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
            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10, fontFamily: FONT, fontSize: 18, color: '#0f766e', opacity: p(f, cites + 30, cites + 44) }}>
              <svg width="18" height="18" viewBox="0 0 18 18"><path d="M3.5 9.5 7.2 13 14.5 5.5" fill="none" stroke="#0f766e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Saved through revision 1.
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
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── lead: the whole section at a glance ─────────────────────────────────────────────────────── */

export function Lead({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { durationInFrames: d, fps } = useVideoConfig();
  const k = p(f, 0, d, easeInOut);
  const enter = land(f, fps, 0, 22);
  const sweep = p(f, 10, 70, easeInOut);
  return (
    <AbsoluteFill>
      <Backdrop glow={1} contours={0.06} />
      <div style={{ position: 'absolute', left: 150, top: 90, width: 1600, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Super words="The whole section, at a glance." at={c.w('leaders') - 2} size={64} weight={600} tracking={-0.035} stagger={2} />
        <Eyebrow text="Section lead" at={4} />
      </div>
      <div style={{ position: 'absolute', inset: 0, perspective: 2600, perspectiveOrigin: '50% 40%' }}>
        <div style={{ position: 'absolute', left: 260, top: 250, transform: `translate3d(${(1 - enter) * 100 - k * 60}px, ${(1 - enter) * 80}px, ${(1 - enter) * -300}px) rotateX(${14 - k * 8}deg) rotateY(${8 - k * 14}deg)`, opacity: Math.min(1, enter * 1.3) }}>
          <div style={{ position: 'relative' }}>
            <Shot src="hero-lead" natural={[2880, 1620]} width={1400} />
            <div style={{ position: 'absolute', inset: 0, borderRadius: 20, overflow: 'hidden', pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', top: -200, bottom: -200, width: 260, left: -400 + sweep * 2200, transform: 'rotate(18deg)', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)' }} />
            </div>
          </div>
        </div>
      </div>
      <SyntheticTag at={10} />
    </AbsoluteFill>
  );
}

/* ── trust: private by default, your network ─────────────────────────────────────────────────── */

export function Trust({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const ring = p(f, 6, 60, easeInOut);
  const built = c.w('built');
  const leave = p(f, d - 16, d, easeIn);
  const R = 300;
  return (
    <AbsoluteFill style={{ background: '#02060d', opacity: 1 - leave }}>
      <AbsoluteFill style={{ background: `radial-gradient(700px 520px at 50% 50%, rgba(20,184,166,${0.12 * ring}), transparent 70%)` }} />
      <Dust n={40} seed={21} max={0.18} rise={0.08} />
      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <radialGradient id="fadeGrid"><stop offset="0.4" stopColor="#fff" stopOpacity="0.07" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        </defs>
        {Array.from({ length: 30 }, (_, i) => Array.from({ length: 17 }, (_, j) => {
          const x = 60 + i * 62; const y = 40 + j * 62; const dd = Math.hypot(x - 960, y - 540);
          return dd > R + 30 ? <circle key={`${i}-${j}`} cx={x} cy={y} r="1.4" fill="rgba(201,213,232,0.16)" opacity={Math.max(0, 1 - (dd - R) / 700) * ring} /> : null;
        }))}
        <circle cx="960" cy="540" r={R} fill="none" stroke="rgba(63,208,189,0.75)" strokeWidth="2" strokeDasharray={2 * Math.PI * R} strokeDashoffset={2 * Math.PI * R * (1 - ring)} style={{ filter: 'drop-shadow(0 0 10px rgba(63,208,189,0.7))' }} transform="rotate(-90 960 540)" />
        <circle cx="960" cy="540" r={R + 18} fill="none" stroke="rgba(63,208,189,0.15)" strokeWidth="1" strokeDasharray="4 10" opacity={ring} />
        {Array.from({ length: 26 }, (_, i) => {
          const r = 90 + rand(i + 3) * (R - 120);
          const a = rand(i + 50) * Math.PI * 2 + (f / 30) * (0.25 + rand(i + 90) * 0.5) * (i % 2 ? 1 : -1);
          return <circle key={i} cx={960 + Math.cos(a) * r} cy={540 + Math.sin(a) * r} r={2 + rand(i) * 2.5} fill={i % 3 ? 'rgba(201,213,232,0.8)' : C.teal} opacity={ring * (0.4 + rand(i + 7) * 0.6)} />;
        })}
      </svg>
      <div style={{ position: 'absolute', left: 960 - 55, top: 540 - 55, opacity: ring }}><Mark size={110} still /></div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 110, display: 'flex', justifyContent: 'center' }}>
        <Super words="Private by default." at={c.w('private') - 3} size={70} weight={600} tracking={-0.04} stagger={2} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center' }}>
        <Super words="On your own network." at={built - 1} size={70} weight={600} tracking={-0.04} stagger={2} color={C.soft} />
      </div>
    </AbsoluteFill>
  );
}

/* ── end: give good work a lasting record ────────────────────────────────────────────────────── */

export function End({ c }: { c: Cues }) {
  const f = useCurrentFrame();
  const { durationInFrames: d } = useVideoConfig();
  const vantage = c.w('vantage');
  const { words, at } = lineWords(c, 0, undefined, 3);
  const give = words.findIndex((w) => /give/i.test(w));
  const out = p(f, d - 22, d - 2, easeInOut);
  const bloom = p(f, 0, 80);
  return (
    <AbsoluteFill style={{ background: '#02060d' }}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 600px at 50% 46%, rgba(47,107,255,${0.26 * bloom}), rgba(63,208,189,${0.06 * bloom}) 50%, transparent 75%)` }} />
      <Dust n={60} seed={31} max={0.25} rise={0.15} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ marginTop: -60 }}><Mark size={150} at={vantage - 16} /></div>
        <Reveal at={vantage - 2} y={16} style={{ marginTop: 44 }}><Wordmark size={46} spacing={0.36} /></Reveal>
        <div style={{ marginTop: 50 }}>
          <Super words={words.slice(give)} at={at.slice(give)} size={62} weight={500} tracking={-0.03} color="#e6edf7" stagger={2} />
        </div>
      </AbsoluteFill>
      <Reveal at={c.w('record', { end: true }) + 20} style={{ position: 'absolute', left: 0, right: 0, bottom: 64, textAlign: 'center', fontFamily: FONT, fontSize: 18, color: 'rgba(201,213,232,0.5)', letterSpacing: '0.02em' }}>
        Synthetic demo data throughout · Not an official DoD or USMC system of record
      </Reveal>
      <AbsoluteFill style={{ background: '#000', opacity: out }} />
    </AbsoluteFill>
  );
}

