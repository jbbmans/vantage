import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, ListChecks } from 'lucide-react';
import { Badge, Button, Field, Panel, Select, Textarea, type Tone } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { GuidanceList, RetireDialog } from '@/components/CaseGuidance';
import * as api from '@/lib/api';
import {
  SECTIONS, STATEMENT_LABELS, STATEMENT_LABEL_MEANING, STATEMENT_LABEL_TEXT,
  type CaseDiagnosis, type DiagnosisSection, type GuidanceSection, type Statement, type StatementLabel,
} from '../../shared/caseDiagnosis';
import { provenanceOf } from '../../shared/procedureTypes';
import type { ExampleState, GuidanceRecord } from '../../shared/caseGuidance';

/**
 * The case diagnosis (Task 16, ADR-0022) on the case page: the rule engine's reading of the case in the specification's
 * order, every statement labelled as a known fact, a derived value, a recommendation with its source and rank, an unknown,
 * or a decision for a person. No AI writes any of it.
 */

const LABEL_TONE: Record<StatementLabel, Tone> = {
  known_fact: 'neutral', derived_value: 'info', recommendation: 'accent', unknown: 'warn', decision_required: 'bad',
};

/** Sections open on first sight: what the case is, why, and what is missing and to research. */
const OPEN = new Set(['issue_type', 'probable_cause', 'missing_information', 'research']);

export function LabelChip({ label }: { label: StatementLabel }) {
  return <Badge tone={LABEL_TONE[label]} className="shrink-0" title={STATEMENT_LABEL_MEANING[label]}>{STATEMENT_LABEL_TEXT[label]}</Badge>;
}

function Source({ s }: { s: Statement }) {
  if (!s.basis) return null;
  const p = provenanceOf(s.basis.authority);
  const citation = s.basis.case_id
    ? <Link className="link" to={`/work/items/${s.basis.case_id}`}>{s.basis.citation}</Link>
    : s.basis.citation;
  return (
    <span className="block text-2xs text-ink-3">
      <span className="font-medium text-ink-2">{p.label}, rank {p.rank}</span>{citation ? <> · {citation}</> : null}{p.caution ? ` · ${p.caution}` : ''}
    </span>
  );
}

function StatementRow({ s }: { s: Statement }) {
  return (
    <li className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="sm:w-44 sm:shrink-0"><LabelChip label={s.label} /></span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm text-ink">{s.text}</span>
        {s.detail && <span className="block text-xs text-ink-2">{s.detail}</span>}
        {s.from && <span className="block text-2xs text-ink-3">{s.from}</span>}
        {s.how && <span className="block text-2xs text-ink-3">How: {s.how}</span>}
        <Source s={s} />
      </span>
    </li>
  );
}

function SectionBlock({ section }: { section: DiagnosisSection }) {
  const open = section.statements.filter((s) => s.label === 'unknown' || s.label === 'decision_required').length;
  return (
    <details open={OPEN.has(section.key)} className="group border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer items-center justify-between gap-3 py-2.5 text-sm font-semibold text-ink">
        <span>{section.title}</span>
        <span className="text-xs font-normal text-ink-3">{section.statements.length ? `${section.statements.length} ${section.statements.length === 1 ? 'statement' : 'statements'}${open ? `, ${open} open` : ''}` : 'Nothing to say yet'}</span>
      </summary>
      {section.statements.length > 0 && (
        <ul aria-label={section.title} className="divide-y divide-line/70 pb-2">
          {section.statements.map((s, i) => <StatementRow key={`${section.key}-${i}`} s={s} />)}
        </ul>
      )}
    </details>
  );
}

