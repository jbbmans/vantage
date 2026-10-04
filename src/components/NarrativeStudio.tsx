import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, CheckCircle2, Copy, EyeOff, Lightbulb, PenLine, Pin, PinOff, Plus, RotateCcw, Shuffle, Undo2 } from 'lucide-react';
import { Badge, Button, EmptyState, Panel, Segmented, Select } from '@/components/ui/primitives';
import { composeNarrative, type Narrative } from '../../shared/narrative';
import { reviewText, type Finding, type Review } from '../../shared/writer/review';
import type { Sentence } from '../../shared/writer/compose';
import type { CaseWork } from '../../shared/writer/compose';
import { plain } from '../../shared/writer/realize';
import { areaAmong, narrativeConfig, type Track } from '../../shared/evaluation';
import type { MetricsConfig } from '../../shared/constants';
import { cn } from '@/lib/utils';

/** How the Marine has shaped the narrative: kept per person, track and period, in this browser only. */
export interface NarrativeChoices {
  seed: number; density: 'auto' | 'full' | 'compact'; chars: number | null; exclude: string[]; pin: string[]; edited: string | null;
  format: 'bullets' | 'paragraph'; spell: boolean;
}
const EMPTY: NarrativeChoices = { seed: 0, density: 'auto', chars: null, exclude: [], pin: [], edited: null, format: 'bullets', spell: true };

export function useNarrativeChoices(key: string) {
  const storageKey = `vantage.narrative.${key}`;
  const [choices, setChoices] = useState<NarrativeChoices>(EMPTY);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); setChoices(saved ? { ...EMPTY, ...saved } : EMPTY); } catch { setChoices(EMPTY); }
  }, [storageKey]);
  const update = (next: Partial<NarrativeChoices>) => setChoices((was) => {
    const merged = { ...was, ...next };
    try { localStorage.setItem(storageKey, JSON.stringify(merged)); } catch { /* the choices still hold for this visit */ }
    return merged;
  });
  return [choices, update] as const;
}

/** The query the PDF needs to say exactly what is on screen. */
export function choicesToParams(c: NarrativeChoices): Record<string, string | number | undefined> {
  return {
    seed: c.seed || undefined, density: c.density === 'auto' ? undefined : c.density, chars: c.chars ?? undefined,
    exclude: c.exclude.length ? c.exclude.join(',') : undefined, pin: c.pin.length ? c.pin.join(',') : undefined,
    narrative: c.edited ?? undefined, format: c.format, spell: c.spell ? '1' : '0',
  };
}

interface ReportShape {
  track: Track; from: string; to: string; activities: Array<Record<string, unknown>>; casework?: CaseWork | null; recentFrom?: string | null;
  metricsConfig: MetricsConfig; narrative: Narrative;
}

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 30; const c = 2 * Math.PI * r;
  const tone = score >= 85 ? 'text-good' : score >= 70 ? 'text-accent' : score >= 50 ? 'text-warn' : 'text-bad';
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 72 72" className="h-[72px] w-[72px] shrink-0 -rotate-90" aria-hidden>
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="7" className="stroke-surface-3" />
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="7" strokeLinecap="round" className={cn('stroke-current transition-[stroke-dashoffset] duration-700', tone)} strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} />
      </svg>
      <div>
        <p className="fig text-3xl font-semibold text-ink">{score}<span className="text-base font-normal text-ink-3">/100</span></p>
        <p className={cn('text-sm font-medium', tone)}>{grade}</p>
      </div>
    </div>
  );
}

const TONE_ICON = { fix: AlertCircle, consider: Lightbulb, good: CheckCircle2 } as const;
const TONE_CLASS = { fix: 'text-warn', consider: 'text-accent', good: 'text-good' } as const;

