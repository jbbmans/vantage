import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, ArrowUpRight, CheckCircle2, Copy, EyeOff, Lightbulb, PenLine, Pin, PinOff, Plus, RotateCcw, Shuffle, Undo2 } from 'lucide-react';
import { Badge, Button, EmptyState, Panel, Segmented, Select } from '@/components/ui/primitives';
import { composeNarrative, type Narrative } from '../../shared/narrative';
import { reviewEdit, type Finding, type Review } from '../../shared/writer/review';
import { GRADE_BANDS, GRADE_NOTE } from '../../shared/writer/grade';
import type { Sentence } from '../../shared/writer/compose';
import type { CaseWork } from '../../shared/writer/compose';
import { plain, printable } from '../../shared/writer/realize';
import { basisOf, driftOf, type Basis, type Drift } from '../../shared/writer/basis';
import { areaAmong, FITREP_SECTIONS, narrativeConfig, type Track } from '../../shared/evaluation';
import type { MetricsConfig } from '../../shared/constants';
import { cn } from '@/lib/utils';
import { NARRATIVE_PREFIX } from '@/lib/drafts';
import { hasSession } from '@/lib/api';

/**
 * How the Marine has shaped the narrative: kept per person, track, period and unit, in this browser only. A hand edit
 * keeps the `basis` it was written from (hashes of the entries, shared/writer/basis.ts), so the studio can say when the
 * record has changed under it.
 */
export interface NarrativeChoices {
  seed: number; density: 'auto' | 'full' | 'compact'; chars: number | null; exclude: string[]; pin: string[]; edited: string | null;
  format: 'bullets' | 'paragraph'; spell: boolean; basis: Basis | null;
}
const EMPTY: NarrativeChoices = { seed: 0, density: 'auto', chars: null, exclude: [], pin: [], edited: null, format: 'bullets', spell: true, basis: null };
/** The most a hand edit may hold: what the PDF accepts. */
const EDIT_MAX = 5000;

const DENSITIES = new Set(['auto', 'full', 'compact']);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []);

/** A basis read back from storage, or null when it is not one (an old record, or one changed by hand). */
function basisFrom(v: unknown): Basis | null {
  if (!v || typeof v !== 'object') return null;
  const { entries, casework } = v as { entries?: unknown; casework?: unknown };
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  if (!Object.values(entries).every((h) => typeof h === 'string')) return null;
  return { entries: entries as Record<string, string>, casework: typeof casework === 'string' ? casework : null };
}

/** What was kept, field by field, so a value of the wrong shape falls back to the default instead of breaking the page. */
function choicesFrom(raw: string | null): NarrativeChoices {
  let saved: Record<string, unknown> | null = null;
  try { saved = JSON.parse(raw || 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return EMPTY;
  return {
    seed: Number.isInteger(saved.seed) && (saved.seed as number) >= 0 ? (saved.seed as number) % 1_000_000 : 0,
    density: DENSITIES.has(saved.density as string) ? (saved.density as NarrativeChoices['density']) : 'auto',
    // Within what the server takes (200 to 5,000), so a stray value never makes every export fail.
    chars: Number.isInteger(saved.chars) && (saved.chars as number) >= 200 && (saved.chars as number) <= 5000 ? (saved.chars as number) : null,
    exclude: strings(saved.exclude), pin: strings(saved.pin),
    edited: typeof saved.edited === 'string' ? saved.edited.slice(0, EDIT_MAX) : null,
    format: saved.format === 'paragraph' ? 'paragraph' : 'bullets',
    spell: typeof saved.spell === 'boolean' ? saved.spell : true,
    basis: basisFrom(saved.basis),
  };
}

/**
 * Where the choices are kept: this tab's session storage, as unsaved Quick Log text is (ADR-0026, ADR-0030). Closing the
 * tab or signing out forgets them, so a Marine's edited text never outlives the session that wrote it.
 */
const store = () => globalThis.sessionStorage;

function load(storageKey: string, legacyKey: string | null): NarrativeChoices {
  try {
    let raw = store().getItem(storageKey);
    if (!raw && legacyKey) {
      // Kept before in the browser's lasting storage: moved into this tab once, and gone from there.
      raw = localStorage.getItem(legacyKey);
      if (raw) { store().setItem(storageKey, raw); localStorage.removeItem(legacyKey); }
    }
    return choicesFrom(raw);
  } catch { return EMPTY; }
}

/** Another person's choices left in this tab (one who did not sign out) go once someone else's are read. */
function forgetOthers(storageKey: string) {
  const mine = storageKey.slice(0, storageKey.indexOf('.', NARRATIVE_PREFIX.length) + 1);
  if (!mine || mine === `${NARRATIVE_PREFIX}me.`) return;
  for (const storage of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) { const k = storage.key(i); if (k && k.startsWith(NARRATIVE_PREFIX) && !k.startsWith(mine)) keys.push(k); }
      for (const k of keys) storage.removeItem(k);
    } catch { /* storage unavailable: nothing was kept */ }
  }
}

