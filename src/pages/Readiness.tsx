import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, ExternalLink, Info } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Panel, Badge, Progress, NumberInput, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { keys, useActivities, useIdentity, useReadiness, useTrack } from '@/lib/queries';
import * as api from '@/lib/api';
import { PILLARS, ARQ_BANDS, estimate, recommend, fitnessClass, EFFORT_ORDER } from '../../shared/jepes';
import { fitrepCoverage, recommendFitrep, daysUntil, trackMeta, FITREP_SECTIONS } from '../../shared/evaluation';
import { EVAL_REFERENCES, EVAL_VERIFIED, REC_KINDS } from '../../shared/evalRefs';
import { RIFLE_QUALS, MCMAP_BELTS, DEGREES, PME_STATUS } from '../../shared/constants';
import { areaBalance } from '../../shared/narrative';
import { areasFor } from '../../shared/evaluation';
import { humanize, cn } from '@/lib/utils';

const STATE_TONE: Record<string, string> = { top: 'text-good', solid: 'text-ink', attention: 'text-warn', missing: 'text-ink-3', external: 'text-info' };

export default function Readiness() {
  const toast = useToast();
  const qc = useQueryClient();
  const track = useTrack();
  const { data: identity } = useIdentity();
  const { data: readiness, isPending } = useReadiness();
  const { data: activities } = useActivities();
  const [form, setForm] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (readiness) { setForm(Object.fromEntries(Object.entries(readiness).map(([k, v]) => [k, v == null ? '' : String(v)]))); setDirty(false); } }, [readiness]);
  const save = useMutation({ mutationFn: (payload: unknown) => api.saveReadiness(payload), onSuccess: (data) => { qc.setQueryData(keys.readiness, data); qc.invalidateQueries({ queryKey: keys.readiness }); toast.success('Readiness saved.'); setDirty(false); }, onError: (e) => toast.error(api.errorText(e)) });
  const set = (k: string) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };
  const submit = () => save.mutate(Object.fromEntries(['pft_score', 'cft_score', 'rifle_qual', 'mcmap_belt', 'ceus', 'college_credits', 'degree', 'pme_complete', 'cmd_character', 'cmd_mos', 'cmd_leadership', 'fitrep_period_end'].map((k) => [k, form[k] === '' || form[k] == null ? null : form[k]])));

  const mine = useMemo(() => (activities || []).filter((a: any) => a.user_id === identity?.user.id), [activities, identity?.user.id]);
  const stats = useMemo(() => ({ total: mine.length, withOutcome: mine.filter((a: any) => a.result).length, thinAreas: areaBalance(mine as never, areasFor('jepes')).filter((b) => b.count === 0).map((b) => b.area) }), [mine]);
  const profile = useMemo(() => ({ ...(readiness || {}), ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])) }), [readiness, form]);
  const est = useMemo(() => estimate(profile), [profile]);
  const coverage = useMemo(() => fitrepCoverage(mine), [mine]);
  const daysToEnd = daysUntil(form.fitrep_period_end || null);
  const recs = useMemo(() => (track === 'fitrep' ? recommendFitrep(profile, stats, { coverage, daysToEnd }) : recommend(profile, stats)), [track, profile, stats, coverage, daysToEnd]);
  const meta = trackMeta(track);
  const ref = EVAL_REFERENCES[track];
  const [effortSort, setEffortSort] = useState(false);
  const sortedRecs = effortSort ? [...recs].sort((a, b) => EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || b.priority - a.priority) : recs;

  if (isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;

  return (
    <div className="page">
      <PageHeader eyebrow={meta.readinessTitle} title={track === 'fitrep' ? 'FITREP readiness' : 'JEPES readiness'} lede={track === 'fitrep' ? 'Your rank reports on a fitness report. Vantage checks that every attribute your Reporting Senior marks has evidence behind it.' : 'The four JEPES pillars, what you have entered, and where the cheapest points are. Your MOL score is the only official number.'}>
        <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!dirty}><Save className="h-4 w-4" />Save</Button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Your figures" subtitle="enter what MOL shows; leave unknowns blank">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="PFT" hint={fitnessClass(form.pft_score) || undefined}><NumberInput value={form.pft_score || ''} onChange={(e) => set('pft_score')(e.target.value)} placeholder="0-300" /></Field>
              <Field label="CFT" hint={fitnessClass(form.cft_score) || undefined}><NumberInput value={form.cft_score || ''} onChange={(e) => set('cft_score')(e.target.value)} placeholder="0-300" /></Field>
              <Field label="Rifle (ARQ)"><Select value={form.rifle_qual || ''} onValueChange={set('rifle_qual')} options={RIFLE_QUALS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
              <Field label="MCMAP belt"><Select value={form.mcmap_belt || ''} onValueChange={set('mcmap_belt')} options={MCMAP_BELTS.map((r) => ({ value: r, label: r }))} placeholder="Not entered" /></Field>
              <Field label="PME for grade"><Select value={form.pme_complete || ''} onValueChange={set('pme_complete')} options={PME_STATUS.map((r) => ({ value: r, label: humanize(r) }))} placeholder="Not entered" /></Field>
              {track === 'fitrep' ? <Field label="Reporting period ends" hint={daysToEnd != null ? `${daysToEnd} days` : undefined}><Input type="date" value={form.fitrep_period_end || ''} onChange={(e) => set('fitrep_period_end')(e.target.value)} /></Field> : <Field label="MarineNet CEUs"><NumberInput value={form.ceus || ''} onChange={(e) => set('ceus')(e.target.value)} /></Field>}
              {track === 'jepes' && <>
                <Field label="College credits"><NumberInput value={form.college_credits || ''} onChange={(e) => set('college_credits')(e.target.value)} /></Field>
                <Field label="Degree"><Select value={form.degree || ''} onValueChange={set('degree')} options={DEGREES.map((r) => ({ value: r, label: humanize(r) }))} placeholder="None" /></Field>
                <Field label="Command: character" hint="0.0 to 5.0"><NumberInput value={form.cmd_character || ''} onChange={(e) => set('cmd_character')(e.target.value)} /></Field>
                <Field label="Command: MOS"><NumberInput value={form.cmd_mos || ''} onChange={(e) => set('cmd_mos')(e.target.value)} /></Field>
                <Field label="Command: leadership"><NumberInput value={form.cmd_leadership || ''} onChange={(e) => set('cmd_leadership')(e.target.value)} /></Field>
              </>}
            </div>
          </Panel>

          {track === 'jepes' ? (
            <Panel title="The four pillars" subtitle={`${Math.round(est.completeness * 100)}% of pillars have data`} action={<Progress value={est.completeness * 100} className="w-24" />}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PILLARS.map((p) => { const pillar = est.pillars[p.key]; return (
                  <div key={p.key} className={cn('rounded-lg border p-3', pillar.known ? 'border-line' : 'border-dashed border-warn/50')}>
                    <div className="flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold text-ink">{p.label}</h3><span className="fig text-2xs text-ink-3">{pillar.enteredCount}/{pillar.itemCount}</span></div>
                    <p className="text-2xs text-ink-3">{p.composition}</p>
                    <ul className="mt-2 space-y-1">{pillar.items.map((it) => <li key={it.key} className="flex items-baseline justify-between gap-2 text-sm"><span className="text-ink-2">{it.label}</span><span className={cn('fig text-right text-xs', STATE_TONE[it.state])} title={it.note}>{it.value ?? 'Not entered'}</span></li>)}</ul>
                  </div>
                ); })}
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-3"><Info className="mt-0.5 h-3 w-3 shrink-0" />Vantage never computes a JEPES score. Point tables live in {ref.order} and change; MOL is authoritative.</p>
            </Panel>
          ) : (
            <Panel title="Attribute coverage" subtitle="does your log evidence each section your RS marks?">
              <div className="space-y-3">{coverage.map((s) => (
                <div key={s.key} className="rounded-lg border border-line p-3">
                  <div className="flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold text-ink">Section {s.section}: {s.key}</h3><span className="fig text-xs text-ink-3">{s.tagged} tagged</span></div>
                  <ul className="mt-2 flex flex-wrap gap-1.5">{s.attributes.map((a) => <li key={a.attribute}><Badge tone={a.likely ? 'good' : 'warn'} title={a.examples.join(' · ')}>{a.attribute} · {a.likely}</Badge></li>)}</ul>
                </div>
              ))}</div>
              <p className="mt-3 text-2xs text-ink-3">Attribute matching is keyword-based. It flags gaps; it does not grade you. Sections and attributes per {FITREP_SECTIONS.length === 5 ? ref.citation : ref.order}.</p>
            </Panel>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="Where the points are" subtitle="ordered by impact" action={<button type="button" className="text-xs text-accent hover:underline" onClick={() => setEffortSort((v) => !v)}>{effortSort ? 'By impact' : 'By effort'}</button>}>
            <ol className="space-y-2">{sortedRecs.map((r) => (
              <li key={r.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-1.5"><Badge tone={REC_KINDS[r.kind]?.tone || 'neutral'}>{REC_KINDS[r.kind]?.label || r.kind}</Badge><Badge>{r.effort} effort</Badge><span className="text-2xs text-ink-3">{r.category}</span></div>
                <p className="mt-1.5 text-sm font-medium text-ink">{r.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{r.detail}</p>
              </li>
            ))}</ol>
          </Panel>
          <Panel title="References" subtitle={`verified ${EVAL_VERIFIED}`}>
            <ul className="space-y-1.5 text-sm">
              <li><a className="link inline-flex items-center gap-1" href={ref.url} target="_blank" rel="noopener noreferrer">{ref.citation}<ExternalLink className="h-3 w-3" /></a></li>
              {(ref.updates || []).map((u) => <li key={u.id} className="text-xs text-ink-2"><a className="link" href={u.url} target="_blank" rel="noopener noreferrer">{u.id}</a>: {u.note}</li>)}
              {track === 'jepes' && <li className="pt-1 text-xs text-ink-3">ARQ bands ({EVAL_REFERENCES.arq.order}): {ARQ_BANDS.map((b) => `${b.qual} ${b.band}`).join('; ')}.</li>}
              <li className="text-xs text-ink-3"><a className="link" href={EVAL_REFERENCES.pftcft.url} target="_blank" rel="noopener noreferrer">{EVAL_REFERENCES.pftcft.citation}</a> governs PFT/CFT scoring.</li>
            </ul>
            {ref.authoritative && <p className="mt-2 text-2xs text-ink-3">{ref.authoritative}</p>}
          </Panel>
        </div>
      </div>
    </div>
  );
}