function FindingRow({ f }: { f: Finding }) {
  const Icon = TONE_ICON[f.tone];
  const first = f.sources?.find((s) => s !== 'casework');
  const action = f.action?.kind === 'open' && first ? <Link className="link inline-flex items-center gap-1 text-xs" to={`/records/${first}`}>Open entry<ArrowUpRight className="h-3 w-3" /></Link>
    : f.action?.kind === 'tag' ? <Link className="link inline-flex items-center gap-1 text-xs" to="/record/activities?quality=untagged">Tag them<ArrowUpRight className="h-3 w-3" /></Link>
    : f.action?.kind === 'log' ? <button type="button" className="link inline-flex items-center gap-1 text-xs" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: f.action?.prompt || '' }))}><Plus className="h-3 w-3" />Log one</button>
    : f.id === 'outcome:more' ? <Link className="link inline-flex items-center gap-1 text-xs" to="/record/activities?quality=needs-detail">Needs detail<ArrowUpRight className="h-3 w-3" /></Link>
    : null;
  return (
    <li className="flex gap-2.5 py-2.5">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_CLASS[f.tone])} aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="text-ink">{f.title}{f.cite && <span className={cn('ml-1.5 whitespace-nowrap rounded px-1.5 py-px align-middle text-2xs font-medium', f.basis === 'order' ? 'bg-good/10 text-good' : 'bg-surface-3 text-ink-3')} title={f.basis === 'order' ? 'From an order or its form' : f.basis === 'guidance' ? 'From official guidance or the Marine Corps Gazette' : undefined}>{f.cite}</span>}{f.basis === 'style' && <span className="ml-1.5 whitespace-nowrap rounded bg-surface-3 px-1.5 py-px align-middle text-2xs text-ink-3">Style</span>}</p>
        {f.detail && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{f.detail}</p>}
        {action && <p className="mt-1">{action}</p>}
      </div>
    </li>
  );
}

function ReviewPanel({ review, edited }: { review: Review; edited: boolean }) {
  return (
    <Panel title="Reviewer" subtitle={edited ? 'Reading your edited text' : 'How this narrative reads, and what would make it stronger'}>
      <ScoreRing score={review.score} grade={review.grade} />
      <ul className="mt-4 space-y-2">
        {review.parts.map((p) => (
          <li key={p.key}>
            <span className="flex justify-between text-xs"><span className="text-ink-2">{p.label}</span><span className="fig text-ink-3">{p.note}</span></span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-3"><span className={cn('block h-full rounded-full', p.earned >= p.of * 0.8 ? 'bg-good' : p.earned >= p.of * 0.5 ? 'bg-accent' : 'bg-warn')} style={{ width: `${(p.earned / p.of) * 100}%` }} /></span>
          </li>
        ))}
      </ul>
      {review.findings.length > 0 && <ul className="mt-4 divide-y divide-line border-t border-line">{review.findings.slice(0, 9).map((f) => <FindingRow key={f.id} f={f} />)}</ul>}
    </Panel>
  );
}

