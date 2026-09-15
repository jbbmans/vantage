import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { applySeo, applyPublicStructuredData } from '@/lib/seo';
import { publishedVideos } from '@/config/videos';
import LiveParser from '@/components/public/LiveParser';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Gauge,
  Layers3,
  LockKeyhole,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Workflow,
} from 'lucide-react';

const featureGroups = [
  {
    icon: Activity,
    eyebrow: 'Performance records',
    title: 'Capture the work while it is happening.',
    text: 'Log actions, outcomes, quantities, value moved, correspondence, training, readiness events, and career milestones before the detail disappears.',
    points: ['Fast structured capture', 'Action and outcome metrics', 'Traceable source history'],
  },
  {
    icon: FileSpreadsheet,
    eyebrow: 'Work management',
    title: 'Turn spreadsheets and queues into accountable work.',
    text: 'Import operational work, create tasks from rows, let people claim what they own, and preserve who changed what from intake through completion.',
    points: ['Spreadsheet-driven queues', 'Claimable tasks and ownership', 'Files attached to the work'],
  },
  {
    icon: BarChart3,
    eyebrow: 'Operational visibility',
    title: 'See effort, output, and readiness in one picture.',
    text: 'Use the same source records to build individual and team dashboards, measure outcomes, identify blockers, and see where attention is needed.',
    points: ['Action-first dashboards', 'Outcome drill-downs', 'Individual and unit views'],
  },
  {
    icon: FileText,
    eyebrow: 'Reporting',
    title: 'Build the output from facts you can inspect.',
    text: 'Create report drafts, performance narratives, counseling support, analysis, and recurring products without rebuilding the story from scratch.',
    points: ['Source-linked report studio', 'Revision-aware outputs', 'Exportable working products'],
  },
  {
    icon: Mail,
    eyebrow: 'Correspondence',
    title: 'Keep the conversation attached to the work.',
    text: 'Track outreach, replies, follow-ups, KSDs, resolutions, and related records so email activity becomes part of the operational picture.',
    points: ['Thread and contact tracking', 'Follow-up visibility', 'Work-item linking'],
  },
  {
    icon: Sparkles,
    eyebrow: 'Vantage Assist',
    title: 'Put AI inside the workflow, not on another page.',
    text: 'Use AI where it is useful: structuring a quick log, drafting from verified records, summarizing work, and accelerating analysis while keeping the source material visible.',
    points: ['Generate using Vantage', 'Record-aware drafting', 'Human review stays in control'],
  },
];

const audiences = [
  {
    label: 'Individual',
    icon: Activity,
    title: 'Know what you have actually done.',
    text: 'Build a living record of work, outcomes, training, readiness, goals, and accomplishments instead of reconstructing months of activity at evaluation time.',
  },
  {
    label: 'Leader',
    icon: Users,
    title: 'See workload without micromanaging it.',
    text: 'Understand team activity, blockers, workload, readiness, and measurable outcomes while keeping visibility role-aware and source-linked.',
  },
  {
    label: 'Command',
    icon: Gauge,
    title: 'Get a real operating picture.',
    text: 'Move from raw entries to trends, action metrics, workload signals, goal progress, and defensible reporting at the level decisions are made.',
  },
  {
    label: 'Owner',
    icon: Layers3,
    title: 'Configure the deployment, not the codebase.',
    text: 'Manage units, metrics, permissions, roles, product settings, governance, security options, and deployment behavior from the owner experience.',
  },
];

const faqs = [
  ['What is Vantage?', 'Vantage is a self-hosted performance, productivity, readiness, work-management, reporting, and decision-support platform designed to turn day-to-day operational activity into clear, traceable records and useful views.'],
  ['Who is Vantage for?', 'Vantage is designed around individual contributors, NCOs and team leaders, staff sections, command teams, and deployment owners who need one connected picture of work, performance, readiness, and reporting.'],
  ['Is Vantage an official Marine Corps system?', 'No. Vantage is an independent software project and is not an official Department of Defense or U.S. Marine Corps system of record. It is designed to complement approved processes, not replace authoritative systems.'],
  ['What can teams track?', 'Teams can track work actions, outcomes, configurable value metrics, projects, spreadsheet-driven queues, goals, correspondence, readiness dates, training, awards, report drafts, and related activity.'],
  ['Can it support Marine Corps performance documentation?', 'Vantage can organize source records and draft material that may help users prepare performance inputs such as JEPES or FITREP-related narratives. Official submissions still belong in the authoritative systems and processes.'],
  ['How does Vantage handle accountability?', 'The product is built around traceability. Actions stay connected to source records, visibility is permission-aware, important changes are attributable, and outputs can be traced back to the facts used to create them.'],
  ['Does Vantage use AI?', 'Yes, when enabled by the deployment owner. AI is woven into relevant workflows rather than isolated in a separate destination, and generated material remains something a person must review.'],
  // `as const` so each entry stays a [question, answer] pair. The FAQ schema is generated from this
  // exact array, so a malformed row would become malformed structured data.
] as const satisfies ReadonlyArray<readonly [string, string]>;