/** One part of a storage key, with the separator escaped, so two parts can never read as a third. */
export const keyPart = (v: unknown) => encodeURIComponent(String(v ?? '')).replace(/\./g, '%2E');

/**
 * The choices kept under `key`, read as the key changes (during render, so another period or Marine never shows the
 * last one's text for a moment). `legacy` is the key the same choices were kept under before, read once and moved;
 * the caller passes it only where the old key meant the same thing (a Marine's own report).
 */
export function useNarrativeChoices(key: string, legacy?: string) {
  const storageKey = `${NARRATIVE_PREFIX}${key}`;
  const legacyKey = legacy && legacy !== key ? `${NARRATIVE_PREFIX}${legacy}` : null;
  const [state, setState] = useState(() => ({ key: storageKey, legacy: legacyKey, choices: load(storageKey, legacyKey), changed: false }));
  let current = state;
  if (state.key !== storageKey) {
    current = { key: storageKey, legacy: legacyKey, choices: load(storageKey, legacyKey), changed: false };
    setState(current);
  } else if (legacyKey && state.legacy !== legacyKey) {
    // The old key names the period's dates, which a rolling period ("last 12 months") has only once its report is read;
    // the choices kept under it are moved then, unless something was already kept or changed here.
    current = { ...state, legacy: legacyKey, choices: state.changed ? state.choices : load(storageKey, legacyKey) };
    setState(current);
  }
  useEffect(() => { forgetOthers(storageKey); }, [storageKey]);
  // Saved from what was shown, after it is shown: the key and the choices are always the same render's, so a change made
  // on one Marine's or period's screen is never filed under the next one's while the page moves between them.
  useEffect(() => {
    if (!state.changed || !hasSession()) return;
    try { store().setItem(state.key, JSON.stringify(state.choices)); } catch { /* the choices still hold for this visit */ }
  }, [state]);
  // Bound to the key on screen when the change was made; a change that arrives after the key moved on is dropped.
  const update = (next: Partial<NarrativeChoices>) => setState((was) => (was.key === storageKey ? { ...was, choices: { ...was.choices, ...next }, changed: true } : was));
  return [current.choices, update] as const;
}

/**
 * Where a hand edit stands against the record: none, written from the record as it is, written before the record
 * changed (with what changed), or kept from before Vantage noted what an edit was written from.
 */
export type EditState = { kind: 'none' } | { kind: 'current' } | { kind: 'changed'; drift: Drift } | { kind: 'unknown' };
export function editStateOf(c: NarrativeChoices, activities: ReadonlyArray<Record<string, unknown>>, casework?: CaseWork | null): EditState {
  // An emptied box is no edit: Copy and the PDF use the written version, so there is nothing to warn about.
  if (c.edited == null || !printable(c.edited)) return { kind: 'none' };
  if (!c.basis) return { kind: 'unknown' };
  const drift = driftOf(c.basis, activities, casework);
  return drift.any ? { kind: 'changed', drift } : { kind: 'current' };
}

