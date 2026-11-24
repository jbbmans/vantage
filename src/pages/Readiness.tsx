import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, ExternalLink, Info, RotateCcw } from 'lucide-react';
import { Button, Field, Input, Select, Panel, Badge, NumberInput, Skeleton, Switch } from '@/components/ui/primitives';
import { PageShell } from '@/components/common';
import { useToast } from '@/components/ui/toast';
import { keys, useActivities, useIdentity, useReadiness, useTrack } from '@/lib/queries';
import * as api from '@/lib/api';
import { ARQ_BANDS, recommend, fitnessClass, EFFORT_ORDER } from '../../shared/jepes';
import { estimateJepes, bonusItems, JEPES_READINESS_COLUMNS, MARK_NAMES, type JepesEstimate } from '../../shared/jepesEstimate';
import { fitrepCoverage, recommendFitrep, daysUntil, annualEnd, FITREP_SECTIONS, type Recommendation } from '../../shared/evaluation';
import { EVAL_REFERENCES, EVAL_VERIFIED, REC_KINDS } from '../../shared/evalRefs';
import { RIFLE_QUALS, MCMAP_BELTS, DEGREES, PME_STATUS } from '../../shared/constants';
import { areaBalance } from '../../shared/narrative';
import { areasFor, areaAmong } from '../../shared/evaluation';
import { EstimateBreakdown, EstimateSources, EstimateTotal, showRange, totalText } from '@/components/JepesEstimate';
import { humanize } from '@/lib/utils';
import { usePlace } from '@/lib/place';

/** Every readiness figure the page saves: the ones readiness always kept, and the ones the JEPES estimate reads. */
const SAVED = ['pft_score', 'cft_score', 'rifle_qual', 'mcmap_belt', 'ceus', 'college_credits', 'degree', 'pme_complete', 'cmd_character', 'cmd_mos', 'cmd_leadership', 'fitrep_period_end', ...JEPES_READINESS_COLUMNS];
const FLAGS = new Set(['mcmap_instructor', 'bonus_di_school', 'bonus_recruiter_school', 'bonus_msg_school', 'bonus_combat_instructor', 'bonus_security_forces', 'bonus_reserve_affiliation']);
/** The belts at which a certified instructor reads a higher row (MCTFS codes MME and MMG). */
const INSTRUCTOR_BELTS = new Set(['Green', 'Brown']);

/** The figures a what-if can change: the ones the levers move. */
const WHAT_IF: Array<{ key: string; label: string; kind: 'number' | 'belt' | 'degree'; hint?: string }> = [
  { key: 'rifle_score', label: 'Rifle score', kind: 'number', hint: '0 to 350' },
  { key: 'mcmap_belt', label: 'MCMAP belt', kind: 'belt' },
  { key: 'pft_score', label: 'PFT', kind: 'number', hint: '0 to 300' },
  { key: 'cft_score', label: 'CFT', kind: 'number', hint: '0 to 300' },
  { key: 'ceus', label: 'MarineNet CEUs', kind: 'number' },
  { key: 'degree', label: 'Degree', kind: 'degree' },
  { key: 'courses_in_grade', label: 'Off-duty courses in grade', kind: 'number' },
  { key: 'mos_qual_points', label: 'MOS qualification points', kind: 'number' },
  { key: 'cmd_mos', label: MARK_NAMES.cmd_mos, kind: 'number', hint: '0.0 to 5.0' },
  { key: 'cmd_leadership', label: MARK_NAMES.cmd_leadership, kind: 'number', hint: '0.0 to 5.0' },
  { key: 'cmd_character', label: MARK_NAMES.cmd_character, kind: 'number', hint: '0.0 to 5.0' },
  { key: 'recruiting_referrals', label: 'Recruiting referrals who enlisted', kind: 'number' },
];

const nonBlank = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== ''));

/** How the what-if moves the estimate, in words. */
function difference(now: JepesEstimate, then: JepesEstimate): string {
  if (now.exact && then.exact) {
    const d = then.total.low - now.total.low;
    return d === 0 ? 'the same as now' : `${Math.abs(d).toLocaleString('en-US')} ${d > 0 ? 'more' : 'fewer'} than now`;
  }
  return `now ${totalText(now)}`;
}

