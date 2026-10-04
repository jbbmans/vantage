import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, BookOpen, CheckCircle2, ChevronRight, CircleDot, Circle, Compass, FileText, Fingerprint, GitBranch,
  Landmark, Layers3, ListChecks, Lock, Menu, Paperclip, Play, RotateCcw, ShieldCheck, ScrollText, Server, Sparkles, UserRound, Users, WifiOff,
} from 'lucide-react';
import { FAQS, SITE } from '@/config/site';
import { TrustBody, TrustHero, trustPageFor, type TrustPage } from '@/pages/public/TrustPages';
import { publishedVideos } from '@/config/videos';
import LiveParser from '@/components/public/LiveParser';
import './PublicSite.css';

const samples = [
  { title: 'Clear a 2-Way UMT', detail: 'Recorded the award and two invoices, calculated a +$2,775.00 candidate adjustment, and verified the UMT cleared on the next report.', evidence: 'UMT report line, invoice pair', category: 'Fiscal & Financial', count: '1 UMT cleared' },
  { title: 'Conduct range brief', detail: 'Briefed 20 Marines on range procedures and safety responsibilities.', evidence: 'Range brief checklist', category: 'Leadership', count: '20 Marines briefed' },
  { title: 'Train the next team', detail: 'Led 2 hours of reconciliation training for 4 junior Marines.', evidence: 'Training attendance record', category: 'Training', count: '4 Marines trained' },
];

const videos = publishedVideos();

function useReveal(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.classList.add('ps-motion');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    el.querySelectorAll('[data-reveal]').forEach((n) => {
      if (n.getBoundingClientRect().top < window.innerHeight) n.classList.add('in');
      else io.observe(n);
    });
    return () => io.disconnect();
  }, [root]);
}

// Plain links, not router links: the public page is its own document (public.html), and signing in loads the app.
function PillLink({ href, children, tone = 'light' }: { href: string; children: React.ReactNode; tone?: 'light' | 'dark' }) {
  return <a href={href} className={`ps-pill ps-pill-${tone}`}><span>{children}</span><span className="ps-pill-icon" aria-hidden><ArrowUpRight strokeWidth={1.75} /></span></a>;
}