/** The query the PDF needs to say exactly what is on screen. */
export function choicesToParams(c: NarrativeChoices): Record<string, string | number | undefined> {
  return {
    seed: c.seed || undefined, density: c.density === 'auto' ? undefined : c.density, chars: c.chars ?? undefined,
    exclude: c.exclude.length ? c.exclude.join(',') : undefined, pin: c.pin.length ? c.pin.join(',') : undefined,
    // An emptied box is no edit: the PDF prints the written version, as the studio says under the box.
    narrative: c.edited != null && printable(c.edited) ? c.edited : undefined, format: c.format, spell: c.spell ? '1' : '0',
  };
}

interface ReportShape {
  track: Track; from: string; to: string; activities: Array<Record<string, unknown>>; casework?: CaseWork | null; recentFrom?: string | null;
  metricsConfig: MetricsConfig; narrative: Narrative;
}

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 30; const c = 2 * Math.PI * r;
  const [strong, solid, work] = GRADE_BANDS;
  const tone = score >= strong.from ? 'text-good' : score >= solid.from ? 'text-accent' : score >= work.from ? 'text-warn' : 'text-bad';
  return (
    <div className="flex items-center gap-4" role="group" aria-label={`Grade ${score} of 100, ${grade}`}>
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
    : f.action?.kind === 'log' ? <button type="button" className="link inline-flex items-center gap-1 text-xs" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: f.action?.prompt || '' }))}><Plus className="h-3 w-3" />Log activity</button>
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
      <p className="mt-3 text-xs text-ink-3">{GRADE_NOTE}{edited ? ' A sentence you left as written keeps what its entry says; one you typed or changed is read from your words.' : ''}</p>
      <ul className="mt-4 space-y-3" aria-label="How the grade is made">
        {review.parts.map((p) => (
          <li key={p.key} data-part={p.key}>
            <span className="flex flex-wrap justify-between gap-x-3 text-xs"><span className="text-ink-2">{p.label}</span><span className="fig min-w-0 text-right text-ink-3">{p.earned} of {p.of} · {p.note}</span></span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-3"><span className={cn('block h-full rounded-full', p.earned >= p.of * 0.8 ? 'bg-good' : p.earned >= p.of * 0.5 ? 'bg-accent' : 'bg-warn')} style={{ width: `${(p.earned / p.of) * 100}%` }} /></span>
            <span className="mt-1 block text-2xs text-ink-3">From: {p.from}</span>
            {p.raise && <span className="block text-2xs text-ink-2">{p.raise.text} (+{p.raise.points})</span>}
          </li>
        ))}
      </ul>
      {review.findings.length > 0 && <ul className="mt-4 divide-y divide-line border-t border-line">{review.findings.slice(0, 9).map((f) => <FindingRow key={f.id} f={f} />)}</ul>}
    </Panel>
  );
}