export default function Readiness({ embedded }: { embedded?: boolean } = {}) {
  const place = usePlace();
  const toast = useToast();
  const qc = useQueryClient();
  const track = useTrack();
  const { data: identity } = useIdentity();
  const { data: readiness, isPending } = useReadiness();
  const { data: activities } = useActivities();
  const [form, setForm] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [whatIf, setWhatIf] = useState<Record<string, string>>({});
  const whatIfResult = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (readiness) { setForm(Object.fromEntries(Object.entries(readiness).map(([k, v]) => [k, v == null ? '' : String(v)]))); setDirty(false); } }, [readiness]);
  const save = useMutation({ mutationFn: (payload: unknown) => api.saveReadiness(payload), onSuccess: (data) => { qc.setQueryData(keys.readiness, data); qc.invalidateQueries({ queryKey: keys.readiness }); toast.success('Readiness saved.'); setDirty(false); }, onError: (e) => toast.error(api.errorText(e)) });
  const set = (k: string) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };
  const submit = () => save.mutate(Object.fromEntries(SAVED.map((k) => [k, form[k] === '' || form[k] == null ? null : FLAGS.has(k) ? (form[k] === '1' ? 1 : 0) : form[k]])));

  const mine = useMemo(() => (activities || []).filter((a) => a.user_id === identity?.user.id), [activities, identity?.user.id]);
  // An entry keeps the area name of the track it was logged under; JEPES balance reads each by its JEPES name.
  const stats = useMemo(() => ({ total: mine.length, withOutcome: mine.filter((a) => a.result).length, thinAreas: areaBalance(mine.map((a) => ({ ...a, eval_area: areaAmong(a.eval_area, areasFor('jepes')) })) as never, areasFor('jepes')).filter((b) => b.count === 0).map((b) => b.area) }), [mine]);
  const profile = useMemo(() => ({ ...(readiness || {}), ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])) }), [readiness, form]);
  const est = useMemo(() => estimateJepes(profile), [profile]);
  // A what-if is never saved: it is the figures as typed with the changes laid over them, worked the same way.
  const tried = useMemo(() => ({ ...profile, ...nonBlank(whatIf) }), [profile, whatIf]);
  const triedEst = useMemo(() => estimateJepes(tried), [tried]);
  const trying = Object.keys(nonBlank(whatIf)).length > 0;
  const coverage = useMemo(() => fitrepCoverage(mine), [mine]);
  const daysToEnd = daysUntil(form.fitrep_period_end || null);
  const annual = useMemo(() => annualEnd(String(readiness?.rank_grade || '')), [readiness?.rank_grade]);
  const recs = useMemo(() => (track === 'fitrep' ? recommendFitrep(profile, stats, { coverage, daysToEnd }) : recommend(profile, stats)), [track, profile, stats, coverage, daysToEnd]);
  const ref = EVAL_REFERENCES[track];
  const [effortSort, setEffortSort] = useState(false);
  const byEffort = (list: Recommendation[]) => (effortSort ? [...list].sort((a, b) => EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || b.priority - a.priority) : list);
  // On the JEPES track the estimator's levers come first, in its order; the coaching no table scores follows.
  const levers = recs.filter((r) => r.upTo !== undefined);
  const coaching = recs.filter((r) => r.upTo === undefined);
  const bonuses = useMemo(() => bonusItems(est.on), [est.on]);

  const tryLever = (r: Recommendation) => {
    if (!r.change) return;
    setWhatIf((w) => ({ ...w, ...Object.fromEntries(Object.entries(r.change!).map(([k, v]) => [k, String(v)])) }));
    // To where the answer is, so it is seen and, read aloud, heard.
    requestAnimationFrame(() => whatIfResult.current?.focus());
  };

  if (isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;

  const num = (k: string, label: string, hint?: string, placeholder?: string) => (
    <Field key={k} label={label} hint={hint}><NumberInput value={form[k] || ''} onChange={(e) => set(k)(e.target.value)} placeholder={placeholder} /></Field>
  );
  const flag = (k: string, label: string, description?: string) => (
    <Switch key={k} checked={form[k] === '1'} onChange={(v) => set(k)(v ? '1' : '0')} label={label} description={description} />
  );
  const group = (legend: string, children: ReactNode) => (
    <fieldset className="min-w-0">
      <legend className="eyebrow mb-2">{legend}</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
  const recItem = (r: Recommendation) => (
    <li key={r.id} className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {r.kind === 'estimate' && r.points != null && <Badge tone="good">+{r.points} {r.points === 1 ? 'point' : 'points'}</Badge>}
        <Badge tone={REC_KINDS[r.kind]?.tone || 'neutral'}>{REC_KINDS[r.kind]?.label || r.kind}</Badge>
        <Badge>{r.effort} effort</Badge>
        <span className="text-2xs text-ink-3">{r.category}</span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-ink">{r.title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{r.detail}</p>
      {r.kind === 'estimate' && r.upTo != null && <p className="mt-1 text-2xs text-ink-3">Up to {r.upTo} {r.upTo === 1 ? 'point' : 'points'} on this line from where you stand.</p>}
      {r.change && <button type="button" className="mt-1.5 text-xs text-accent hover:underline" aria-label={`Try it in the what-if: ${r.title}`} onClick={() => tryLever(r)}>Try it in the what-if</button>}
    </li>
  );

  if (track === 'fitrep') {
    return (
      <PageShell
        embedded={embedded}
        eyebrow={place.group}
        title="FITREP readiness"
        lede="Your rank reports on a fitness report. Vantage checks that every attribute your Reporting Senior marks has evidence behind it."
        actions={<Button variant="primary" onClick={submit} loading={save.isPending} disabled={!dirty}><Save className="h-4 w-4" />Save</Button>}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title="Your figures" subtitle="Enter what MOL shows; leave unknowns blank">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="PFT" hint={fitnessClass(form.pft_score) || undefined}><NumberInput value={form.pft_score || ''} onChange={(e) => set('pft_score')(e.target.value)} placeholder="0-300" /></Field>
                <Field label="CFT" hint={fitnessClass(form.cft_score) || undefined}><NumberInput value={form.cft_score || ''} onChange={(e) => set('cft_score')(e.target.value)} placeholder="0-300" /></Field>
                <Field label="Rifle (ARQ)"><Select value={form.rifle_qual || ''} onValueChange={set('rifle_qual')} options={RIFLE_QUALS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
                <Field label="MCMAP belt"><Select value={form.mcmap_belt || ''} onValueChange={set('mcmap_belt')} options={MCMAP_BELTS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
                <Field label="PME for grade"><Select value={form.pme_complete || ''} onValueChange={set('pme_complete')} options={PME_STATUS.map((r) => ({ value: r, label: humanize(r) }))} placeholder="Not entered" /></Field>
                <div>
                  <Field label="Reporting period ends" hint={daysToEnd == null ? undefined : daysToEnd < 0 ? `Ended ${-daysToEnd}d ago` : daysToEnd === 0 ? 'Ends today' : `${daysToEnd}d left`}>
                    <Input type="date" value={form.fitrep_period_end || ''} onChange={(e) => set('fitrep_period_end')(e.target.value)} />
                  </Field>
                  {!form.fitrep_period_end && annual && <button type="button" className="mt-1 text-2xs text-accent hover:underline" title={annual.text} onClick={() => set('fitrep_period_end')(annual.date)}>Use the annual date, {annual.date}</button>}
                </div>
              </div>
            </Panel>
            <Panel title="Attribute coverage" subtitle="Does your log evidence each section your RS marks?">
              <div className="space-y-3">{coverage.map((s) => (
                <div key={s.key} className="rounded-lg border border-line p-3">
                  <div className="flex items-baseline justify-between gap-2"><h3 className="text-md font-semibold text-ink">Section {s.section}: {s.title}</h3><span className="fig text-xs text-ink-3" title={`${s.tagged} tagged here by you`}>{s.entries} {s.entries === 1 ? 'entry' : 'entries'}</span></div>
                  {s.section === 'H' && <p className="text-2xs text-ink-3">For when you served as a reporting official in the period: the evaluations you conducted, or required others to conduct.</p>}
                  <ul className="mt-2 flex flex-wrap gap-1.5">{s.attributes.map((a) => <li key={a.attribute}><Badge tone={a.likely ? 'good' : 'warn'} title={a.examples.join(' · ')}>{a.attribute} · {a.likely}</Badge></li>)}</ul>
                </div>
              ))}</div>
              <p className="mt-3 text-2xs text-ink-3">Read from each entry’s verb and words, the same way the Section C draft reads them. It flags gaps; it does not grade you. Sections and attributes per {FITREP_SECTIONS.length === 5 ? ref.citation : ref.order}.</p>
            </Panel>
          </div>
          <div className="space-y-4">
            <Panel title="Where the points are" subtitle="Ordered by impact" action={<button type="button" className="text-xs text-accent hover:underline" onClick={() => setEffortSort((v) => !v)}>{effortSort ? 'By impact' : 'By effort'}</button>}>
              <ol className="space-y-2">{byEffort(recs).map(recItem)}</ol>
            </Panel>
            <References track={track} />
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      embedded={embedded}
      eyebrow={place.group}
      title="JEPES readiness"
      lede="Your JEPES estimate from the order’s published tables, the reason for each part, and where the points are. Your score of record is the one on MOL."
      actions={<Button variant="primary" onClick={submit} loading={save.isPending} disabled={!dirty}><Save className="h-4 w-4" />Save</Button>}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Your JEPES estimate" subtitle={est.grade ? `${est.gradeLabel} tables` : 'Your rank is not set, so both the Lance Corporal and Corporal tables are read'}>
            <EstimateTotal est={est} />
            <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-2"><Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />Your score of record is the one on MOL. This works the MCO 1616.1 worksheet on the figures you entered here, with the tables in force today.</p>
            {est.blanks.length > 0 && <p className="mt-1 text-xs text-ink-3">{est.blanks.length} {est.blanks.length === 1 ? 'figure is' : 'figures are'} blank, so {est.blanks.length === 1 ? 'its line spans' : 'their lines span'} the whole range. Enter {est.blanks.length === 1 ? 'it' : 'them'} below to narrow the estimate.</p>}
            <div className="mt-3"><EstimateBreakdown est={est} /></div>
            <div className="mt-3"><EstimateSources est={est} /></div>
          </Panel>

          <Panel title="Your figures" subtitle="Enter what MOL and MCTIMS show; leave unknowns blank">
            <div className="space-y-4">
              {group('Warfighting', <>
                {num('rifle_score', 'Rifle score', '0 to 350, as MOL lists it', 'Not entered')}
                <Field label="Rifle qualification"><Select value={form.rifle_qual || ''} onValueChange={set('rifle_qual')} options={RIFLE_QUALS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
                <Field label="MCMAP belt"><Select value={form.mcmap_belt || ''} onValueChange={set('mcmap_belt')} options={MCMAP_BELTS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
                {INSTRUCTOR_BELTS.has(form.mcmap_belt) && <div className="col-span-2 sm:col-span-3">{flag('mcmap_instructor', `Certified Martial Arts Instructor at ${form.mcmap_belt} belt`)}</div>}
              </>)}
              {group('Physical Toughness', <>
                {num('pft_score', 'PFT', fitnessClass(form.pft_score) || undefined, '0-300')}
                {num('cft_score', 'CFT', fitnessClass(form.cft_score) || undefined, '0-300')}
              </>)}
              {group('Mental Agility', <>
                {num('ceus', 'MarineNet CEUs', 'Since your date of rank')}
                <Field label="Degree"><Select value={form.degree || ''} onValueChange={set('degree')} options={DEGREES.map((r) => ({ value: r, label: humanize(r) }))} placeholder="None" /></Field>
                {num('associate_degrees', 'Associate degrees')}
                {num('courses_in_service', 'Off-duty courses in service', 'Before your date of rank')}
                {num('courses_in_grade', 'Off-duty courses in grade', 'Since your date of rank')}
                {num('mos_qual_points', 'MOS qualification points', 'From the MOL table, 0 to 100')}
                {num('college_credits', 'College credits')}
                <Field label="PME for grade"><Select value={form.pme_complete || ''} onValueChange={set('pme_complete')} options={PME_STATUS.map((r) => ({ value: r, label: humanize(r) }))} placeholder="Not entered" /></Field>
              </>)}
              {group('Command Input', <>
                {num('cmd_mos', MARK_NAMES.cmd_mos, '0.0 to 5.0')}
                {num('cmd_leadership', MARK_NAMES.cmd_leadership, '0.0 to 5.0')}
                {num('cmd_character', MARK_NAMES.cmd_character, '0.0 to 5.0')}
              </>)}
              <fieldset className="min-w-0">
                <legend className="eyebrow mb-2">Bonus</legend>
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">{bonuses.filter((b) => b.key !== 'bonus_reserve_affiliation' || est.grade !== 'lcpl').map((b) => flag(b.key, b.label, b.key === 'bonus_reserve_affiliation' ? `${b.points} points, for an eligible Corporal` : `${b.points} points`))}</div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">{num('recruiting_referrals', 'Recruiting referrals who enlisted', '20 points each')}</div>
              </fieldset>
            </div>
          </Panel>

          <Panel title="What if" subtitle="Change a figure to see what it does. Nothing here is saved." action={trying ? <button type="button" className="inline-flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => { setWhatIf({}); requestAnimationFrame(() => whatIfResult.current?.focus()); }}><RotateCcw className="h-3 w-3" aria-hidden />Start over</button> : undefined}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {WHAT_IF.map((f) => {
                const onSet = (v: string) => setWhatIf((w) => ({ ...w, [f.key]: v }));
                if (f.kind === 'belt') return <Field key={f.key} label={`What if: ${f.label}`} hint={`Now ${form.mcmap_belt || 'not entered'}`}><Select value={whatIf[f.key] || ''} onValueChange={onSet} options={[{ value: '', label: 'As now' }, ...MCMAP_BELTS.map((r) => ({ value: r, label: r }))]} /></Field>;
                if (f.kind === 'degree') return <Field key={f.key} label={`What if: ${f.label}`} hint={`Now ${form.degree ? humanize(form.degree) : 'none'}`}><Select value={whatIf[f.key] || ''} onValueChange={onSet} options={[{ value: '', label: 'As now' }, ...DEGREES.map((r) => ({ value: r, label: humanize(r) }))]} /></Field>;
                return <Field key={f.key} label={`What if: ${f.label}`} hint={`Now ${form[f.key] || 'not entered'}`}><NumberInput value={whatIf[f.key] || ''} onChange={(e) => onSet(e.target.value)} placeholder={f.hint || 'As now'} /></Field>;
              })}
              {INSTRUCTOR_BELTS.has(String(tried.mcmap_belt ?? '')) && <div className="col-span-2 sm:col-span-3"><Switch checked={String(tried.mcmap_instructor ?? '') === '1'} onChange={(v) => setWhatIf((w) => ({ ...w, mcmap_instructor: v ? '1' : '0' }))} label={`What if: certified instructor at ${String(tried.mcmap_belt)} belt`} /></div>}
            </div>
            <p ref={whatIfResult} tabIndex={-1} aria-live="polite" className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {trying ? <>With these changes: <span className="fig font-semibold">{totalText(triedEst)}</span>, {difference(est, triedEst)}.</> : 'Type a figure above, or choose “Try it” on a step, to see the estimate it gives.'}
            </p>
            {trying && <ul className="mt-2 space-y-1">{triedEst.pillars.map((p, i) => {
              const before = est.pillars[i].points;
              if (before.low === p.points.low && before.high === p.points.high) return null;
              return <li key={p.key} className="flex items-baseline justify-between gap-2 text-xs"><span className="text-ink-2">{p.label}</span><span className="fig text-ink">{showRange(before)} now, {showRange(p.points)} with the changes</span></li>;
            })}</ul>}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Where the points are" subtitle="Blank figures first, then each step by the points it adds" action={<button type="button" className="text-xs text-accent hover:underline" onClick={() => setEffortSort((v) => !v)}>{effortSort ? 'By points' : 'By effort'}</button>}>
            {levers.length ? <ol className="space-y-2">{byEffort(levers).map(recItem)}</ol> : <p className="text-sm text-ink-3">Every line the tables score is at its most.</p>}
            {coaching.length > 0 && <>
              <h3 className="eyebrow mb-2 mt-4">Also worth doing</h3>
              <ul className="space-y-2">{coaching.map(recItem)}</ul>
            </>}
          </Panel>
          <References track={track} />
        </div>
      </div>
    </PageShell>
  );
}

function References({ track }: { track: 'jepes' | 'fitrep' }) {
  const ref = EVAL_REFERENCES[track];
  return (
    <Panel title="References" subtitle={`verified ${EVAL_VERIFIED}`}>
      <ul className="space-y-1.5 text-sm">
        <li><a className="link inline-flex items-center gap-1" href={ref.url} target="_blank" rel="noopener noreferrer">{ref.citation}<ExternalLink className="h-3 w-3" /></a></li>
        {(ref.updates || []).map((u) => <li key={u.id} className="text-xs text-ink-2"><a className="link" href={u.url} target="_blank" rel="noopener noreferrer">{u.id}</a>: {u.note}</li>)}
        {track === 'jepes' && <li className="pt-1 text-xs text-ink-3">ARQ bands ({EVAL_REFERENCES.arq.order}): {ARQ_BANDS.map((b) => `${b.qual} ${b.band}`).join('; ')}.</li>}
        <li className="text-xs text-ink-3"><a className="link" href={EVAL_REFERENCES.pftcft.url} target="_blank" rel="noopener noreferrer">{EVAL_REFERENCES.pftcft.citation}</a> governs PFT/CFT scoring.</li>
      </ul>
      {ref.authoritative && <p className="mt-2 text-2xs text-ink-3">{ref.authoritative}</p>}
    </Panel>
  );
}