function Sources({ d }: { d: CaseDiagnosis }) {
  return (
    <details className="rounded-xl ring-1 ring-inset ring-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">Sources weighed, in order</summary>
      <ol aria-label="Sources weighed, in order" className="divide-y divide-line px-3 pb-2">
        {d.sources.map((p) => (
          <li key={p.authority} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1"><span className="font-medium text-ink">{p.rank}. {p.label}</span>{p.caution ? <span className="block text-ink-3">{p.caution}</span> : null}</span>
            <span className="text-ink-2">
              {p.used ? `${p.used} used here` : 'Not used here'}
              {p.on_file === 0 ? ' · none on file' : p.on_file ? ` · ${p.on_file} on file` : ''}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const EXAMPLE_SECTIONS = SECTIONS.filter((s) => s.key !== 'issue_type');

function ExampleBlock({ itemId, example, onChanged }: { itemId: string; example: ExampleState; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [section, setSection] = useState<GuidanceSection>('probable_cause');
  const [withdrawing, setWithdrawing] = useState<GuidanceRecord | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); toast.success(done); onChanged(); return true; } catch (e) { toast.error(api.errorText(e)); return false; }
  };
  if (example.current) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink"><BadgeCheck className="h-4 w-4 text-good" aria-hidden />A validated example for the next case like it</p>
        <GuidanceList entries={[example.current]} label="This case as an example" empty="" onRetire={example.may_withdraw ? setWithdrawing : undefined} retireLabel="Withdraw" />
        <RetireDialog entry={withdrawing} title="Withdraw this example" action="Withdraw it" onClose={() => setWithdrawing(null)}
          onRetire={async (reason) => { if (await run(() => api.withdrawCaseExample(itemId, reason), 'Example withdrawn. It is kept with your reason.')) setWithdrawing(null); }} />
      </div>
    );
  }
  if (!example.may_validate) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2/70 px-3.5 py-2.5 text-sm ring-1 ring-inset ring-line">
      <span className="min-w-0 flex-1 text-ink-2">This case was resolved and verified. A leader of its unit who did not resolve it may hold it up as an example for the next one like it.</span>
      <Button size="sm" onClick={() => setOpen(true)}><BadgeCheck className="h-4 w-4" />Validate as an example</Button>
      <Dialog open={open} onOpenChange={setOpen} size="md" title="Validate as an example"
        description="Diagnoses of cases of the same issue type in this Unit Instance will offer it, ranked below official guidance, the command’s SOPs and the training reference, and only to readers who may open this case."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!text.trim()} onClick={async () => { if (await run(() => api.validateCaseExample(itemId, { text: text.trim(), section }), 'Validated. Cases like it will offer it.')) { setOpen(false); setText(''); } }}>Validate</Button></>}>
        <div className="space-y-4">
          <Field label="What it shows the next person" required hint="What told the cause apart, and what fixed it. Up to 1,000 characters.">
            <Textarea rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Part of the diagnosis it speaks to">
            <Select value={section} onValueChange={(v) => setSection(v as GuidanceSection)} options={EXAMPLE_SECTIONS.map((s) => ({ value: s.key, label: s.title }))} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

export default function CaseDiagnosisPanel({ itemId, diagnosis: d, example, onChanged }: { itemId: string; diagnosis: CaseDiagnosis; example: ExampleState; onChanged: () => void }) {
  return (
    <Panel id="diagnosis" title="Diagnosis" subtitle="Worked out by rules from what is on this case and on file. No AI wrote it. Every statement says how it is known, and every recommendation names its source."
      action={<Badge title={`${d.engine.key} ${d.engine.version}, as of ${d.as_of}`}><ListChecks className="h-3.5 w-3.5" aria-hidden />Rules v{d.engine.version}</Badge>}>
      <div className="space-y-4">
        <p className="text-base font-medium leading-relaxed text-ink">{d.headline}</p>
        <ul aria-label="How each statement is known" className="flex flex-wrap gap-1.5">
          {STATEMENT_LABELS.map((l) => (
            <li key={l} className="flex items-center gap-1 text-xs text-ink-2"><LabelChip label={l} /><span className="fig">{d.counts[l]}</span></li>
          ))}
        </ul>
        <div>{d.sections.map((s) => <SectionBlock key={s.key} section={s} />)}</div>
        <Sources d={d} />
        {d.limits.length > 0 && (
          <ul aria-label="Limits of this diagnosis" className="space-y-1 text-xs text-ink-3">
            {d.limits.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
        <ExampleBlock itemId={itemId} example={example} onChanged={onChanged} />
      </div>
    </Panel>
  );
}