function SourceCard({ sentence, facts, onPin, onExclude, pinned, fitrep }: { sentence: Sentence; facts: Narrative['facts']; onPin: () => void; onExclude: () => void; pinned: boolean; fitrep: boolean }) {
  // A summary speaks for the entries with no sentence of their own; it covers none of them, so they are found by source.
  const from = sentence.kind === 'summary'
    ? facts.filter((f) => !f.held && f.area === sentence.area && f.sources.some((s) => sentence.sources.includes(s)))
    : facts.filter((f) => sentence.covers.includes(f.key));
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-4 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">Score {sentence.score}</Badge>
        {fitrep && sentence.attribute && <Badge title="The FITREP attribute this gives your reporting senior evidence for">{sentence.attribute}</Badge>}
        {sentence.compact && <Badge>Shortened to fit</Badge>}
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" onClick={onPin}>{pinned ? <><PinOff className="h-3.5 w-3.5" />Unpin</> : <><Pin className="h-3.5 w-3.5" />Always keep</>}</Button>
          {sentence.kind !== 'summary' && <Button size="xs" variant="ghost" onClick={onExclude}><EyeOff className="h-3.5 w-3.5" />Leave out</Button>}
        </span>
      </div>
      {sentence.reasons.length > 0 && <p className="mt-2 text-xs text-ink-3">Why it made the cut: {sentence.reasons.join(' · ')}</p>}
      {sentence.kind === 'casework' ? (
        <p className="mt-2 text-xs text-ink-2">From your case histories in this period. <Link className="link" to="/record/contributions">See the contributions</Link></p>
      ) : (
        <ul className="mt-2 space-y-1">
          {sentence.kind === 'summary' && <li className="text-xs text-ink-2">Totals the entries in this area that have no sentence of their own. No figure here repeats another sentence.</li>}
          {sentence.kind === 'group' && <li className="text-xs text-ink-2">One total for {from.length} entries of the same work, said once. Leave it out and the work is left out; keep one of them and the total is kept.</li>}
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
  // What Copy and the PDF take, and so what is counted and reviewed: the edit, or the written version when the box was emptied.
  const hasEdit = choices.edited != null && Boolean(printable(choices.edited));
  const output = hasEdit ? choices.edited! : narrative.text;
  const text = output;
  const limit = narrative.limit;
  // One scale for both: an edit's unchanged sentences keep their entries' reading, so pressing Edit text alone changes nothing.
  const review = useMemo(
    () => (hasEdit ? reviewEdit(choices.edited!, narrative, { ...narrativeConfig(report.track), metrics: report.metricsConfig }) : narrative.review),
    [hasEdit, choices.edited, narrative, report.track, report.metricsConfig],
  );
  // What changed in the record since the text was edited: the text stays as written, and the Marine is told.
  const edit = useMemo(() => editStateOf(choices, report.activities, report.casework), [choices, report.activities, report.casework]);
  const drift = edit.kind === 'changed' ? edit.drift : null;
  const takeBasis = () => setChoices({ basis: basisOf(report.activities, report.casework) });
  const backToWritten = () => { setChoices({ edited: null, basis: null }); setEditing(false); };
  const titleOf = (id: string) => String(report.activities.find((a) => String(a.id) === id)?.title || '').trim();
  const driftWords = (d: NonNullable<typeof drift>) => {
    const named = (ids: string[]) => ids.slice(0, 3).map((id) => `“${titleOf(id)}”`).filter((t) => t.length > 2).join(', ');
    const parts = [
      d.changed.length ? `${d.changed.length} ${d.changed.length === 1 ? 'entry' : 'entries'} changed${named(d.changed) ? ` (${named(d.changed)}${d.changed.length > 3 ? ', and more' : ''})` : ''}` : '',
      d.added.length ? `${d.added.length} added${named(d.added) ? ` (${named(d.added)}${d.added.length > 3 ? ', and more' : ''})` : ''}` : '',
      d.removed ? `${d.removed} no longer in the period` : '',
      d.casework ? 'the case histories changed' : '',
    ].filter(Boolean);
    return parts.join('; ');
  };
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
          action={<Button size="sm" variant="ghost" onClick={() => onCopy(plain(output))}><Copy className="h-3.5 w-3.5" />Copy</Button>}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="soft" onClick={() => { setChoices({ seed: (choices.seed + 1) % 1_000_000, edited: null }); setEditing(false); }} disabled={choices.edited != null}><Shuffle className="h-3.5 w-3.5" />Another wording</Button>
            <Segmented size="sm" label="Density" value={choices.density} onChange={(v) => { if (choices.edited == null) setChoices({ density: v }); }} disabled={choices.edited != null} options={[{ value: 'auto', label: 'Best fit' }, { value: 'full', label: 'Full' }, { value: 'compact', label: 'Compact' }]} />
            {/* Density, format, length and spelling rewrite the text the edit is read against, so they wait while a hand edit stands. */}
            <Segmented size="sm" label="Format" value={choices.format} onChange={(v) => { if (choices.edited == null) setChoices({ format: v }); }} disabled={choices.edited != null} options={[{ value: 'bullets', label: 'Bullets' }, { value: 'paragraph', label: 'Paragraph' }]} />
            <Select aria-label="Length" className="h-8 w-44 text-xs" value={choices.chars ? String(choices.chars) : ''} onValueChange={(v) => { if (choices.edited == null) setChoices({ chars: v ? Number(v) : null }); }} disabled={choices.edited != null} options={lengths} />
            <label className={cn('flex items-center gap-1.5 text-xs text-ink-2', choices.edited != null && 'opacity-60')}><input type="checkbox" checked={choices.spell} disabled={choices.edited != null} onChange={(e) => setChoices({ spell: e.target.checked })} />Spell out acronyms</label>
            <span className="ml-auto flex gap-1">
              {!editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(true); if (choices.edited == null) setChoices({ edited: narrative.text, basis: basisOf(report.activities, report.casework) }); }}><PenLine className="h-3.5 w-3.5" />Edit text</Button>}
              {shaped && <Button size="sm" variant="ghost" onClick={() => { setChoices(EMPTY); setEditing(false); setSelected(null); }}><RotateCcw className="h-3.5 w-3.5" />Start over</Button>}
            </span>
          </div>

          {editing || choices.edited != null ? (
            <div>
              {(drift || edit.kind === 'unknown') && (
                <div role="status" className="mb-3 flex flex-wrap items-start gap-2 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2 text-xs text-ink-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
                  <span className="min-w-0 flex-1">{drift
                    ? <>The record changed after this text was edited: {driftWords(drift)}. The text is kept as written; check it against the record.</>
                    : <>This text was edited before Vantage noted what it was written from, so it cannot say whether the record has changed since. Check it against the record.</>}</span>
                  <span className="flex gap-1">
                    <Button size="xs" variant="ghost" onClick={takeBasis}>Keep my text</Button>
                    <Button size="xs" variant="ghost" onClick={backToWritten}><Undo2 className="h-3.5 w-3.5" />Use the written version</Button>
                  </span>
                </div>
              )}
              <textarea aria-label="Narrative text" aria-describedby="narrative-edit-note" maxLength={EDIT_MAX} className="field min-h-[220px] w-full font-mono text-sm leading-relaxed" value={choices.edited ?? ''} onChange={(e) => setChoices({ edited: e.target.value })} />
              <p id="narrative-edit-note" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                {choices.edited != null && !hasEdit
                  ? 'The box is empty, so Copy and the PDF use the written version. '
                  : 'Edits are kept in this tab until it closes or you sign out, and go into the PDF. The reviewer reads them as you type. '}
                Density, Format, Length and Spell out acronyms wait until you go back to the written version.
                <Button size="xs" variant="ghost" onClick={backToWritten}><Undo2 className="h-3.5 w-3.5" />Back to the written version</Button>
              </p>
            </div>
          ) : narrative.text ? (
            <div className="space-y-3 font-mono text-sm leading-relaxed text-ink" data-testid="narrative">
              {byArea.map((a) => {
                const sentence = (s: Sentence, bullet: boolean) => (
                  <button key={s.key} type="button" aria-pressed={selected === s.key} onClick={() => setSelected(selected === s.key ? null : s.key)}
                    className={cn('rounded px-0.5 text-left transition-colors hover:bg-accent/10', bullet ? 'block min-h-6 w-full py-0.5' : 'mr-1', selected === s.key && 'bg-accent/15 ring-1 ring-accent/40', s.pinned && 'underline decoration-accent decoration-2 underline-offset-4')}>
                    {bullet ? `-${s.text}` : s.text}
                  </button>
                );
                // Section C carries no headings; the section each line evidences is shown as a guide, outside the text.
                const guide = cfg.headings ? null : FITREP_SECTIONS.find((x) => x.key === a.area);
                return narrative.format === 'bullets' ? (
                  <section key={a.area}>
                    {cfg.headings ? <h3 className="font-semibold">{cfg.headers[a.area] || a.area}</h3>
                      : <p className="select-none font-sans text-2xs uppercase tracking-wide text-ink-3">{guide ? `Section ${guide.section} · ${guide.title}` : a.area}</p>}
                    <div className="mt-0.5 space-y-0.5">{a.sentences.map((s) => sentence(s, true))}</div>
                  </section>
                ) : (
                  <p key={a.area}>{cfg.headings && <span className="mr-1 font-semibold tracking-wide">{a.label}:</span>}{a.sentences.map((s) => sentence(s, false))}</p>
                );
              })}
            </div>
          ) : (
            <EmptyState title="Nothing logged in this period" description="Widen the period, or log the work you did." />
          )}

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn('h-full transition-[width] duration-500', text.length <= limit ? 'bg-accent' : 'bg-bad')} style={{ width: `${Math.min(100, (text.length / limit) * 100)}%` }} /></div>
          {chosen && choices.edited == null && (
            <SourceCard fitrep={report.track === 'fitrep'} sentence={chosen} facts={narrative.facts} pinned={choices.pin.includes(chosen.key)}
              onPin={() => setChoices({ pin: toggle(choices.pin, chosen.key) })}
              onExclude={() => { setChoices({ exclude: [...choices.exclude, chosen.key], pin: choices.pin.filter((k) => k !== chosen.key) }); setSelected(null); }} />
          )}
          {!chosen && narrative.text && choices.edited == null && <p className="mt-3 text-xs text-ink-3">Select a sentence to see where it came from and why it made the cut.{!cfg.headings && narrative.format === 'bullets' && ' The section labels are a guide for you; Copy and the PDF leave them out, as Section C has none.'}</p>}
          <details className="mt-4 rounded-lg border border-line px-3 py-2 text-xs leading-relaxed text-ink-2">
            <summary className="cursor-pointer font-medium text-ink">How this is written</summary>
            {report.track === 'fitrep' ? (
              <div className="mt-2 space-y-2">
                <p>Under MCO 1610.7B your input reaches your reporting senior on the MRO worksheet (MROW). Its block for major accomplishments during the period feeds Section C, billet accomplishments: what you accomplished, as against Section B’s duties, results only and void of superlatives (NAVMC 10835). The Naval Postgraduate School’s FITREP bulletin (2025) writes Section C as dash bullets and puts it at 1,232 characters.</p>
                <p>Vantage drafts it that way: one list of dash bullets with no headings, ordered by the section each line gives evidence for (D to H), so every section your reporting senior marks has something behind it. PME and self-education, and awards and community involvement, have blocks of their own on the worksheet, listed beside the draft. Section I, the marks, rankings and recommendations are your reporting chain’s to write; Vantage never writes them.</p>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                <p>Under MCO 1616.1 your reporting chain marks command input on three lines: Individual Character, MOS and/or Mission Accomplishment, and Leadership. You may submit billet accomplishments. Appendix E asks that they be specific, quantifiable and directly related to those lines, and says required annual training, awards for a previous period and personal hobbies are not accomplishments.</p>
                <p>Vantage writes them in the order’s own form: a dash, a past-tense verb, the numbers, the result, with acronyms spelled out once. The order sets no length; 1,000 characters keeps it readable. Your marks and comments come from your chain.</p>
              </div>
            )}
            <p className="mt-2 text-ink-3">The writer tidies tense, first person and filler in the text it writes; your entries stay as you logged them. It runs inside Vantage and sends nothing anywhere.</p>
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
                    <span className="mt-0.5 w-12 shrink-0 text-2xs font-medium text-ink-3">{h.route === 'pme' ? 'PME block' : h.route === 'other' ? 'Other block' : 'Held'}</span>
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
        <ReviewPanel review={review} edited={hasEdit} />
        {aside}
      </div>
    </div>
  );
}
