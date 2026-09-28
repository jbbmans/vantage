import type { ReactNode } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { Backdrop } from '../components/Backdrop';
import { Caption, DemoTag } from '../components/Caption';
import { Finish } from '../components/Finish';
import { Dust } from '../components/Kit';
import { Mix } from '../components/Mix';
import { easeInOut, p } from '../lib/motion';
import { MOMENTS } from '../moments';
import { film, localCards, type TScene } from '../timeline';
import { C, FONT } from '../theme';
import { AppWindow, BalanceChart, BigCount, CaseStills, CreditBlock, EndLogo, FundingGap, HistoryChain, LateScreen, LogoHit, Months, ReportDoc, Ring, Scattered, StillShot } from './Pieces';

type Place = 'top' | 'bottom' | 'left' | 'hero' | 'topCenter' | 'none';

/** Where a scene's words sit, so they never cover what the scene is showing. */
function Words({ scene, accent, place }: { scene: TScene; accent: string; place: Place }) {
  if (place === 'none') return null;
  const cards = localCards(scene);
  const box: Record<Exclude<Place, 'none'>, React.CSSProperties> = {
    top: { left: 150, top: 86, width: 1500 },
    topCenter: { left: 210, right: 210, top: 96, display: 'flex', justifyContent: 'center' },
    bottom: { left: 210, right: 210, bottom: 110, display: 'flex', justifyContent: 'center' },
    left: { left: 150, top: 380, width: 700 },
    hero: { left: 150, top: 330, width: 1480 },
  };
  const size = place === 'hero' ? 88 : place === 'left' ? 58 : undefined;
  return (
    <>
      {cards.map((c, i) => (
        <div key={i} style={{ position: 'absolute', ...box[place] }}>
          <Caption text={c.text} from={c.from + 6} to={c.to} accent={accent} size={size} align={place === 'bottom' || place === 'topCenter' ? 'center' : 'left'}
            maxWidth={place === 'left' ? 700 : place === 'bottom' || place === 'topCenter' ? 1400 : 1500} />
        </div>
      ))}
    </>
  );
}