function SourceCard({ sentence, facts, onPin, onExclude, pinned }: { sentence: Sentence; facts: Narrative['facts']; onPin: () => void; onExclude: () => void; pinned: boolean }) {
  const from = facts.filter((f) => sentence.covers.includes(f.key));
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-4 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">Score {sentence.score}</Badge>
        {sentence.attribute && <Badge>{sentence.attribute}</Badge>}
        {sentence.compact && <Badge>Shortened to fit</Badge>}
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" onClick={onPin}>{pinned ? <><PinOff className="h-3.5 w-3.5" />Unpin</> : <><Pin className="h-3.5 w-3.5" />Always keep</>}</Button>
          {sentence.kind !== 'summary' && <Button size="xs" variant="ghost" onClick={onExclude}><EyeOff className="h-3.5 w-3.5" />Leave out</Button>}
        </span>
      </div>
      {sentence.reasons.length > 0 && <p className="mt-2 text-xs text-ink-3">Why it made the cut: {sentence.reasons.join(' · ')}</p>}
      {sentence.kind === 'casework' ? (
        <p className="mt-2 text-xs text-ink-2">From your case histories in this period. <Link className="link" to="/record/contributions">See the contributions</Link></p>
      ) : sentence.kind === 'summary' ? (
        <p className="mt-2 text-xs text-ink-2">Totals for this area, including entries with no sentence of their own.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {from.map((f) => (
            <li key={f.key} className="flex items-baseline justify-between gap-3 text-xs">
              <Link className="link truncate" to={`/records/${f.sources[0]}`}>{`${f.opener} ${f.rest}`.trim()}</Link>
              <span className="fig shrink-0 text-ink-3">{f.date || ''}</span>
            </li>
          ))}
          {from.some((f) => f.edits.length) && <li className="text-2xs text-ink-3">Tidied for the narrative: {[...new Set(from.flatMap((f) => f.edits))].join(', ')}. Your entries are unchanged.</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The narrative, written in the browser by the same writer the PDF uses, so every choice shows at once: another
 * wording, full or compact, a length, what to keep and what to leave out. Each sentence opens onto the entries it came
 * from and why it was chosen; the reviewer grades the whole and says what would make it stronger.
 */
export default function NarrativeStudio({ report, title, choices, setChoices, onCopy, aside }: {
  report: ReportShape; title: string; choices: NarrativeChoices; setChoices: (c: Partial<NarrativeChoices>) => void; onCopy: (text: string) => void; aside?: React.ReactNode;
}) {
  const cfg = narrativeConfig(report.track);
  const narrative = useMemo(() => {
    const onTrack = report.activities.map((a) => ({ ...a, eval_area: areaAmong(a.eval_area as string | null, cfg.areas) }));
    return composeNarrative(onTrack as never, {
      ...cfg, limit: choices.chars ?? cfg.limit, metrics: report.metricsConfig, casework: report.casework, recentFrom: report.recentFrom,
      seed: choices.seed, density: choices.density, exclude: choices.exclude, pin: choices.pin, format: choices.format, spellOut: choices.spell,
    });
  }, [report, cfg, choices.chars, choices.seed, choices.density, choices.exclude, choices.pin, choices.format, choices.spell]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const chosen = narrative.sentences.find((s) => s.key === selected) || null;
  const text = choices.edited ?? narrative.text;
  const limit = narrative.limit;
  const review = useMemo(() => (choices.edited != null ? reviewText(choices.edited, limit) : narrative.review), [choices.edited, limit, narrative.review]);
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const byArea = narrative.areas.map((a) => ({ ...a, sentences: narrative.sentences.filter((s) => s.area === a.area) })).filter((a) => a.sentences.length);
  const lengths = report.track === 'fitrep'
    ? [{ value: '', label: `Section C (${cfg.limit.toLocaleString()})` }, { value: '2000', label: 'Long (2,000)' }, { value: '600', label: 'Short (600)' }]
    : [{ value: '', label: `Standard (${cfg.limit.toLocaleString()})` }, { value: '500', label: 'Short (500)' }, { value: '300', label: 'Brief (300)' }];
  const shaped = choices.seed || choices.density !== 'auto' || choices.chars || choices.exclude.length || choices.pin.length || choices.edited != null || choices.format !== 'bullets' || !choices.spell;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Panel
          title={title}
          subtitle={`${text.length.toLocaleString()} of ${limit.toLocaleString()} characters · ${narrative.used} ${narrative.used === 1 ? 'sentence' : 'sentences'}${narrative.omitted ? ` · ${narrative.omitted} ${narrative.omitted === 1 ? 'entry' : 'entries'} left out` : ''}`}
          action={<Button size="sm" variant="ghost" onClick={() => onCopy(plain(text))}><Copy className="h-3.5 w-3.5" />Copy</Button>}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="soft" onClick={() => { setChoices({ seed: (choices.seed + 1) % 1_000_000, edited: null }); setEditing(false); }} disabled={choices.edited != null}><Shuffle className="h-3.5 w-3.5" />Another wording</Button>
            <Segmented size="sm" label="Density" value={choices.density} onChange={(v) => setChoices({ density: v })} options={[{ value: 'auto', label: 'Best fit' }, { value: 'full', label: 'Full' }, { value: 'compact', label: 'Compact' }]} />
            <Segmented size="sm" label="Format" value={choices.format} onChange={(v) => setChoices({ format: v, edited: null })} options={[{ value: 'bullets', label: 'Bullets' }, { value: 'paragraph', label: 'Paragraph' }]} />
            <Select aria-label="Length" className="h-8 w-44 text-xs" value={choices.chars ? String(choices.chars) : ''} onValueChange={(v) => setChoices({ chars: v ? Number(v) : null })} options={lengths} />
            <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={choices.spell} onChange={(e) => setChoices({ spell: e.target.checked, edited: null })} />Spell out acronyms</label>
            <span className="ml-auto flex gap-1">
              {!editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(true); if (choices.edited == null) setChoices({ edited: narrative.text }); }}><PenLine className="h-3.5 w-3.5" />Edit text</Button>}
              {shaped && <Button size="sm" variant="ghost" onClick={() => { setChoices(EMPTY); setEditing(false); setSelected(null); }}><RotateCcw className="h-3.5 w-3.5" />Start over</Button>}
            </span>
          </div>

          {editing || choices.edited != null ? (
            <div>
              <textarea aria-label="Narrative text" className="field min-h-[220px] w-full font-mono text-sm leading-relaxed" value={choices.edited ?? ''} onChange={(e) => setChoices({ edited: e.target.value })} />
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                Your edits are kept in this browser and go into the PDF. The reviewer reads them as you type.
                <Button size="xs" variant="ghost" onClick={() => { setChoices({ edited: null }); setEditing(false); }}><Undo2 className="h-3.5 w-3.5" />Back to the written version</Button>
              </p>
            </div>
          ) : narrative.text ? (
            <div className="space-y-3 font-mono text-sm leading-relaxed text-ink" data-testid="narrative">
              {byArea.map((a) => {
                const sentence = (s: Sentence, bullet: boolean) => (
                  <button key={s.key} type="button" aria-pressed={selected === s.key} onClick={() => setSelected(selected === s.key ? null : s.key)}
                    className={cn('rounded px-0.5 text-left transition-colors hover:bg-accent/10', bullet ? 'block w-full' : 'mr-1', selected === s.key && 'bg-accent/15 ring-1 ring-accent/40', s.pinned && 'underline decoration-accent decoration-2 underline-offset-4')}>
                    {bullet ? `-${s.text}` : s.text}
                  </button>
                );
                return narrative.format === 'bullets' ? (
                  <section key={a.area}>
                    <h3 className="font-semibold">{cfg.headers[a.area] || a.area}</h3>
                    <div className="mt-0.5 space-y-0.5">{a.sentences.map((s) => sentence(s, true))}</div>
                  </section>
                ) : (
                  <p key={a.area}><span className="mr-1 font-semibold tracking-wide">{a.label}:</span>{a.sentences.map((s) => sentence(s, false))}</p>
                );
              })}
            </div>
          ) : (
            <EmptyState title="Nothing logged in this period" description="Widen the period, or log the work you did." />
          )}

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn('h-full transition-[width] duration-500', text.length <= limit ? 'bg-accent' : 'bg-bad')} style={{ width: `${Math.min(100, (text.length / limit) * 100)}%` }} /></div>
          {chosen && choices.edited == null && (
            <SourceCard sentence={chosen} facts={narrative.facts} pinned={choices.pin.includes(chosen.key)}
              onPin={() => setChoices({ pin: toggle(choices.pin, chosen.key) })}
              onExclude={() => { setChoices({ exclude: [...choices.exclude, chosen.key], pin: choices.pin.filter((k) => k !== chosen.key) }); setSelected(null); }} />
          )}
          {!chosen && narrative.text && choices.edited == null && <p className="mt-3 text-xs text-ink-3">Select a sentence to see where it came from and why it made the cut.</p>}
          <details className="mt-4 rounded-lg border border-line px-3 py-2 text-xs leading-relaxed text-ink-2">
            <summary className="cursor-pointer font-medium text-ink">How this is written</summary>
            {report.track === 'fitrep' ? (
              <div className="mt-2 space-y-2">
                <p>Under MCO 1610.7B you route your accomplishments to your reporting senior on the Marine Reported-On Worksheet. Section C, billet accomplishments, lists results only: objective, without superlatives or potential impact. The Naval Postgraduate School’s FITREP bulletin (2025) puts Section C at 1,232 characters.</p>
                <p>Vantage drafts that list by section, most significant first. The word picture in Section I, rankings and recommendations are your reporting senior’s to write; Vantage never writes them.</p>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <p>Under MCO 1616.1 your reporting chain marks command input on three lines: Individual Character, MOS and/or Mission Accomplishment, and Leadership. You may submit billet accomplishments. Appendix E asks that they be specific, quantifiable and directly related to those lines, and says required annual training, awards for a previous period and personal hobbies are not accomplishments.</p>
                <p>Vantage writes them in the order’s own form: a dash, a past-tense verb, the numbers, the result, with acronyms spelled out once. The order sets no length; 1,000 characters keeps it readable. Your marks and comments come from your chain.</p>
              </div>
            )}
            <p className="mt-2 text-ink-3">The writer tidies tense, first person and filler in the text it writes; your entries stay as you logged them. It runs on this server and sends nothing anywhere.</p>
          </details>
        </Panel>

        {choices.edited == null && (narrative.left.length > 0 || choices.exclude.length > 0 || narrative.held.length > 0) && (
          <Panel title="Left out" subtitle="Considered, but did not fit or was left out. Keep one and the writer makes room.">
            <ul className="divide-y divide-line">
              {narrative.left.slice(0, 8).map((s) => (
                <li key={s.key} className="flex items-start gap-3 py-2.5 text-sm">
                  <span className="fig mt-0.5 w-8 shrink-0 text-xs text-ink-3">{s.score}</span>
                  <span className="min-w-0 flex-1 text-ink-2">{s.text}</span>
                  <Button size="xs" variant="ghost" onClick={() => setChoices({ pin: [...choices.pin, s.key], exclude: choices.exclude.filter((k) => k !== s.key) })}><Pin className="h-3.5 w-3.5" />Keep</Button>
                </li>
              ))}
            </ul>
            {narrative.held.length > 0 && (
              <ul className="mt-2 divide-y divide-line border-t border-line">
                {narrative.held.map((h) => (
                  <li key={h.key} className="flex items-start gap-3 py-2.5 text-sm">
                    <span className="mt-0.5 w-8 shrink-0 text-2xs font-medium text-ink-3">Held</span>
                    <span className="min-w-0 flex-1"><span className="block text-ink-2">{h.text}</span><span className="block text-2xs text-ink-3">{h.reason}</span></span>
                    <Button size="xs" variant="ghost" onClick={() => setChoices({ pin: [...choices.pin, h.key] })}><Pin className="h-3.5 w-3.5" />Keep</Button>
                  </li>
                ))}
              </ul>
            )}
            {choices.exclude.length > 0 && (
              <p className="mt-2 flex items-center gap-2 text-xs text-ink-3">{choices.exclude.length} left out by you.<Button size="xs" variant="ghost" onClick={() => setChoices({ exclude: [] })}>Put them back</Button></p>
            )}
          </Panel>
        )}
      </div>
      <div className="space-y-4">
        <ReviewPanel review={review} edited={choices.edited != null} />
        {aside}
      </div>
    </div>
  );
}
