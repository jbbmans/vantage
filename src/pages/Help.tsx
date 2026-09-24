import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Search, X } from 'lucide-react';
import { PageHeader, Panel, Kbd, Input, Button, EmptyState } from '@/components/ui/primitives';
import { EVAL_REFERENCES, EVAL_VERIFIED } from '../../shared/evalRefs';
import { dollarSumRule } from '../../shared/constants';
import { useMetrics } from '@/lib/queries';
import { VERSION } from '@/lib/version';
import { HELP, searchHelp, type Answer } from '@/config/help';
import { TOPIC_LABELS, VIDEOS, videosByTopic, type VideoSlot } from '@/config/videos';
import VideoSlotCard from '@/components/VideoSlot';
import { useParam } from '@/components/common';
import { cn } from '@/lib/utils';

const SHORTCUTS: Array<[string, string]> = [
  ['N', 'Log an activity from anywhere'],
  ['⌘K or /', 'Search and jump'],
  ['G then D / R / W / G / C / J / P / T / M / S', 'Go to a page'],
  ['?', 'The shortcut list'],
  ['⌘↵', 'Save the open form'],
  ['Esc', 'Close a dialog'],
];

function QA({ entry, highlight }: { entry: Answer; highlight?: boolean }) {
  return (
    <details id={`q-${entry.id}`} className={cn('group border-b border-line last:border-0', highlight && 'bg-accent-soft/40')}>
      <summary className="tap flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-md font-medium text-ink hover:bg-surface-2">
        {entry.q}
        <span aria-hidden className="shrink-0 text-ink-3 transition-transform group-open:rotate-45">+</span>
      </summary>
      <div className="space-y-2 px-4 pb-4 text-sm leading-relaxed text-ink-2">
        {entry.a.map((p) => <p key={p}>{p}</p>)}
      </div>
    </details>
  );
}

export default function Help() {
  const cfg = useMetrics();
  const [q, setQ] = useParam('q');
  const [query, setQuery] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  useEffect(() => { const t = setTimeout(() => setQ(query), 250); return () => clearTimeout(t); }, [query, setQ]);

  // A deep link like /help#q-who-can-see should open the answer it names, not just scroll near it.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ block: 'start' });
  }, []);

  const unrecorded = VIDEOS.filter((v) => !v.src).length;

  return (
    <div className="page max-w-5xl">
      <PageHeader
        eyebrow="Field guide"
        title="How Vantage works"
        lede="Every question people ask, answered against how this build actually behaves."
      >
        <Button variant="ghost" onClick={() => searchRef.current?.focus()}><Search className="h-4 w-4" />Search</Button>
      </PageHeader>

      <div className="card mb-4 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            ref={searchRef}
            className="pl-9 pr-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the guide — try “who can see my records”, “passkey”, “retention”"
            aria-label="Search the field guide"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {searching ? (
        <Panel title={`${results.length} ${results.length === 1 ? 'answer' : 'answers'} for “${query.trim()}”`} bodyClassName="p-0">
          {results.length === 0
            ? <div className="p-4"><EmptyState title="Nothing matches that" description="Try a word somebody would say out loud — “share”, “delete”, “CAC”, “how many people”." /></div>
            : <div>{results.map((entry) => <QA key={entry.id} entry={entry} highlight />)}</div>}
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel title="The idea">
            <div className="prose-tight space-y-2 text-sm leading-relaxed text-ink-2">
              <p>Every evaluation you will ever get is written from whatever is in front of the writer at the time. Vantage keeps the evidence: dated, quantified accomplishments with an outcome. When a JEPES or FITREP comes due, <Link to="/reports" className="link">Reports</Link> turns them into a narrative and a bullet package, and a PDF you can hand over.</p>
              <p>Write entries the way you would say them out loud: <em>“Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday.”</em> Press <Kbd>N</Kbd> anywhere and Vantage pulls out the date, the quantity, the dollars, and a likely evaluation area. You confirm and save. On a phone with no signal, entries queue and sync later.</p>
              <p><strong className="text-ink">{cfg.currency_label}, typed.</strong> {dollarSumRule(cfg)}</p>
            </div>
          </Panel>

          {HELP.map((section) => {
            const videos = videosByTopic(section.topic);
            return (
              <div key={section.id} id={section.id}>
                <Panel title={section.title} subtitle={section.lede} bodyClassName="p-0">
                  <div>{section.answers.map((entry) => <QA key={entry.id} entry={entry} />)}</div>
                </Panel>
                {videos.length > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {videos.map((slot: VideoSlot) => <VideoSlotCard key={slot.id} slot={slot} />)}
                  </div>
                )}
              </div>
            );
          })}

          <Panel title="Keyboard" subtitle="Everything here works from any screen.">
            <dl className="grid gap-2 sm:grid-cols-2">
              {SHORTCUTS.map(([key, what]) => (
                <div key={key} className="flex items-baseline gap-3">
                  <dt className="shrink-0"><Kbd>{key}</Kbd></dt>
                  <dd className="text-sm text-ink-2">{what}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel
            title="Walkthroughs"
            subtitle={unrecorded === VIDEOS.length
              ? `${VIDEOS.length} walkthroughs are planned and none are recorded yet. The slots below say what each one will cover.`
              : `${VIDEOS.length - unrecorded} of ${VIDEOS.length} recorded.`}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {VIDEOS.map((slot) => <VideoSlotCard key={slot.id} slot={slot} />)}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ink-3">
              Grouped as {Object.values(TOPIC_LABELS).join(', ').toLowerCase()}. Each film is recorded on the real
              application running the synthetic demo, narrated, captioned and scored by
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5">npm run film</code>, which publishes it here and on the
              public page. A film is published only with its narration and captions: a walkthrough without them is not
              finished, and half the people who need it most are the ones who cannot use it without.
            </p>
          </Panel>

          <Panel title="The references these rules come from" subtitle="Where the evaluation logic in Vantage is drawn from.">
            <ul className="space-y-3 text-sm text-ink-2">
              {Object.entries(EVAL_REFERENCES).map(([key, ref]) => (
                <li key={key}>
                  <a className="link inline-flex items-center gap-1 font-medium" href={ref.url} target="_blank" rel="noreferrer noopener">
                    {ref.citation}<ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                  {ref.system && <span className="block text-xs text-ink-3">{ref.system}</span>}
                  {ref.authoritative && <p className="mt-1 text-xs text-ink-3">{ref.authoritative}</p>}
                  {(ref.updates?.length ?? 0) > 0 && (
                    <ul className="mt-1.5 space-y-1 border-l border-line pl-3">
                      {(ref.updates || []).map((u) => (
                        <li key={u.id} className="text-xs text-ink-3">
                          <a className="link" href={u.url} target="_blank" rel="noreferrer noopener">{u.id}</a> — {u.note}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">
              Verified {EVAL_VERIFIED}. Vantage is not a system of record; it organises source material and drafts.
              Official submissions belong in the authoritative systems.
            </p>
          </Panel>

          <p className="px-1 text-xs text-ink-3">Build {VERSION}</p>
        </div>
      )}
    </div>
  );
}
