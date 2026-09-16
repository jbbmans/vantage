import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ChevronRight, FileText, Gauge, Layers3, ListTodo, Play, RotateCcw, ShieldCheck, Users } from 'lucide-react';
import { applySeo, applyPublicStructuredData } from '@/lib/seo';
import { publishedVideos } from '@/config/videos';
import LiveParser from '@/components/public/LiveParser';
import './PublicSite.css';

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


const samples = [
  { title: 'Conduct range brief', detail: 'Briefed 20 Marines on range procedures and safety responsibilities.', evidence: 'Range brief checklist', category: 'Leadership', count: '20 Marines briefed' },
  { title: 'Resolve funding discrepancy', detail: 'Reconciled 8 UMTs totaling $12,600 and documented the corrections.', evidence: 'Reconciliation worksheet', category: 'Fiscal & Financial', count: '8 UMTs reconciled' },
  { title: 'Train the next team', detail: 'Led 2 hours of reconciliation training for 4 junior Marines.', evidence: 'Training attendance record', category: 'Training', count: '4 Marines trained' },
];

const videos = publishedVideos().slice(0, 4);

function ProductDemo() {
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState(0);
  const sample = samples[selected];
  return <div className="mission-demo" id="product" aria-label="Interactive product demonstration">
    <div className="demo-label">Illustrative demo · sample data</div>
    <aside className="demo-sidebar" aria-label="Workflow stages">
      <div className="mission-brand"><img src="/brand/mark-reversed.svg" alt="" width="25" height="25" /><span>VANTAGE</span></div>
      {[['Capture', ListTodo], ['Record', Layers3], ['Report', FileText]].map(([label, Icon], i) => {
        const StageIcon = Icon as typeof ListTodo;
        return <button key={i} type="button" aria-pressed={stage === i} onClick={() => setStage(i)}><StageIcon aria-hidden />{label as string}</button>;
      })}
      <span className="demo-sidebar-note">One action.<br />A lasting record.</span>
    </aside>
    <div className="demo-workspace">
      <div className="demo-topbar"><span>Your work, with the context that matters.</span><span>Sample workspace</span></div>
      <div className="demo-columns">
        <div className="demo-tasks"><div className="demo-section-label"><h3>Today</h3><span>Explore a workflow</span></div>
          <p className="demo-overline">MY WORK</p>
          {samples.map((item, i) => <button key={item.title} type="button" aria-pressed={selected === i} onClick={() => { setSelected(i); setStage(0); }}><CheckCircle2 aria-hidden /><span><strong>{item.title}</strong><small>{item.category}</small></span><ChevronRight aria-hidden /></button>)}
          <p className="demo-footnote">Select a task. Follow it from action to report.</p>
        </div>
        <div className="demo-detail" aria-live="polite">
          <div className="demo-status"><CheckCircle2 aria-hidden />{stage === 0 ? 'Task completed' : stage === 1 ? 'Source record' : 'Report preview'}</div>
          <h3>{sample.title}</h3><p>{sample.count}</p>
          <div className="demo-evidence-heading">{stage === 2 ? 'DRAFT FOR REVIEW' : stage === 1 ? 'THE RECORD BEHIND THE RESULT' : 'SUPPORTING EVIDENCE'}</div>
          {stage === 0 ? <div className="demo-evidence"><img src="/brand/training-sample.webp" alt="Illustrative training scene generated for this sample" width="180" height="108" /><div><FileText aria-hidden /><strong>{sample.evidence}</strong><small>Illustrative attachment</small></div><div><ShieldCheck aria-hidden /><strong>Outcome notes</strong><small>Context preserved</small></div></div>
            : <div className="demo-record"><FileText aria-hidden /><p>{sample.detail}</p><small>{stage === 1 ? 'Category: ' + sample.category + ' · Visibility: private' : 'Source: ' + sample.evidence + '. Review the facts before sharing.'}</small></div>}
          <div className="demo-next"><FileText aria-hidden /><div><strong>{stage === 0 ? 'Keep the outcome in your record' : stage === 1 ? 'Turn this record into a report' : 'The evidence stays connected'}</strong><p>{stage === 2 ? 'This preview uses sample text. Your work stays yours.' : 'Follow the same information through the workflow.'}</p><button type="button" onClick={() => setStage((stage + 1) % 3)}>{stage === 0 ? 'View source record' : stage === 1 ? 'Preview report' : 'Replay workflow'}{stage === 2 ? <RotateCcw aria-hidden /> : <ArrowRight aria-hidden />}</button></div></div>
        </div>
      </div>
    </div>
  </div>;
}

