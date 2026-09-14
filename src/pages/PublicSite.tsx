import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Gauge,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Workflow,
} from 'lucide-react';

const featureGroups = [
  {
    icon: Activity,
    title: 'Capture the work',
    text: 'Log actions, outcomes, values, correspondence, readiness events, training, and career milestones while the context is still fresh.',
    points: ['Fast structured capture', 'Files and spreadsheet-supported work', 'Traceable activity history'],
  },
  {
    icon: BarChart3,
    title: 'Turn activity into signal',
    text: 'Convert day-to-day work into action metrics, workload views, trends, goals, and command-level visibility without losing the record underneath.',
    points: ['Action-first dashboards', 'Outcome drill-downs', 'Unit and individual views'],
  },
  {
    icon: FileText,
    title: 'Build better outputs',
    text: 'Use the same verified source records to support reports, performance narratives, counseling, analysis, and recurring products.',
    points: ['Report studio', 'Revision-aware outputs', 'Source-linked analysis'],
  },
];

const workflows = [
  ['01', 'Capture', 'Record the work once, close to when it happened.'],
  ['02', 'Organize', 'Route it into work, goals, readiness, career, or reporting.'],
  ['03', 'Understand', 'See what moved, what is blocked, and where effort is going.'],
  ['04', 'Act', 'Turn the record into decisions, follow-up, and defensible outputs.'],
];

const faqs = [
  ['What is Vantage?', 'Vantage is a self-hosted performance, productivity, readiness, and work-management platform designed to turn operational activity into clear, traceable records and decision-ready views.'],
  ['Is Vantage an official Marine Corps system?', 'No. Vantage is an independent software project and is not an official Department of Defense or Marine Corps system of record.'],
  ['What can teams track?', 'Teams can track work actions, outcomes, financial or configurable value metrics, projects, spreadsheet-driven queues, goals, correspondence, readiness dates, training, awards, reports, and related activity.'],
  ['How does Vantage handle accountability?', 'The product is built around traceability: actions stay connected to source records, shared views are permission-aware, and important outputs can be traced back to the facts used to create them.'],
  ['Can Vantage support different units or teams?', 'Yes. The product supports unit structures, memberships, role-aware visibility, team dashboards, configurable metrics, and deployment-level administration.'],
];

function setMeta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