/** A scene's picture fades up from the one before and gives way at its end. */
function Fade({ children, d, inFrames = 10, outFrames = 8 }: { children: ReactNode; d: number; inFrames?: number; outFrames?: number }) {
  const f = useCurrentFrame();
  const o = p(f, 0, inFrames, easeInOut) * (1 - p(f, d - outFrames, d, easeInOut));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

const Room = ({ accent, children, dark = false }: { accent: string; children?: ReactNode; dark?: boolean }) => (
  <>
    <Backdrop glow={dark ? 0.5 : 1} contours={0.06} accent={accent} />
    <Dust n={40} seed={5} max={0.2} />
    {children}
  </>
);

interface Shot { place: Place; picture: (ctx: { d: number; accent: string; id: string }) => ReactNode; demo?: boolean; bare?: boolean }

const AD_SHOTS: Record<string, Shot> = {
  'ad-work': { place: 'bottom', picture: ({ accent }) => <Room accent={accent} dark><div style={{ position: 'absolute', left: 0, right: 0, top: 230, display: 'flex', justifyContent: 'center' }}><BigCount to={30} label="ULOs reconciled" accent={accent} size={320} /></div></Room> },
  'ad-gap': { place: 'bottom', picture: ({ d, accent }) => <Room accent={accent}><FundingGap at={Math.round(MOMENTS.gap.card * 30)} caught={Math.round(d * MOMENTS.gap.stamp) - 4} style={{ position: 'absolute', left: 530, top: 210, width: 860 }} /></Room> },
  'ad-later': { place: 'bottom', picture: ({ accent }) => <Room accent={accent} dark><div style={{ position: 'absolute', left: 0, right: 0, top: 330, display: 'flex', justifyContent: 'center' }}><Months accent={accent} /></div></Room> },
  'ad-scatter': { place: 'topCenter', picture: ({ d, accent }) => <Room accent={accent} dark><Scattered fall={d - 42} /></Room> },
  'ad-logo': { place: 'none', bare: true, picture: ({ accent }) => <LogoHit accent={accent} /> },
  'ad-capture': { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><AppWindow take="ad/ad-capture" width={1340} left={290} top={236} /></Room> },
  'ad-queue': { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><AppWindow take="ad/ad-queue" width={1340} left={290} top={236} /></Room> },
  'ad-history': { place: 'left', demo: true, picture: ({ accent }) => <Room accent={accent}><HistoryChain style={{ left: 880, top: 150, scale: '0.94', transformOrigin: '0 0' }} /></Room> },
  'ad-report': { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><ReportDoc top={300} /></Room> },
  'ad-lead': { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><StillShot src="hero-lead" width={1400} left={260} top={260} /></Room> },
  'ad-private': { place: 'topCenter', demo: true, picture: ({ accent }) => <Room accent={accent} dark><StillShot src="hero-private" width={1240} left={340} top={420} sweep={false} /></Room> },
  'ad-end': { place: 'none', bare: true, picture: ({ accent }) => <EndLogo accent={accent} /> },
};

const TOUR_SHOTS: Record<string, Shot> = {
  open: { place: 'hero', bare: true, picture: () => <AbsoluteFill style={{ background: '#02060d' }}><LateScreen /></AbsoluteFill> },
  detail: { place: 'bottom', picture: ({ d, accent }) => <Room accent={accent}><BigCount to={30} label="Reconciliations" accent={accent} size={300} style={{ position: 'absolute', left: 150, top: 220 }} /><FundingGap at={Math.round(MOMENTS.gap.card * 30) + 10} caught={Math.round(d * MOMENTS.gap.stamp)} style={{ position: 'absolute', right: 150, top: 230, width: 860 }} /></Room> },
  scatter: { place: 'topCenter', picture: ({ d, accent }) => <Room accent={accent} dark><Scattered fall={d - 42} /></Room> },
  title: { place: 'none', bare: true, picture: ({ accent }) => <LogoHit accent={accent} /> },
  capture: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><AppWindow take="hero/capture" width={1340} left={290} top={236} /></Room> },
  queue: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><AppWindow take="hero/queue" width={1340} left={290} top={236} /></Room> },
  case: { place: 'left', demo: true, picture: ({ accent }) => <Room accent={accent}><CaseStills /></Room> },
  balance: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><BalanceChart top={250} /></Room> },
  sealed: { place: 'left', demo: true, picture: ({ accent }) => <Room accent={accent}><HistoryChain style={{ left: 880, top: 150, scale: '0.94', transformOrigin: '0 0' }} /></Room> },
  credit: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><CreditBlock accent={accent} /></Room> },
  report: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><ReportDoc top={300} /></Room> },
  lead: { place: 'top', demo: true, picture: ({ accent }) => <Room accent={accent}><StillShot src="hero-lead" width={1400} left={260} top={260} /></Room> },
  trust: { place: 'topCenter', picture: ({ accent }) => <AbsoluteFill style={{ background: '#02060d' }}><Ring accent={accent} /></AbsoluteFill> },
  end: { place: 'none', bare: true, picture: ({ accent }) => <EndLogo accent={accent} /> },
};

function Story({ id, shots }: { id: string; shots: Record<string, Shot> }) {
  const tl = film(id);
  const accent = tl.accent;
  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT }}>
      {tl.scenes.map((s) => {
        const shot = shots[s.id];
        if (!shot) throw new Error(`No picture for ${id} scene ${s.id}`);
        const d = s.to - s.from;
        return (
          <Sequence key={s.id} from={s.from} durationInFrames={d + 8} name={s.id}>
            <Fade d={d + 8} inFrames={shot.bare ? 1 : 10}>
              {shot.picture({ d, accent, id })}
              {shot.demo && <DemoTag style={{ position: 'absolute', right: 60, bottom: 40 }} />}
            </Fade>
            <Words scene={s} accent={accent} place={shot.place} />
          </Sequence>
        );
      })}
      <Finish grain={0.035} vignette={0.45} />
      <Mix id={id} />
    </AbsoluteFill>
  );
}

export const Ad = () => <Story id="ad" shots={AD_SHOTS} />;
export const Tour = () => <Story id="hero" shots={TOUR_SHOTS} />;