export default function PublicSite() {
  const [activeVideo, setActiveVideo] = useState('tour');
  const video = videos.find((item) => item.id === activeVideo) || videos[0];
  useEffect(() => {
    applySeo({ title: 'VANTAGE USMC | Marine Performance & Work Management', description: 'VANTAGE helps Marines and operational teams track work, performance records, readiness and goals, then build reports from traceable evidence.', canonicalPath: '/', indexable: true });
    applyPublicStructuredData(faqs, videos.map((v) => ({ name: v.title, description: v.description, url: v.src, thumbnail: v.poster, uploadDate: v.published })));
  }, []);
  return <div className="mission-site">
    <a href="#mission-main" className="mission-skip">Skip to content</a>
    <div className="mission-dark">
      <header className="mission-nav mission-container">
        <Link to="/" className="mission-brand" aria-label="Vantage home"><img src="/brand/mark-reversed.svg" alt="" width="34" height="34" /><span>VANTAGE</span></Link>
        <nav aria-label="Public navigation"><a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="#about">About</a></nav>
        <Link to="/login" className="mission-signin">Sign in <ArrowRight aria-hidden /></Link>
      </header>
      <main id="mission-main" className="mission-container">
        <section className="mission-hero" aria-labelledby="vantage-hero-title">
          <p className="mission-eyebrow">A CLEARER VIEW OF YOUR WORK</p>
          <h1 id="vantage-hero-title">Every action.<br />A clearer picture.</h1>
          <p className="mission-subtitle">The performance and work management platform<br className="desktop-break" /> built for Marines and operational teams.</p>
          <div className="mission-actions"><a className="mission-button" href="#product">Explore the product <ArrowRight aria-hidden /></a><a className="mission-watch" href="#watch"><Play aria-hidden />Watch the overview</a></div>
        </section>
        <ProductDemo />
        <ol className="mission-steps" id="how-it-works"><li><span>1</span><div><h2>Capture</h2><p>Keep the work and its context in one place.</p></div></li><li><span>2</span><div><h2>Understand</h2><p>See the actions, outcomes, and evidence.</p></div></li><li><span>3</span><div><h2>Report</h2><p>Build useful outputs from the same records.</p></div></li></ol>
      </main>
    </div>
    <section className="mission-container mission-about" id="about">
      <p className="mission-eyebrow">BUILT FOR OPERATIONAL TEAMS</p>
      <div className="mission-about-grid"><h2>From everyday work<br />to evidence that<br /><em>matters.</em></h2><p>VANTAGE connects tasks, performance records, correspondence, and reports so the detail survives the day. When it is time to brief a leader or prepare an evaluation, the source material is already organized.</p></div>
      <div className="mission-benefits"><article><Layers3 aria-hidden /><div><h3>Keep work and evidence together</h3><p>Track actions, quantities, financial value, and follow-ups with the context behind them.</p></div></article><article><FileText aria-hidden /><div><h3>Turn progress into clear reports</h3><p>Prepare narratives and performance inputs from records you can inspect and review.</p></div></article></div>
      <div className="mission-trust"><span><ShieldCheck aria-hidden />Intentional sharing</span><span><Users aria-hidden />Individual and team views</span><span><Gauge aria-hidden />Action and outcome metrics</span></div>
    </section>
    <section className="mission-try" id="experience"><div className="mission-container mission-try-grid"><div><p className="mission-eyebrow">TRY IT FOR YOURSELF</p><h2>One sentence.<br />The details, captured.</h2><p>Describe what you did. The same parser used in VANTAGE identifies quantities, dates, and value for you to review.</p><small>Runs in your browser. No account needed. Nothing is saved.</small></div><LiveParser /></div></section>
    {video && <section className="mission-container mission-video" id="watch"><div className="mission-section-heading"><div><p className="mission-eyebrow">INSIDE VANTAGE</p><h2>See the workflow.</h2></div><p>Explore the current product walkthroughs.</p></div><div className="mission-video-layout"><video key={video.id} controls preload="none" poster={video.poster} aria-label={video.title}><source src={video.src} />{video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default />}</video><div className="mission-video-list">{videos.map((item) => <button type="button" key={item.id} aria-pressed={item.id === video.id} onClick={() => setActiveVideo(item.id)}><Play aria-hidden /><span><strong>{item.title}</strong><small>{item.length}</small></span></button>)}</div></div></section>}
    <section className="mission-container mission-faq" id="faq"><div><p className="mission-eyebrow">A FEW THINGS TO KNOW</p><h2>Clear from the start.</h2></div><div>{faqs.map(([q, a]) => <details key={q}><summary>{q}<ChevronRight aria-hidden /></summary><p>{a}</p></details>)}</div></section>
    <footer className="mission-footer"><div className="mission-container"><div className="mission-footer-top"><div><h2>Give good work<br />a lasting record.</h2><Link to="/login" className="mission-button">Enter VANTAGE <ArrowRight aria-hidden /></Link></div><div className="mission-brand"><img src="/brand/mark-reversed.svg" alt="" width="34" height="34" /><span>VANTAGE</span></div></div><div className="mission-footer-bottom"><p>Independent software project. Not an official Department of Defense or U.S. Marine Corps system of record.</p><a href="https://github.com/jbbmans/vantage">Project source <ArrowRight aria-hidden /></a></div></div></footer>
  </div>;
}