export default function PublicSite() {
  useEffect(() => {
    document.title = 'Vantage | Performance, Productivity & Readiness Software';
    setMeta('description', 'Vantage is a self-hosted performance, productivity, readiness, work tracking, reporting, and team decision-support platform built for operational teams.');
    setMeta('robots', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      }
    }, { threshold: 0.14, rootMargin: '0px 0px -40px' });
    document.querySelectorAll('[data-reveal]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="public-site">
      <header className="public-nav">
        <Link to="/" className="public-brand" aria-label="Vantage home">
          <img src="/mark.svg" alt="" width={34} height={34} />
          <span>VANTAGE</span>
        </Link>
        <nav className="public-nav-links" aria-label="Public navigation">
          <a href="#platform">Platform</a>
          <a href="#workflow">Workflow</a>
          <a href="#security">Trust</a>
          <a href="#faq">FAQ</a>
        </nav>
        <Link to="/login" className="public-signin">Sign in <ArrowRight aria-hidden /></Link>
      </header>

      <main>
        <section className="public-hero" aria-labelledby="vantage-hero-title">
          <div className="hero-grid" aria-hidden />
          <div className="hero-orbit hero-orbit-one" aria-hidden />
          <div className="hero-orbit hero-orbit-two" aria-hidden />
          <div className="hero-copy" data-reveal>
            <p className="public-kicker"><span /> Performance · Productivity · Readiness</p>
            <h1 id="vantage-hero-title">Turn operational work into <em>clear advantage.</em></h1>
            <p className="hero-lede">Vantage gives people and teams one place to capture work, understand performance, manage readiness, and turn verified records into decisions and outputs that hold up.</p>
            <div className="hero-actions">
              <Link to="/login" className="public-button public-button-primary">Open Vantage <ArrowRight aria-hidden /></Link>
              <a href="#platform" className="public-button public-button-secondary">Explore the platform <ChevronRight aria-hidden /></a>
            </div>
            <div className="hero-proof" aria-label="Product principles">
              <span><CheckCircle2 aria-hidden /> Action-first metrics</span>
              <span><CheckCircle2 aria-hidden /> Traceable records</span>
              <span><CheckCircle2 aria-hidden /> Self-hosted deployment</span>
            </div>
          </div>

          <div className="hero-product" data-reveal aria-label="Vantage product preview">
            <div className="product-glow" aria-hidden />
            <div className="preview-window">
              <div className="preview-rail">
                <div className="preview-mini-brand"><img src="/brand/mark-reversed.svg" alt="" /><span>VANTAGE</span></div>
                <div className="preview-nav-item active"><Gauge /> Today</div>
                <div className="preview-nav-item"><Activity /> Records</div>
                <div className="preview-nav-item"><Workflow /> Work</div>
                <div className="preview-nav-item"><Target /> Goals</div>
                <div className="preview-nav-item"><Users /> Team</div>
              </div>
              <div className="preview-main">
                <div className="preview-topline"><span>Today / Your next move</span><i>JB</i></div>
                <div className="preview-heading"><div><small>COMMAND VIEW</small><strong>Operational picture</strong></div><button>+ Log activity</button></div>
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
            <div className="float-card float-card-top"><Sparkles /><span><b>Vantage Assist</b><small>Draft from verified records</small></span></div>
            <div className="float-card float-card-bottom"><ShieldCheck /><span><b>Source traceable</b><small>Every figure has a record</small></span></div>
          </div>
        </section>

        <section className="public-marquee" aria-label="Vantage capabilities">
          <div>WORK MANAGEMENT <span>•</span> PERFORMANCE RECORDS <span>•</span> READINESS <span>•</span> REPORTING <span>•</span> GOALS <span>•</span> CORRESPONDENCE <span>•</span> TEAM VISIBILITY <span>•</span> AI-ASSISTED WORKFLOWS</div>
        </section>

        <section className="public-section" id="platform">
          <div className="section-intro" data-reveal>
            <p className="public-kicker"><span /> One operating picture</p>
            <h2>Less time reconstructing work. More time acting on it.</h2>
            <p>Vantage connects the things teams already do—work, records, goals, correspondence, readiness, reports—so activity becomes useful evidence instead of disappearing into inboxes and spreadsheets.</p>
          </div>
          <div className="feature-grid">
            {featureGroups.map((feature, index) => (
              <article key={feature.title} className="feature-card" data-reveal style={{ '--delay': `${index * 90}ms` } as React.CSSProperties}>
                <div className="feature-icon"><feature.icon /></div>
                <span className="feature-number">0{index + 1}</span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
                <ul>{feature.points.map((point) => <li key={point}><CheckCircle2 />{point}</li>)}</ul>
              </article>
            ))}
          </div>
        </section>

        <section className="public-section public-workflow" id="workflow">
          <div className="workflow-visual" data-reveal>
            <div className="workflow-ring ring-one" aria-hidden />
            <div className="workflow-ring ring-two" aria-hidden />
            <div className="workflow-core"><img src="/mark.svg" alt="" /><span>ONE RECORD</span><strong>MANY USES</strong></div>
            <div className="workflow-node node-a"><FileSpreadsheet /><span>Work</span></div>
            <div className="workflow-node node-b"><Target /><span>Goals</span></div>
            <div className="workflow-node node-c"><Users /><span>Teams</span></div>
            <div className="workflow-node node-d"><FileText /><span>Reports</span></div>
          </div>
          <div className="workflow-copy" data-reveal>
            <p className="public-kicker"><span /> From event to evidence</p>
            <h2>A workflow built around the facts.</h2>
            <p className="workflow-lede">The record comes first. Dashboards, goals, reports, and analysis are different views of the same underlying work.</p>
            <div className="workflow-steps">
              {workflows.map(([num, title, text]) => <div key={num}><b>{num}</b><span><strong>{title}</strong><small>{text}</small></span></div>)}
            </div>
          </div>
        </section>

        <section className="public-dark" id="security">
          <div className="public-dark-inner">
            <div className="dark-copy" data-reveal>
              <p className="public-kicker light"><span /> Built for accountable work</p>
              <h2>Trust the output because you can inspect the path to it.</h2>
              <p>Vantage is designed to keep visibility intentional and the underlying record inspectable. That means role-aware access, traceable outputs, deployment-level controls, and security features built into the workflow rather than bolted on at the end.</p>
              <Link to="/login" className="public-button public-button-light">Enter Vantage <ArrowRight /></Link>
            </div>
            <div className="trust-grid" data-reveal>
              <article><LockKeyhole /><h3>Controlled access</h3><p>Role and membership-aware access with secure sign-in options.</p></article>
              <article><ShieldCheck /><h3>Traceable activity</h3><p>Keep important actions and outputs connected to their source records.</p></article>
              <article><Workflow /><h3>Deployment control</h3><p>Self-hosted architecture with owner-level configuration and governance tools.</p></article>
              <article><Sparkles /><h3>AI in context</h3><p>Assist where work happens instead of forcing users into a separate AI destination.</p></article>
            </div>
          </div>
        </section>

        <section className="public-section public-metrics">
          <div data-reveal><strong>1</strong><span>connected workspace for work, records, readiness, and reporting</span></div>
          <div data-reveal><strong>0</strong><span>need to rebuild the same accomplishment from scratch for every output</span></div>
          <div data-reveal><strong>100%</strong><span>focus on action metrics over meaningless entry counts</span></div>
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

        <section className="public-cta" data-reveal>
          <div className="cta-mark"><img src="/brand/mark-reversed.svg" alt="" /></div>
          <p className="public-kicker light"><span /> Higher insight. Greater impact.</p>
          <h2>See the work. Understand the signal. Move the mission forward.</h2>
          <p>Vantage turns scattered activity into a shared operational picture without losing the record underneath it.</p>
          <Link to="/login" className="public-button public-button-light">Sign in to Vantage <ArrowRight /></Link>
        </section>
      </main>

      <footer className="public-footer">
        <div className="public-brand"><img src="/mark.svg" alt="" width={30} height={30} /><span>VANTAGE</span></div>
        <p>Performance · Productivity · Readiness</p>
        <p className="public-disclaimer">Independent software project. Not an official Department of Defense or U.S. Marine Corps system of record.</p>
      </footer>
    </div>
  );
}