function CaseMock() {
  const steps: Array<[string, 'done' | 'current' | 'todo' | 'branch']> = [
    ['Record the lifecycle figures', 'done'],
    ['Calculate the open residual', 'current'],
    ['Research the cause and its evidence', 'todo'],
    ['Decide the cause the evidence supports', 'todo'],
    ['Confirm the requirement is no longer valid', 'branch'],
    ['Verify the residual cleared', 'todo'],
  ];
  return (
    <div className="ps-bezel ps-case" aria-label="A case in Vantage, with sample data">
      <div className="ps-bezel-core">
        <div className="ps-window-bar" aria-hidden><i /><i /><i /><span>vantage · work</span></div>
        <div className="ps-case-body">
          <div className="ps-case-main">
            <p className="ps-case-eyebrow">Open balances review · <b>SYN-26-OB-0103</b> · <em>OCMT</em></p>
            <p className="ps-case-title">OCMT on a MIPR</p>
            <p className="ps-case-meta"><span className="ps-tag">Researching</span><span>Held by you</span><span className="ps-seal"><ShieldCheck strokeWidth={1.75} aria-hidden />History sealed · 9 entries</span></p>
            <div className="ps-card">
              <p className="ps-card-title">What the figures show <span className="ps-tag ps-tag-quiet">MIPR</span></p>
              <div className="ps-bars">
                {[
                  ['Commitment', 100, '$32,000.00', null],
                  ['Obligation', 0, 'Not shown', 'OCMT $32,000.00 open'],
                  ['Delivered', 0, 'Not shown', null],
                  ['Paid', 0, 'Not shown', null],
                ].map(([label, pct, value, gap]) => (
                  <div className="ps-bar-row" key={String(label)}>
                    <span className="ps-bar-label">{label}</span>
                    <span className={`ps-bar ${pct ? '' : 'ps-bar-empty'} ${gap ? 'ps-bar-gap' : ''}`}><span style={{ width: `${pct}%` }} /></span>
                    <span className="ps-bar-value">{value}{gap && <small>{gap}</small>}</span>
                  </div>
                ))}
              </div>
              <p className="ps-card-note">A requisition amount not yet covered by an obligation. On a MIPR, look for the signed DD 448-2 before anything else.</p>
            </div>
          </div>
          <div className="ps-case-side">
            <p className="ps-card-title">Procedure <small>v1.0.0</small></p>
            <ol className="ps-steps">
              {steps.map(([title, state]) => (
                <li key={title} className={`ps-step ps-step-${state}`}>
                  {state === 'done' ? <CheckCircle2 strokeWidth={1.75} aria-hidden /> : state === 'current' ? <CircleDot strokeWidth={1.75} aria-hidden /> : state === 'branch' ? <GitBranch strokeWidth={1.75} aria-hidden /> : <Circle strokeWidth={1.75} aria-hidden />}
                  <span>{title}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      <div className="ps-float ps-float-a" aria-hidden><Lock strokeWidth={1.75} />Delivery is evidenced before the award is touched</div>
      <div className="ps-float ps-float-b" aria-hidden><Users strokeWidth={1.75} />Claiming is not credit</div>
    </div>
  );
}

/** The hero: what a Marine actually gets. One sentence in, an entry with its evidence, and a report line that cites it. */
function RecordMock() {
  return (
    <div className="ps-bezel ps-case ps-record" aria-label="Quick Log, the Record and Report Studio in Vantage, with sample data">
      <div className="ps-bezel-core">
        <div className="ps-window-bar" aria-hidden><i /><i /><i /><span>vantage · today</span></div>
        <div className="ps-record-body">
          <div className="ps-record-step">
            <p className="ps-record-label"><span>1</span>Say what you did</p>
            <div className="ps-record-input"><span>Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday</span><kbd>N</kbd></div>
            <div className="ps-record-chips"><span>30 ULOs</span><span>$1,118.38 reconciled</span><span>DAI</span><span>Yesterday</span><span className="ps-chip-quiet">Fiscal &amp; Financial</span></div>
          </div>
          <div className="ps-record-step">
            <p className="ps-record-label"><span>2</span>It joins your record, with its evidence</p>
            <ul className="ps-record-list">
              <li><b>Reconciled 30 ULOs in DAI</b><small><Paperclip strokeWidth={1.75} aria-hidden />ULO report attached</small><em>$1,118.38</em></li>
              <li><b>Cleared a 2-Way UMT</b><small><ShieldCheck strokeWidth={1.75} aria-hidden />Verified on the next report</small><em>$2,775.00</em></li>
              <li><b>Led reconciliation training, 4 Marines</b><small><Users strokeWidth={1.75} aria-hidden />Attendance roster attached</small><em>2 hrs</em></li>
            </ul>
          </div>
          <div className="ps-record-step ps-record-report">
            <p className="ps-record-label"><span>3</span>FITREP input that cites itself</p>
            <p className="ps-record-bullet">Reconciled 30 ULOs and cleared a 2-Way UMT, $3,893.38 in all, each verified on the following report<sup>1–2</sup>; trained 4 junior Marines in reconciliation<sup>3</sup>.</p>
            <p className="ps-record-sources">3 sources · every figure opens to its entry</p>
          </div>
        </div>
      </div>
      <div className="ps-float ps-float-a" aria-hidden><Lock strokeWidth={1.75} />Private until you share it</div>
      <div className="ps-float ps-float-b" aria-hidden><Sparkles strokeWidth={1.75} />Nothing is saved until you check it</div>
    </div>
  );
}

const ROLES: Array<{ icon: typeof UserRound; who: string; title: string; text: string; href: string }> = [
  { icon: UserRound, who: 'E-1 to E-4', title: 'JEPES input', text: 'Log what you did as it happens. Your record builds the evidence your reporting senior needs.', href: '#product' },
  { icon: Compass, who: 'E-5 and up', title: 'FITREP input', text: 'Bullets by evaluation area, drafted from entries you can open and check, never from memory.', href: '#product' },
  { icon: Users, who: 'Section and command leaders', title: 'Workload without a roll call', text: 'Who holds what, what is waiting and what is blocked, from the work itself. People are never labelled.', href: '#product' },
  { icon: Landmark, who: 'Financial management analysts', title: 'Balances, read in order', text: 'Open balances diagnosed in lifecycle order, with cited procedures and evidence gates.', href: '#analysts' },
  { icon: Server, who: 'Owners and ISSMs', title: 'Runs on your own host', text: 'One process, no outbound calls by default, CAC and Entra ID, an audit chain you can verify.', href: '/security#deployment' },
];

function RoleStrip() {
  return (
    <section className="ps-section ps-container ps-roles" id="roles" aria-labelledby="ps-roles-title">
      <div className="ps-section-head" data-reveal>
        <p className="ps-eyebrow">Built for your role</p>
        <h2 id="ps-roles-title">One record. Each person sees their part.</h2>
      </div>
      <ul className="ps-role-grid" data-reveal>
        {ROLES.map(({ icon: Icon, who, title, text, href }) => (
          <li key={title}>
            <a href={href}>
              <span className="ps-role-icon" aria-hidden><Icon strokeWidth={1.75} /></span>
              <small>{who}</small>
              <strong>{title}</strong>
              <span>{text}</span>
              <ArrowRight className="ps-role-go" strokeWidth={1.75} aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpeedStrip() {
  const keys: Array<[string[], string]> = [[['N'], 'Log what you did, from any page'], [['⌘', 'K'], 'Find any record, case or reference'], [['G', 'D'], 'Jump to Today, or anywhere'], [['?'], 'Every shortcut']];
  return (
    <div className="ps-speed" data-reveal>
      <div>
        <p className="ps-tile-kicker"><WifiOff strokeWidth={1.75} aria-hidden />Fast, and it works offline</p>
        <p className="ps-speed-text">Built for the keyboard, with a shortcut for everything you do daily. Lose signal and Quick Log keeps working; entries wait on the device and sync when you are back.</p>
      </div>
      <ul aria-label="Keyboard shortcuts">
        {keys.map(([combo, label]) => <li key={label}><span>{combo.map((k) => <kbd key={k}>{k}</kbd>)}</span>{label}</li>)}
      </ul>
    </div>
  );
}

function SiteNav() {
  return (
    <header className="ps-nav-wrap">
      <nav className="ps-nav" aria-label="Public navigation">
        <a href="/" className="ps-brand" aria-label="Vantage home"><img src="/brand/mark-reversed.svg" alt="" width="26" height="26" /><span>VANTAGE</span></a>
        <div className="ps-nav-links"><a href="/#product">Product</a><a href="/#roles">Who it is for</a><a href="/#analysts">For analysts</a><a href="/security">Security</a><a href="/#faq">FAQ</a></div>
        {/* On a phone the links fold into a menu; a <details> needs no script, so it works on the prerendered page too. */}
        <details className="ps-nav-menu">
          <summary aria-label="Menu"><Menu strokeWidth={1.75} aria-hidden /></summary>
          <div className="ps-nav-sheet">
            <a href="/#product">Product</a><a href="/#roles">Who it is for</a><a href="/#analysts">For analysts</a><a href="/#faq">FAQ</a><a href="/changes">What’s new</a>
            <span aria-hidden />
            <a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/accessibility">Accessibility</a>
          </div>
        </details>
        <a href="/login" className="ps-nav-cta">Sign in <ArrowRight strokeWidth={1.75} aria-hidden /></a>
      </nav>
    </header>
  );
}

function SiteFooter({ cta = true }: { cta?: boolean }) {
  return (
    <footer className="ps-footer">
      <div className="ps-container">
        {cta && (
          <div className="ps-footer-cta" data-reveal>
            <h2>Give good work<br />a lasting record.</h2>
            <PillLink href="/login" tone="dark">Enter Vantage</PillLink>
          </div>
        )}
        <div className="ps-footer-grid">
          <div className="ps-footer-brand">
            <span className="ps-brand"><img src="/brand/mark-reversed.svg" alt="" width="22" height="22" /><span>VANTAGE</span></span>
            <p>Performance · Productivity · Readiness</p>
          </div>
          <nav aria-label="Product">
            <p>Product</p>
            <a href="/#product">How it works</a><a href="/#roles">Who it is for</a><a href="/#analysts">For analysts</a><a href="/#experience">Try Quick Log</a><a href="/#faq">FAQ</a><a href="/changes">What’s new</a>
          </nav>
          <nav aria-label="Trust">
            <p>Trust</p>
            <a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/accessibility">Accessibility</a><a href="/security#report">Report a vulnerability</a>
          </nav>
          <nav aria-label="Account">
            <p>Account</p>
            <a href="/login">Sign in</a><a href="/login?help">Ask for help</a>
          </nav>
        </div>
        <div className="ps-footer-bottom">
          <p>{SITE.disclaimer}</p>
        </div>
      </div>
    </footer>
  );
}

function WorkflowDemo() {
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState(0);
  const sample = samples[selected];
  const stages = ['Capture', 'Record', 'Report'];
  return (
    <div className="ps-bezel ps-demo" aria-label="Interactive product demonstration">
      <div className="ps-bezel-core ps-demo-core">
        <div className="ps-demo-rail">
          <p className="ps-demo-label">Illustrative demo · sample data</p>
          <div className="ps-demo-stages" role="group" aria-label="Workflow stage">
            {stages.map((label, i) => <button key={label} type="button" aria-pressed={stage === i} onClick={() => setStage(i)}>{i === 0 ? <ListChecks strokeWidth={1.75} aria-hidden /> : i === 1 ? <Layers3 strokeWidth={1.75} aria-hidden /> : <FileText strokeWidth={1.75} aria-hidden />}{label}</button>)}
          </div>
          <p className="ps-demo-overline">My work</p>
          <div className="ps-demo-tasks" role="group" aria-label="Sample work">
            {samples.map((item, i) => (
              <button key={item.title} type="button" aria-pressed={selected === i} onClick={() => { setSelected(i); setStage(0); }}>
                <span><strong>{item.title}</strong><small>{item.category}</small></span><ChevronRight strokeWidth={1.75} aria-hidden />
              </button>
            ))}
          </div>
        </div>
        <div className="ps-demo-detail" aria-live="polite">
          <p className="ps-demo-status"><CheckCircle2 strokeWidth={1.75} aria-hidden />{stage === 0 ? 'Work recorded' : stage === 1 ? 'The record behind it' : 'Report input, for review'}</p>
          <p className="ps-demo-title">{sample.title}</p>
          <p className="ps-demo-count">{sample.count}</p>
          <div className="ps-demo-panel">
            {stage === 0 && <><p className="ps-demo-overline">Supporting evidence</p><p>{sample.evidence}</p><p className="ps-demo-muted">Kept with the entry, with the context around it.</p></>}
            {stage === 1 && <><p className="ps-demo-overline">What was done</p><p>{sample.detail}</p><p className="ps-demo-muted">Category: {sample.category} · Private until you share it</p></>}
            {stage === 2 && <><p className="ps-demo-overline">Draft for review</p><p>{sample.detail.replace(/\.$/, '')}, with the source cited so a reviewer can open it.</p><p className="ps-demo-muted">Sample text. Your work stays yours.</p></>}
          </div>
          <button type="button" className="ps-demo-next" onClick={() => setStage((stage + 1) % 3)}>
            {stage === 0 ? 'See the record' : stage === 1 ? 'Preview the report input' : 'Start again'}
            {stage === 2 ? <RotateCcw strokeWidth={1.75} aria-hidden /> : <ArrowRight strokeWidth={1.75} aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PublicSite() {
  const { pathname } = useLocation();
  const trust = trustPageFor(pathname);
  return trust ? <TrustSite key={trust.path} page={trust} /> : <Landing />;
}

/** A plain-language page (security, privacy, accessibility): the site's nav and footer around one document. */
function TrustSite({ page }: { page: TrustPage }) {
  useEffect(() => { document.title = page.title; }, [page.title]);
  return (
    <div className="public-site" data-theme="light">
      <a href="#ps-content" className="ps-skip">Skip to content</a>
      <main id="ps-main">
        <div className="ps-hero-band ps-doc-band">
          <div className="ps-hero-glow" aria-hidden />
          <SiteNav />
          <TrustHero page={page} />
        </div>
        <TrustBody page={page} />
      </main>
      <SiteFooter cta={false} />
    </div>
  );
}

function Landing() {
  const root = useRef<HTMLDivElement | null>(null);
  const film = videos.find((item) => item.id === 'ad') || videos.find((item) => item.id === 'tour');
  const [activeVideo, setActiveVideo] = useState(film?.id || 'tour');
  const video = videos.find((item) => item.id === activeVideo) || videos[0];
  const player = useRef<HTMLVideoElement | null>(null);
  const chosen = useRef(false);
  const choose = (id: string) => { chosen.current = true; setActiveVideo(id); };
  useEffect(() => { if (chosen.current) player.current?.play().catch(() => undefined); }, [activeVideo]);
  useReveal(root);
  // public.html already carries the page's head; this names the tab when the app shows the page instead.
  useEffect(() => { document.title = SITE.title; }, []);

  return (
    <div className="public-site" data-theme="light" ref={root}>
      <a href="#ps-content" className="ps-skip">Skip to content</a>

      <main id="ps-main">
      <div className="ps-hero-band">
        <div className="ps-hero-glow" aria-hidden />
        <SiteNav />

        <div id="ps-content" className="ps-container ps-hero">
          <div className="ps-hero-copy">
            <p className="ps-eyebrow ps-eyebrow-dark">Performance and work management for Marines</p>
            <h1>Every action.<br /><span>A clearer picture.</span></h1>
            <p className="ps-lede">Log what you did in one sentence. Vantage keeps it with its evidence, counts it once, and turns your record into JEPES or FITREP input where every line cites its source. Built for Marines and the teams they serve in.</p>
            <div className="ps-actions">
              <PillLink href="#product">Explore the product</PillLink>
              {film ? (
                <a className="ps-ghost ps-watch-cta" href="#watch" onClick={() => setActiveVideo(film.id)}>
                  <span className="ps-watch-dot" aria-hidden><Play strokeWidth={2} /></span>Watch the film<small>{film.length}</small>
                </a>
              ) : <a className="ps-ghost" href="#experience">Try Quick Log</a>}
            </div>
            <ul className="ps-proof" aria-label="At a glance">
              <li><WifiOff strokeWidth={1.75} aria-hidden />Self-hosted, no trackers</li>
              <li><Lock strokeWidth={1.75} aria-hidden />Private by default</li>
              <li><ScrollText strokeWidth={1.75} aria-hidden />Every line cites its entry</li>
            </ul>
          </div>
          <RecordMock />
        </div>
      </div>

      {video && (
        <section className="ps-section ps-container ps-watch" id="watch" aria-labelledby="ps-watch-title">
          <div className="ps-section-head" data-reveal>
            <p className="ps-eyebrow">{video.id === 'ad' || video.id === 'tour' ? 'The film' : 'Field guide'}</p>
            <h2 id="ps-watch-title">{video.title}</h2>
            <p className="ps-section-lede">Recorded on the real application with demo data. Every name and number on screen is made up.</p>
          </div>
          <div className="mission-video-layout ps-video" data-reveal>
            <div className="ps-bezel ps-player"><div className="ps-bezel-core">
              <video ref={player} key={video.id} controls playsInline preload="metadata" poster={video.poster} aria-label={video.title}>
                <source src={video.src} type="video/mp4" />
                {video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default={video.voiced === false} />}
              </video>
            </div></div>
            <div className="mission-video-list" aria-label="Choose a film">
              {videos.map((item) => (
                <button type="button" key={item.id} aria-pressed={item.id === video.id} onClick={() => choose(item.id)}>
                  {item.poster ? <img src={item.poster} alt="" loading="lazy" width="96" height="54" /> : <Play strokeWidth={1.75} aria-hidden />}
                  <span><strong>{item.title}</strong><small>{item.length}</small></span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="ps-section ps-container" id="product" aria-labelledby="ps-product-title">
        <div className="ps-section-head" data-reveal>
          <p className="ps-eyebrow">How it works</p>
          <h2 id="ps-product-title">See the work behind every number.</h2>
          <p className="ps-section-lede">A count on a slide is only as good as the record under it. Vantage keeps that record as the work happens, so the number, the person who earned it and the evidence stay attached.</p>
        </div>
        <div className="ps-bento">
          <article className="ps-tile ps-tile-wide" data-reveal>
            <div className="ps-tile-core">
              <p className="ps-tile-kicker"><ListChecks strokeWidth={1.75} aria-hidden />Capture</p>
              <h3>Say it once. Quick Log fills in the rest.</h3>
              <p>Write what you did the way you would say it. Quick Log reads the quantity, the dollar value and what kind of value it is, the system and the date, and you check them before anything is saved.</p>
              <div className="ps-sentence" aria-hidden>
                <p>Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday</p>
                <div><span>30 ULOs</span><span>$1,118.38 reconciled</span><span>DAI</span><span>yesterday</span></div>
              </div>
            </div>
          </article>
          <article className="ps-tile" data-reveal>
            <div className="ps-tile-core">
              <p className="ps-tile-kicker"><Layers3 strokeWidth={1.75} aria-hidden />Work</p>
              <h3>The sheet becomes a queue. Each row, a case.</h3>
              <p>Import the spreadsheet your section works from. The original is kept byte for byte; each row gets a holder, a stage, a procedure where one fits, and a history nobody can quietly edit.</p>
            </div>
          </article>
          <article className="ps-tile" data-reveal>
            <div className="ps-tile-core">
              <p className="ps-tile-kicker"><Users strokeWidth={1.75} aria-hidden />Credit</p>
              <h3>Holding work is not credit for it.</h3>
              <p>Your Record counts what you researched, submitted and verified, one document once however many entries it took. Hand a case on and both people keep exactly what each did.</p>
            </div>
          </article>
          <article className="ps-tile ps-tile-wide" data-reveal>
            <div className="ps-tile-core">
              <p className="ps-tile-kicker"><FileText strokeWidth={1.75} aria-hidden />Report</p>
              <h3>Report Studio writes from the record, not from memory.</h3>
              <p>JEPES and FITREP input assembled from entries you can open and check. Training, awards, goals and readiness sit beside them, so the period is described by what actually happened in it.</p>
              <div className="ps-report" aria-hidden>
                <p><b>Section 2 · Mission accomplishment</b></p>
                <p>Cleared 14 UMTs and 9 open commitments in the quarter; each verified on the following report<sup>1–23</sup>.</p>
                <small>23 sources · every figure links to its entry</small>
              </div>
            </div>
          </article>
        </div>
        <div className="ps-demo-wrap" data-reveal><WorkflowDemo /></div>
        <SpeedStrip />
      </section>

      <RoleStrip />

      <section className="ps-analysts" id="analysts" aria-labelledby="ps-analysts-title">
        <div className="ps-container ps-analysts-grid">
          <div className="ps-analysts-copy" data-reveal>
            <p className="ps-eyebrow ps-eyebrow-dark">For financial management analysts</p>
            <h2 id="ps-analysts-title">Balances read in the order the money moves.</h2>
            <p className="ps-section-lede ps-on-dark">Commitment, obligation, delivered, paid. Vantage reads a document’s figures in lifecycle order, names the open condition, and lets the case follow a versioned procedure: research first, the evidence each step needs, and a verified outcome before anything is called resolved.</p>
            <p className="ps-fineprint">The reference content behind it is training material, cited and labelled as such. Vantage never presents it as policy and never writes to a system of record.</p>
          </div>
          <ol className="ps-editorial" data-reveal>
            <li><span>01</span><div><h3>A diagnoser, not a guess</h3><p>Enter the four figures and see the condition, the causes worth ruling out, who can act, and what would prove the correction.</p></div></li>
            <li><span>02</span><div><h3>Procedures you can cite</h3><p>Each step names its source and the role that performs it. A case stays on the version it started under until somebody moves it, on the record.</p></div></li>
            <li><span>03</span><div><h3>Evidence before action</h3><p>A passed funds check before a modification is submitted; delivery evidenced before an award is changed. The gate is shown before it refuses.</p></div></li>
            <li><span>04</span><div><h3>A desk reference inside</h3><p>Purchase methods, normal and abnormal conditions, rejects and roles, cited to the source and kept apart from editorial notes.</p></div></li>
          </ol>
          <div className="ps-analysts-case" data-reveal><CaseMock /></div>
        </div>
      </section>

      <section className="ps-section ps-container ps-try" id="experience" aria-labelledby="ps-try-title">
        <div data-reveal>
          <p className="ps-eyebrow">Try it for yourself</p>
          <h2 id="ps-try-title">One sentence. The details, captured.</h2>
          <p className="ps-section-lede">This is the same Quick Log parser Vantage runs, working in your browser. Type what you did and watch it read the quantity, the value and the system.</p>
          <p className="ps-fineprint">No account needed. Nothing you type leaves this page.</p>
        </div>
        <div className="ps-bezel" data-reveal><div className="ps-bezel-core ps-parser"><LiveParser /></div></div>
      </section>

      <section className="ps-section ps-container" id="security" aria-labelledby="ps-security-title">
        <div className="ps-section-head" data-reveal>
          <p className="ps-eyebrow">Built to be answerable</p>
          <h2 id="ps-security-title">Nothing important happens quietly.</h2>
          <p className="ps-section-lede">A record about a person has to be able to answer for itself: who wrote it, who could see it, and whether anything changed since.</p>
        </div>
        <ul className="ps-assurance" data-reveal>
          <li><Fingerprint strokeWidth={1.5} aria-hidden /><h3>Sealed history</h3><p>Every entry on a case is chained and signed, and the day’s seals go into a hash-chained audit log. A changed, removed or inserted entry shows.</p></li>
          <li><Lock strokeWidth={1.5} aria-hidden /><h3>Private by default</h3><p>Your record is yours. Leaders see what you share, only for their own unit, and opening somebody’s detail is itself logged.</p></li>
          <li><Users strokeWidth={1.5} aria-hidden /><h3>Membership is the key</h3><p>Leave a unit and its work stops being yours to open: held cases go back to the queue, and your own history stays with you.</p></li>
          <li><ShieldCheck strokeWidth={1.5} aria-hidden /><h3>Sign-in that fits</h3><p>Passkeys, authenticator codes and CAC, with the sessions you are signed into shown and ended from one place.</p></li>
          <li><BookOpen strokeWidth={1.5} aria-hidden /><h3>Retention with holds</h3><p>Schedules state the authority they keep records under, and a legal hold stops every path that could delete what it covers.</p></li>
          <li><WifiOff strokeWidth={1.5} aria-hidden /><h3>No trackers, no egress needed</h3><p>No analytics, tag manager or advertising scripts. Vantage runs on a network with no public internet, on your own host.</p></li>
        </ul>
        <p className="ps-more" data-reveal><a href="/security">How Vantage is secured, for you and your ISSM <ArrowRight strokeWidth={1.75} aria-hidden /></a><a href="/privacy">What it keeps about you <ArrowRight strokeWidth={1.75} aria-hidden /></a></p>
      </section>

      <section className="ps-section ps-container ps-faq" id="faq" aria-labelledby="ps-faq-title">
        <div data-reveal><p className="ps-eyebrow">A few things to know</p><h2 id="ps-faq-title">Clear from the start.</h2></div>
        <div className="ps-faq-list" data-reveal>
          {FAQS.map(([q, a]) => <details key={q}><summary>{q}<ChevronRight strokeWidth={1.75} aria-hidden /></summary><p>{a}</p></details>)}
        </div>
      </section>
      </main>

      <SiteFooter />
    </div>
  );
}
