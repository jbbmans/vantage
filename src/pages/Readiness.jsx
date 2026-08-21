import React, { useEffect, useMemo, useState } from 'react';
import { Target, TrendingUp, Save, Info, Gauge, ExternalLink } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useActivities, useIdentity } from '@/store/useStore';
import { estimate, recommend, biggestLever, PILLARS, MCMAP_BELTS, RIFLE_QUALS, ARQ_BANDS } from '@/lib/jepes';
import { EVAL_REFERENCES, EVAL_VERIFIED, REC_KINDS } from '@/lib/evalRefs';
import {
  trackForGrade, trackMeta, fitrepCoverage, recommendFitrep, daysUntil, FITREP_SECTIONS,
} from '@/lib/evaluation';
import { useEvalTrack, usePrefs, setPref } from '@/store/useStore';
import { JEPES_CORE } from '@/lib/constants';
import { useToast } from '@/components/ui/toast';
import { Panel, PageHeader, EmptyState, Button, Input, Field, Select, Badge, Segmented, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/api';

const EFFORT_TONE = {
  trivial: 'text-ledger',
  low: 'text-ledger',
  medium: 'text-signal',
  high: 'text-text-3',
};

const EFFORT_LABEL = {
  trivial: 'minutes',
  low: 'cheap',
  medium: 'real work',
  high: 'a campaign',
};

/** Chip that tells a Marine whether a line is policy, their own data, or Vantage's opinion (finding 22). */
function KindChip({ kind }) {
  const k = REC_KINDS[kind] || REC_KINDS.heuristic;
  return <Badge tone={k.tone}>{k.label}</Badge>;
}

const STATE_STYLE = {
  top: 'border-ledger/40 bg-ledger/[0.08] text-text-2',
  solid: 'border-rule text-text-2',
  attention: 'border-signal/40 bg-signal/[0.08] text-signal',
  missing: 'border-dashed border-rule text-text-3',
  external: 'border-info/40 bg-info/[0.06] text-text-3',
};

function StateChip({ it }) {
  return (
    <Tooltip content={it.note || (it.state === 'missing' ? 'Not entered — unknown, not zero.' : it.label)}>
      <span className={cn('cursor-help rounded border px-1.5 py-0.5 text-2xs', STATE_STYLE[it.state])}>
        {it.label}{it.value ? ` · ${it.value}` : it.state === 'missing' ? ' · not entered' : ''}
      </span>
    </Tooltip>
  );
}

/** Official-source links only (finding 50), with the date the citations were last verified (finding 48). */
function ReferencesPanel({ entries }) {
  return (
    <Panel title="References" subtitle={`Official sources · citations verified ${EVAL_VERIFIED}`}>
      <div className="space-y-2">
        {entries.map((ref) => (
          <div key={ref.order} className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              {/* Short label so the row wraps on a phone; the full citation
                  lives in the tooltip title and in evalRefs. */}
              <a href={ref.url} target="_blank" rel="noreferrer" title={ref.citation}>
                <ExternalLink className="h-3 w-3" />
                {ref.order}
              </a>
            </Button>
            {(ref.updates || []).map((u) => (
              <Button key={u.id} variant="ghost" size="sm" asChild>
                <a href={u.url} target="_blank" rel="noreferrer" title={u.note}>
                  <ExternalLink className="h-3 w-3" />
                  {u.id}
                </a>
              </Button>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * The JEPES preparation dashboard.
 *
 * It deliberately shows no composite score. The official conversion is
 * percentile-based against your peer group and lives on MOL; a number Vantage
 * invented would look authoritative and be wrong (v3.3 finding 19). What it
 * shows instead: which inputs are on record, where each stands, and what to
 * work on — with every judgement labeled as coaching, never as policy.
 */
export default function Readiness() {
  const track = useEvalTrack();
  if (track === 'fitrep') return <FitrepReadiness />;
  return <JepesReadiness />;
}

/**
 * Sergeants and above are not on JEPES. There is no cutting score to grind, no
 * belt worth fifty points, no monthly recalculation. Their report is written
 * by a Reporting Senior against that RS's whole history of Marines, and the
 * one thing they control is the evidence in front of the RS when the pen
 * comes out. So this page is about coverage and the input package, not pillars.
 */
function FitrepReadiness() {
  const activities = useActivities();
  const identity = useIdentity();
  const prefs = usePrefs();
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    apiClient.readiness().then(setProfile).catch(() => setProfile({}));
  }, []);

  const mine = useMemo(
    () => activities.filter((a) => a.user_id === identity?.user?.id),
    [activities, identity]
  );

  const periodEnd = prefs.fitrep?.periodEnd || '';
  const daysToEnd = daysUntil(periodEnd);

  const coverage = useMemo(() => fitrepCoverage(mine), [mine]);
  const stats = useMemo(
    () => ({ total: mine.length, withOutcome: mine.filter((a) => a.result).length }),
    [mine]
  );
  const recs = useMemo(
    () => (profile ? recommendFitrep(profile, stats, { coverage, daysToEnd }) : []),
    [profile, stats, coverage, daysToEnd]
  );

  const set = (k) => (v) => {
    setProfile((p) => ({ ...p, [k]: v?.target ? v.target.value : v }));
    setFieldErrors((f) => { const n = { ...f }; delete n[k]; return n; });
    setDirty(true);
  };
  const save = async () => {
    try {
      await apiClient.saveReadiness(profile);
      setDirty(false);
      setFieldErrors({});
      toast.success('Saved.');
    } catch (err) {
      setFieldErrors(err.fieldErrors || {});
      toast.error(errorText(err));
    }
  };

  if (!profile) return <p className="text-sm text-text-3">Loading…</p>;

  const covered = coverage.reduce((n, s) => n + s.attributes.filter((a) => a.likely > 0).length, 0);

  return (
    <div className="mx-auto max-w-[1100px] space-y-3">
      <PageHeader
        title="FITREP readiness"
        subtitle={`${identity?.user?.rank?.abbr || ''} ${identity?.user?.last_name || ''} · fitness report track — ${EVAL_REFERENCES.fitrep.citation}`}
      />

      {/* reporting period */}
      <Panel title="Reporting period" subtitle="When your Reporting Senior next writes">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Period ends" hint="From your last report or your S-1. Vantage starts nudging at 45 days out.">
            <Input
              type="date"
              value={periodEnd}
              onChange={(e) => setPref('fitrep', { ...(prefs.fitrep || {}), periodEnd: e.target.value })}
            />
          </Field>
          {daysToEnd !== null && (
            <p className={cn('fig pb-2 text-md', daysToEnd <= 45 ? 'text-signal' : 'text-text-2')}>
              {daysToEnd >= 0 ? `${daysToEnd} days out` : `${Math.abs(daysToEnd)} days past — chase it`}
            </p>
          )}
        </div>
      </Panel>

      {/* attribute coverage */}
      <Panel
        title="Attribute coverage"
        subtitle={`Your RS marks 14 attributes across sections D–H · ${covered}/14 have possible supporting evidence in your log`}
        bodyClassName="p-0"
      >
        {coverage.map((section) => (
          <div key={section.section} className="border-b border-rule px-3 py-2.5 last:border-0">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-signal">
                {section.section} — {section.key}
              </p>
              <span className="fig text-2xs text-text-3">{section.tagged} tagged entries</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {section.attributes.map((attr) => (
                <Tooltip
                  key={attr.attribute}
                  content={
                    attr.likely
                      ? `Possible supporting evidence: ${attr.likely} ${attr.likely === 1 ? 'entry' : 'entries'} — e.g. "${attr.examples[0]}"`
                      : 'No obvious evidence found in your log. You may be doing it and not writing it down.'
                  }
                >
                  <span
                    className={cn(
                      'cursor-help rounded border px-1.5 py-0.5 text-2xs',
                      attr.likely
                        ? 'border-ledger/40 bg-ledger/[0.08] text-text-2'
                        : 'border-dashed border-rule text-text-3'
                    )}
                  >
                    {attr.attribute}
                    {attr.likely ? ` · ${attr.likely}` : ''}
                  </span>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </Panel>

      {/* recommendations */}
      <Panel title="What to do next" subtitle="Policy pointers, your own data, and Vantage's coaching — labeled apart" bodyClassName="p-0">
        {recs.map((r) => (
          <div key={r.id} className="row flex items-start gap-2.5 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-base text-text">{r.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-text-2">{r.detail}</p>
            </div>
            <span className="shrink-0"><KindChip kind={r.kind} /></span>
          </div>
        ))}
      </Panel>

      {/* the few figures that ride on the report */}
      <Panel title="Recorded on the report" subtitle="Printed on the report — MCO 1610.7B attaches no point value or cap to them">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field error={fieldErrors.pft_score} label="PFT" hint="Out of 300">
            <Input type="number" max={300} aria-label="PFT" value={profile.pft_score ?? ''} onChange={set('pft_score')} />
          </Field>
          <Field error={fieldErrors.cft_score} label="CFT" hint="Out of 300">
            <Input type="number" max={300} aria-label="CFT" value={profile.cft_score ?? ''} onChange={set('cft_score')} />
          </Field>
          <Field label="Rifle">
            <Select
              value={profile.rifle_qual || ''}
              onValueChange={set('rifle_qual')}
              placeholder="Not set"
              options={RIFLE_QUALS.map((q) => ({ value: q, label: q }))}
            />
          </Field>
          <Field label="PME for grade">
            <Select
              value={profile.pme_complete || ''}
              onValueChange={set('pme_complete')}
              placeholder="Not complete"
              options={[
                { value: '', label: 'Not complete' },
                { value: 'distance', label: 'Distance education' },
                { value: 'resident', label: 'Resident' },
              ]}
            />
          </Field>
        </div>
        {dirty && (
          <div className="mt-3 flex justify-end border-t border-rule pt-3">
            <Button variant="primary" size="sm" onClick={save}>
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        )}
      </Panel>

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-text-3">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Coverage hints are keyword guesses over your own entries — possible supporting evidence, never a mark. Your
        FITREP is written by your Reporting Senior and the official record lives on MOL. The FITREP input itself is on
        the Reports page, built from these same entries.
      </p>

      <ReferencesPanel entries={[EVAL_REFERENCES.fitrep, EVAL_REFERENCES.pftcft]} />
    </div>
  );
}

function JepesReadiness() {
  const activities = useActivities();
  const identity = useIdentity();
  const toast = useToast();

  const [profile, setProfile] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    apiClient.readiness().then(setProfile).catch(() => setProfile({}));
  }, []);

  const set = (k) => (v) => {
    setProfile((p) => ({ ...p, [k]: v?.target ? v.target.value : v }));
    setFieldErrors((f) => { const n = { ...f }; delete n[k]; return n; });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.saveReadiness(profile);
      setDirty(false);
      setFieldErrors({});
      toast.success('Readiness saved.');
    } catch (err) {
      setFieldErrors(err.fieldErrors || {});
      toast.error(errorText(err));
    }
    finally { setSaving(false); }
  };

  const mine = useMemo(
    () => activities.filter((a) => a.user_id === identity?.user?.id),
    [activities, identity]
  );

  const activityStats = useMemo(() => {
    const thinAreas = JEPES_CORE.filter((area) => !mine.some((a) => a.jepes_area === area));
    return {
      total: mine.length,
      withOutcome: mine.filter((a) => a.result).length,
      thinAreas,
    };
  }, [mine]);

  const est = useMemo(() => (profile ? estimate(profile) : null), [profile]);
  const recs = useMemo(() => (profile ? recommend(profile, activityStats) : []), [profile, activityStats]);
  const lever = useMemo(() => (profile ? biggestLever(profile) : null), [profile]);

  if (!profile) return <p className="text-sm text-text-3">Loading readiness…</p>;

  return (
    <div className="mx-auto max-w-[1100px] space-y-3">
      <PageHeader
        title="JEPES readiness"
        subtitle={`${identity?.user?.rank?.abbr || ''} ${identity?.user?.last_name || ''} · preparation dashboard · ${EVAL_REFERENCES.jepes.citation} · the official score is on MOL`}
      >
        {dirty && (
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </PageHeader>

      {/* ── the four pillars, as input status — never as points (finding 19) ── */}
      <Panel
        title="Where you stand"
        subtitle={`${Math.round(est.completeness * 4)} of 4 pillars have data · the score itself is computed by HQMC on MOL`}
        action={<Badge tone="info">No estimated score, by design</Badge>}
      >
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p) => {
            const pillar = est.pillars[p.key];
            return (
              <div key={p.key} className="rounded border border-rule bg-panel-2/40 px-3 py-2.5">
                <p className="eyebrow">{p.label}</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-text-3">{p.composition}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pillar.items.map((it) => <StateChip key={it.key} it={it} />)}
                </div>
              </div>
            );
          })}
        </div>

        {lever && (
          <p className="mt-3 flex items-start gap-2 border-t border-rule pt-3 text-sm leading-relaxed text-text-2">
            <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
            <span>
              Most open ground: <span className="text-text">{lever.label}</span> — {lever.gaps} input{lever.gaps === 1 ? '' : 's'} missing
              or flagged. Three of the four pillars are entirely yours to move; only Command Input needs someone else.
              That read is Vantage coaching, not a score.
            </span>
          </p>
        )}
      </Panel>

      {/* ── ranked recommendations ── */}
      <Panel
        title="What to do next"
        subtitle="Policy pointers, your own data, and Vantage's coaching — labeled apart, with no invented point values"
        bodyClassName="p-0"
      >
        {recs.length === 0 ? (
          <EmptyState icon={Target} title="Nothing to suggest yet" description="Fill in your figures below." />
        ) : (
          recs.map((r) => (
            <div key={r.id} className="row px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-base text-text">{r.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-text-2">{r.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <KindChip kind={r.kind} />
                  <p className={cn('fig mt-1 text-2xs', EFFORT_TONE[r.effort])}>{EFFORT_LABEL[r.effort]}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </Panel>

      {/* ── inputs ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Warfighting" subtitle="ARQ classification and MCMAP belt">
          <div className="grid grid-cols-2 gap-3">
            <Field error={fieldErrors.rifle_qual} label="Rifle qualification">
              <Select
                value={profile.rifle_qual || ''}
                onValueChange={set('rifle_qual')}
                placeholder="Not set"
                options={RIFLE_QUALS.map((q) => ({ value: q, label: q }))}
              />
            </Field>
            <Field error={fieldErrors.rifle_score} label="Entry-level table score" hint="Optional · 0–350 is the entry-level tables; the ARQ has no point total">
              <Input type="number" value={profile.rifle_score ?? ''} onChange={set('rifle_score')} />
            </Field>
            <Field error={fieldErrors.mcmap_belt} label="MCMAP belt" className="col-span-2">
              <Select
                value={profile.mcmap_belt || ''}
                onValueChange={set('mcmap_belt')}
                placeholder="Not set"
                options={MCMAP_BELTS.map((b) => ({ value: b, label: b }))}
              />
            </Field>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-text-3">
            ARQ bands (MCO 3574.2M): {ARQ_BANDS.map((b) => `${b.qual} — ${b.band}`).join('. ')}.
          </p>
        </Panel>

        <Panel title="Physical Toughness" subtitle="Raw scores 0–300 — JEPES converts them against peers on MOL">
          <div className="grid grid-cols-2 gap-3">
            <Field error={fieldErrors.pft_score} label="PFT score" hint="Out of 300">
              <Input type="number" max={300} aria-label="PFT score" value={profile.pft_score ?? ''} onChange={set('pft_score')} />
            </Field>
            <Field error={fieldErrors.cft_score} label="CFT score" hint="Out of 300">
              <Input type="number" max={300} aria-label="CFT score" value={profile.cft_score ?? ''} onChange={set('cft_score')} />
            </Field>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-text-3">
            The CFT is the more commonly neglected of the two. Movement-to-contact and maneuver-under-fire are
            anaerobic and skill-dependent — they respond to sprint work and rehearsing the course, not to more time
            under the bar. From 1 Jan 2026, combat-arms PMOS Marines score on the male age-normed tables with a 210
            minimum (MARADMIN 613/25).
          </p>
        </Panel>

        <Panel title="Mental Agility" subtitle="MarineNet CEUs, education, and MOS quals — qual points live on MOL (MARADMIN 046/24)">
          <div className="grid grid-cols-2 gap-3">
            <Field error={fieldErrors.ceus} label="MarineNet CEUs">
              <Input type="number" step="0.5" value={profile.ceus ?? ''} onChange={set('ceus')} />
            </Field>
            <Field error={fieldErrors.college_credits} label="College credits">
              <Input type="number" step="0.5" value={profile.college_credits ?? ''} onChange={set('college_credits')} />
            </Field>
            <Field label="Degree">
              <Select
                value={profile.degree || ''}
                onValueChange={set('degree')}
                placeholder="None yet"
                options={[
                  { value: '', label: 'None yet' },
                  { value: 'associate', label: 'Associate' },
                  { value: 'bachelor', label: 'Bachelor' },
                ]}
              />
            </Field>
            <Field label="PME for grade">
              <Select
                value={profile.pme_complete || ''}
                onValueChange={set('pme_complete')}
                placeholder="Not complete"
                options={[
                  { value: '', label: 'Not complete' },
                  { value: 'distance', label: 'Distance education' },
                  { value: 'resident', label: 'Resident' },
                ]}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Command Input" subtitle="Three marks from your chain, 0.0–5.0 · meets expectations centers 2.0–3.0">
          <div className="grid grid-cols-3 gap-3">
            <Field error={fieldErrors.cmd_character} label="Character">
              <Input type="number" step="0.1" min={0} max={5} value={profile.cmd_character ?? ''} onChange={set('cmd_character')} />
            </Field>
            <Field error={fieldErrors.cmd_mos} label="MOS / Mission">
              <Input type="number" step="0.1" min={0} max={5} value={profile.cmd_mos ?? ''} onChange={set('cmd_mos')} />
            </Field>
            <Field error={fieldErrors.cmd_leadership} label="Leadership">
              <Input type="number" step="0.1" min={0} max={5} value={profile.cmd_leadership ?? ''} onChange={set('cmd_leadership')} />
            </Field>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-text-3">
            This is the quarter of your score someone else controls. Marks move when a reporting senior has specific,
            quantified accomplishments in front of them — take your bullet package to counselling rather than arriving
            empty-handed.
          </p>
        </Panel>
      </div>

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-text-3">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Vantage organizes evidence; it does not compute a JEPES score. The official conversion is percentile-based
        against your peer group and the point tables live in MCO 1616.1's appendix on MOL — which is why no number is
        shown here. Use this page to decide where to spend the next three months, then read the real score on MOL.
      </p>

      <ReferencesPanel entries={[EVAL_REFERENCES.jepes, EVAL_REFERENCES.arq, EVAL_REFERENCES.mcmap, EVAL_REFERENCES.pftcft]} />

      {dirty && (
        <div className="sticky bottom-3 flex justify-end">
          <Button variant="primary" size="md" onClick={save} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save readiness'}
          </Button>
        </div>
      )}
    </div>
  );
}