export default function PublicSite() {
  useEffect(() => {
    /*
     * `/`, `/display` and `/about` all render this page. They share one canonical so the three URLs
     * consolidate into a single ranking instead of competing with each other for the same query.
     */
    applySeo({
      title: 'Vantage | Performance, Productivity & Readiness Software',
      description: 'A self-hosted platform for performance records, work management, readiness tracking, goals and reporting — with every figure traceable to the record behind it.',
      canonicalPath: '/',
      indexable: true,
    });
    applyPublicStructuredData(faqs, publishedVideos().map((v) => ({
      name: v.title, description: v.description, url: v.src, thumbnail: v.poster, uploadDate: v.published,
    })));

    /*
     * Scroll reveal that can never leave the page blank.
     *
     * Everything is visible in the stylesheet by default. Here we hide only the elements that were
     * already below the fold when the page loaded, and only if this browser actually has an
     * observer to put them back. Whatever is on screen at load is never touched, so the first
     * frame — the one a screenshot, a social card and a crawler get — is always complete.
     */
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!('IntersectionObserver' in window)) return;

    const belowFold = els.filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    belowFold.forEach((el) => el.classList.add('reveal-armed'));

    const reveal = (el: Element) => el.classList.add('is-visible');
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) reveal(entry.target);
    }, { threshold: 0.12, rootMargin: '0px 0px -50px' });
    belowFold.forEach((el) => observer.observe(el));

    // Last line of defence. A renderer that never scrolls — a crawler, a screenshot service, a
    // headless preview — would otherwise sit on hidden content forever. After this the page is
    // whole no matter what the observer did or did not do.
    const failsafe = window.setTimeout(() => belowFold.forEach(reveal), 2500);

    return () => { observer.disconnect(); window.clearTimeout(failsafe); };
  }, []);

  return (
    <div className="public-site showcase-site">
      <header className="public-nav showcase-nav">
        <Link to="/" className="public-brand" aria-label="Vantage home">
          <img src="/mark.svg" alt="" width={34} height={34} />
          <span>VANTAGE</span>
        </Link>
        <nav className="public-nav-links" aria-label="Public navigation">
          <a href="#why">Why Vantage</a>
          <a href="#platform">Platform</a>
          <a href="#experience">Experience</a>
          <a href="#security">Trust</a>
          <a href="#watch">Watch</a>
          <a href="#faq">FAQ</a>
        </nav>
        <Link to="/login" className="public-signin">Sign in <ArrowRight aria-hidden /></Link>
      </header>

      <main>
        <section className="public-hero showcase-hero" aria-labelledby="vantage-hero-title">
          <div className="hero-grid" aria-hidden />
          <div className="showcase-halo halo-one" aria-hidden />
          <div className="showcase-halo halo-two" aria-hidden />

          <div className="hero-copy showcase-hero-copy" data-reveal>
            <div className="showcase-pill"><span className="showcase-pulse" /> Built for operational teams</div>
            <p className="public-kicker"><span /> Performance · Productivity · Readiness</p>
            <h1 id="vantage-hero-title">See the work.<br /><em>Prove the impact.</em></h1>
            <p className="hero-lede">Vantage is a connected operating workspace for the work people do every day—performance records, tasks, readiness, goals, correspondence, reports, team visibility, and AI-assisted workflows.</p>
            <p className="showcase-hero-note">Capture once. Use everywhere. Keep the source underneath every number, narrative, and decision.</p>
            <div className="hero-actions">
              <a href="#platform" className="public-button public-button-primary">See what Vantage does <ArrowRight aria-hidden /></a>
              <Link to="/login" className="public-button public-button-secondary">Open the tool <ChevronRight aria-hidden /></Link>
            </div>
            <div className="hero-proof" aria-label="Product principles">
              <span><CheckCircle2 aria-hidden /> Action-first metrics</span>
              <span><CheckCircle2 aria-hidden /> Source-linked records</span>
              <span><CheckCircle2 aria-hidden /> Self-hosted architecture</span>
            </div>
          </div>

          <div className="hero-product showcase-product" data-reveal aria-label="Vantage dashboard product preview">
            <div className="product-glow" aria-hidden />
            <div className="showcase-browser">
              <div className="showcase-browser-bar">
                <div className="browser-dots"><i /><i /><i /></div>
                <span>Vantage · Today</span>
                <div className="browser-search"><Search /> Search Vantage</div>
              </div>
              <div className="preview-window showcase-window">
                <div className="preview-rail">
                  <div className="preview-mini-brand"><img src="/brand/mark-reversed.svg" alt="" /><span>VANTAGE</span></div>
                  <div className="preview-nav-item active"><Gauge /> Today</div>
                  <div className="preview-nav-item"><Activity /> Records</div>
                  <div className="preview-nav-item"><Workflow /> Work</div>
                  <div className="preview-nav-item"><Target /> Goals</div>
                  <div className="preview-nav-item"><Users /> Team</div>
                  <div className="preview-nav-item"><FileText /> Reports</div>
                </div>
                <div className="preview-main">
                  <div className="preview-topline"><span>Command Element / G-8</span><i>JB</i></div>
                  {/* The mockup is a picture of the product, not the product. This was a real <button> with no
                      handler: focusable, pressable, and silent when pressed, which reads as a broken page
                      rather than as an illustration. It is presentational now and out of the tab order. */}
                  <div className="preview-heading"><div><small>OPERATIONAL PICTURE</small><strong>Good afternoon.</strong></div><span className="preview-fauxbutton" aria-hidden>+ Log activity</span></div>
                  <div className="preview-stats">
                    <div><small>Actions completed</small><strong>148</strong><span>+18 this week</span></div>
                    <div><small>Value moved</small><strong>$1.84M</strong><span>12 active items</span></div>
                    <div><small>Readiness</small><strong>94%</strong><span>3 need attention</span></div>
                  </div>
                  <div className="preview-panels">
                    <div className="preview-chart">
                      <div className="preview-panel-title">Work velocity <span>Last 8 weeks</span></div>
                      <div className="bars" aria-hidden>{[46, 62, 58, 74, 69, 82, 76, 94].map((h, i) => <b key={i} style={{ height: `${h}%` }} />)}</div>
                    </div>
                    <div className="preview-feed">
                      <div className="preview-panel-title">Needs attention <span>4 items</span></div>
                      <p><i className="dot teal" /> Funding action awaiting response <small>2h</small></p>
                      <p><i className="dot blue" /> Readiness item due this week <small>1d</small></p>
                      <p><i className="dot navy" /> Report revision ready for review <small>1d</small></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="float-card float-card-top"><Sparkles /><span><b>Generate using Vantage</b><small>Draft from verified records</small></span></div>
            <div className="float-card float-card-bottom"><ShieldCheck /><span><b>Source traceable</b><small>Open the record behind the figure</small></span></div>
          </div>
        </section>

        <section className="showcase-proof-band" aria-label="Vantage capability summary">
          <span>WORK</span><i>→</i><span>RECORDS</span><i>→</i><span>METRICS</span><i>→</i><span>REPORTS</span><i>→</i><span>DECISIONS</span>
        </section>

        <section className="public-section showcase-problem" id="why">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> Why Vantage exists</p>
            <h2>Important work should not disappear into spreadsheets, inboxes, and memory.</h2>
            <p>Most teams already have the data. The problem is that the work is scattered across email, trackers, notes, recurring reports, and people’s heads. Vantage connects that activity into one record that can actually be used.</p>
          </div>
          <div className="problem-grid" data-reveal>
            <article><span>01</span><h3>Work gets done.</h3><p>Tasks move, dollars change, cases close, people train, readiness changes, correspondence happens.</p></article>
            <article><span>02</span><h3>The context gets lost.</h3><p>Weeks later, the team is reconstructing who did what, why it mattered, and what evidence still exists.</p></article>
            <article className="problem-answer"><span>03</span><h3>Vantage keeps the record alive.</h3><p>The same source record feeds dashboards, goals, reporting, performance documentation, team visibility, and follow-up.</p></article>
          </div>
        </section>

        <section className="public-section showcase-platform" id="platform">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> The platform</p>
            <h2>Not another tracker. A connected operating picture.</h2>
            <p>Vantage is designed around the lifecycle of real work: capture it, assign it, measure it, understand it, and turn it into something useful without creating the same information five times.</p>
          </div>
          <div className="showcase-bento">
            {featureGroups.map((feature, index) => (
              <article key={feature.title} className={`showcase-feature feature-${index + 1}`} data-reveal style={{ '--delay': `${index * 70}ms` } as React.CSSProperties}>
                <div className="feature-icon"><feature.icon /></div>
                <p className="showcase-feature-eyebrow">{feature.eyebrow}</p>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
                <ul>{feature.points.map((point) => <li key={point}><CheckCircle2 />{point}</li>)}</ul>
              </article>
            ))}
          </div>
        </section>

        {/*
          This was three hand-built mockups of Quick Log, the workbench and Report Studio. Recorded
          walkthroughs of the real product do that job better and more honestly, so the drawings are
          gone and the recordings took the anchor. Two things earn their place here instead: the
          videos, and one thing a visitor can actually operate.
        */}
        <section className="public-section showcase-experience" id="experience">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> The experience</p>
            <h2>Type a sentence. Watch it become a record.</h2>
            <p>This is the parser the product runs, not a demonstration of one. Whatever you write is read here in your browser — nothing is sent anywhere, and nothing is kept.</p>
          </div>
          <div data-reveal>
            <LiveParser />
          </div>
        </section>

        <section className="showcase-audience-band">
          <div className="public-section audience-inner">
            <div className="section-intro" data-reveal>
              <p className="public-kicker light"><span /> Different views. Same truth.</p>
              <h2>Useful at the individual level. More powerful as the picture expands.</h2>
            </div>
            <div className="audience-grid">
              {audiences.map((audience, index) => <article key={audience.label} data-reveal style={{ '--delay': `${index * 75}ms` } as React.CSSProperties}><audience.icon /><span>{audience.label}</span><h3>{audience.title}</h3><p>{audience.text}</p></article>)}
            </div>
          </div>
        </section>

        <section className="public-dark" id="security">
          <div className="public-dark-inner">
            <div className="dark-copy" data-reveal>
              <p className="public-kicker light"><span /> Built for accountable work</p>
              <h2>Trust the output because you can inspect the path to it.</h2>
              <p>Vantage is designed to keep visibility intentional and the underlying record inspectable. Role-aware access, attributable changes, source-linked outputs, deployment-level controls, passkeys, MFA, and governance features are part of the product—not an afterthought.</p>
              <Link to="/login" className="public-button public-button-light">Enter Vantage <ArrowRight /></Link>
            </div>
            <div className="trust-grid" data-reveal>
              <article><LockKeyhole /><h3>Controlled access</h3><p>Role and membership-aware visibility with secure authentication options.</p></article>
              <article><ShieldCheck /><h3>Traceable activity</h3><p>Important actions and outputs stay connected to the records that support them.</p></article>
              <article><Workflow /><h3>Deployment control</h3><p>Self-hosted architecture with owner-level configuration, governance, and retention controls.</p></article>
              <article><Bell /><h3>Operational awareness</h3><p>Notifications, follow-ups, readiness dates, and work queues keep attention on what matters next.</p></article>
            </div>
          </div>
        </section>

        <section className="public-section video-section" id="watch">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> Watch</p>
            <h2>See it work before you commit to it.</h2>
            <p>Short walkthroughs of the parts people ask about most. The full library, including the
              deployment and governance walkthroughs, sits inside the product under the field guide.</p>
          </div>
          <div className="video-grid" data-reveal>
            {publishedVideos().slice(0, 4).map((slot) => (
              <figure key={slot.id} className="video-card">
                {/* Only recorded walkthroughs reach this grid, so there is no empty state to
                    render. The unrecorded slots still appear in the field guide, where saying
                    "not yet" is useful; on a landing page it is just an apology. */}
                <div className="video-frame">
                  <video controls preload="none" poster={slot.poster} aria-labelledby={`pv-${slot.id}`}>
                    <source src={slot.src} />
                    {slot.captions && <track kind="captions" src={slot.captions} srcLang="en" label="English" default />}
                  </video>
                </div>
                <figcaption>
                  <h3 id={`pv-${slot.id}`}>{slot.title}</h3>
                  <p>{slot.description}</p>
                  <small>{slot.length}</small>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="public-section faq-section" id="faq">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> Questions</p>
            <h2>What people should know about Vantage.</h2>
          </div>
          <div className="faq-list" data-reveal>
            {faqs.map(([q, a]) => <details key={q}><summary>{q}<ChevronRight /></summary><p>{a}</p></details>)}
          </div>
        </section>

        <section className="public-cta showcase-cta" data-reveal>
          <div className="cta-mark"><img src="/brand/mark-reversed.svg" alt="" /></div>
          <p className="public-kicker light"><span /> Higher insight. Greater impact.</p>
          <h2>Make the work visible before somebody has to ask where it went.</h2>
          <p>Vantage turns scattered operational activity into a living record, a clearer team picture, and better outputs—without making people maintain the same information in five different places.</p>
          <div className="showcase-cta-actions">
            <Link to="/login" className="public-button public-button-light">Sign in to Vantage <ArrowRight /></Link>
            <a href="#platform" className="public-button showcase-dark-outline">Explore the platform <ChevronRight /></a>
          </div>
        </section>
      </main>

      <footer className="public-footer showcase-footer">
        <div className="public-brand"><img src="/mark.svg" alt="" width={30} height={30} /><span>VANTAGE</span></div>
        <p>Performance · Productivity · Readiness</p>
        <p className="public-disclaimer">Independent software project. Not an official Department of Defense or U.S. Marine Corps system of record.</p>
      </footer>
    </div>
  );
}
