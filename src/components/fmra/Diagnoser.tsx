import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, FlaskConical, RotateCcw, Stethoscope } from 'lucide-react';
import { diagnose, sourceExamples, ERROR_OPTIONS, METHOD_LIST, type BalanceInput, type ErrorKind, type MethodKey } from '../../../shared/fmra';
import { parseMoney, centsToInput } from '../../../shared/money';
import { PROCEDURES } from '../../../shared/procedures';
import { Button, Field, Input, NumberInput, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';
import LifecycleBars from './LifecycleBars';
import DiagnosisView from './DiagnosisView';

type Phase = 'commitment' | 'obligation' | 'delivered' | 'paid';
const PHASES: Array<{ key: Phase; label: string; hint: string }> = [
  { key: 'commitment', label: 'Commitment', hint: 'Requisition' },
  { key: 'obligation', label: 'Obligation', hint: 'Award' },
  { key: 'delivered', label: 'Delivered', hint: 'Receipt / accrual' },
  { key: 'paid', label: 'Paid', hint: 'Disbursement' },
];
const FIELD_OF: Record<Phase, string> = { commitment: 'commitment_amount', obligation: 'obligation_amount', delivered: 'delivered_amount', paid: 'paid_amount' };
const LIFECYCLE_PROCEDURES = new Set(['ocmt_research', 'udou_research', 'dou_research', 'oto_research']);

interface State { method: MethodKey | ''; values: Record<Phase, string>; shown: Record<Phase, boolean>; age: string; error: string }
const EMPTY: State = { method: '', values: { commitment: '', obligation: '', delivered: '', paid: '' }, shown: { commitment: true, obligation: true, delivered: true, paid: true }, age: '', error: '' };

/**
 * The balance diagnoser: four figures in, the reference's reasoning out. Everything runs in the
 * browser from the shared knowledge base; nothing is sent anywhere until the person chooses to open
 * a case from it.
 */
export default function Diagnoser() {
  const [s, setS] = useState<State>(EMPTY);
  const [example, setExample] = useState<string | null>(null);
  const examples = useMemo(() => sourceExamples(), []);

  const input = useMemo<BalanceInput & { invalid: string[] }>(() => {
    const invalid: string[] = [];
    const cents = (p: Phase) => {
      if (!s.shown[p]) return null;
      const raw = s.values[p].trim();
      if (!raw) return null;
      const r = parseMoney(raw);
      if (!r.ok) { invalid.push(`${p}: ${r.error}`); return null; }
      return r.cents;
    };
    const [kind, key] = s.error ? s.error.split(':') : [null, null];
    return {
      method: s.method || null,
      commitment: cents('commitment'), obligation: cents('obligation'), delivered: cents('delivered'), paid: cents('paid'),
      ageDays: s.age.trim() ? Number(s.age) : null,
      error: kind && key ? { kind: kind as ErrorKind, key } : null,
      invalid,
    };
  }, [s]);
  const result = useMemo(() => diagnose(input), [input]);
  const anyEntered = PHASES.some((p) => s.values[p.key].trim() || !s.shown[p.key]) || Boolean(s.error);

  const load = (id: string) => {
    const ex = examples.find((e) => e.id === id);
    if (!ex) return;
    const fig = (v: number | null | undefined) => (v == null ? '' : centsToInput(v));
    setS({
      ...EMPTY,
      method: (ex.input.method || '') as MethodKey | '',
      values: { commitment: fig(ex.input.commitment), obligation: fig(ex.input.obligation), delivered: fig(ex.input.delivered), paid: fig(ex.input.paid) },
      shown: { commitment: ex.input.commitment != null, obligation: ex.input.obligation != null, delivered: ex.input.delivered != null, paid: ex.input.paid != null },
    });
    setExample(ex.explanation);
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section className="card self-start p-5" aria-label="The figures">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.015em] text-ink"><Stethoscope className="h-4 w-4 text-accent" aria-hidden />Diagnose a balance</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-3">Enter one document’s figures as the report shows them. Same document, line and scope for all four.</p>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Clear" onClick={() => { setS(EMPTY); setExample(null); }}><RotateCcw className="h-3.5 w-3.5" /></Button>
        </div>

        <div className="mt-5 space-y-4">
          <Field label="Purchase method" hint="Decides which evidence proves each phase">
            <Select value={s.method} onValueChange={(v) => setS((p) => ({ ...p, method: v === 'none' ? '' : v as MethodKey }))} placeholder="Not known" options={[{ value: 'none', label: 'Not known' }, ...METHOD_LIST.map((m) => ({ value: m.key, label: m.name }))]} />
          </Field>
          <div className="well space-y-3 p-3.5">
            {PHASES.map((p) => (
              <div key={p.key} className="grid grid-cols-[1fr_auto] items-end gap-2">
                <Field label={p.label} hint={p.hint}>
                  <NumberInput value={s.shown[p.key] ? s.values[p.key] : ''} disabled={!s.shown[p.key]} placeholder={s.shown[p.key] ? '0.00' : 'Not shown'}
                    onChange={(e) => { const v = e.target.value; setS((prev) => ({ ...prev, values: { ...prev.values, [p.key]: v } })); setExample(null); }} />
                </Field>
                <label className="mb-2 flex cursor-pointer items-center gap-1.5 text-xs text-ink-3" title="The report shows a dash: no amount, which is not the same as zero.">
                  <input type="checkbox" checked={!s.shown[p.key]} onChange={(e) => { const hide = e.target.checked; setS((prev) => ({ ...prev, shown: { ...prev.shown, [p.key]: !hide } })); setExample(null); }} />
                  Not shown
                </label>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
            <Field label="Exact report error" hint="If you have one">
              <Select value={s.error} onValueChange={(v) => setS((p) => ({ ...p, error: v === 'none' ? '' : v }))} placeholder="None"
                options={[{ value: 'none', label: 'None' }, ...ERROR_OPTIONS.flatMap((g) => g.options.map((o) => ({ value: `${g.kind}:${o.key}`, label: `${g.report} — ${o.label}` })))]} />
            </Field>
            <Field label="Age (days)"><NumberInput value={s.age} onChange={(e) => setS((p) => ({ ...p, age: e.target.value.replace(/[^\d]/g, '') }))} placeholder="—" /></Field>
          </div>
          {input.invalid.length > 0 && <p className="text-xs text-bad" role="alert">{input.invalid.join(' ')}</p>}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="eyebrow mb-2 flex items-center gap-1.5"><FlaskConical className="h-3 w-3" aria-hidden />The reference’s eight examples</p>
          <div className="flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <button key={ex.id} type="button" onClick={() => load(ex.id)} className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 hover:text-ink">
                {ex.condition.toUpperCase()} {ex.pattern}
              </button>
            ))}
          </div>
          {example && <p className="mt-2 text-xs text-ink-3">Classroom example, not a live balance: {example}</p>}
        </div>
      </section>

      <section className="card min-w-0 p-5 sm:p-6" aria-live="polite" aria-label="The reading">
        {!anyEntered || !result.ok ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center text-center">
            <LifecycleBars decorative figures={{ commitment: 100_000, obligation: 75_000, delivered: 40_000, paid: 25_000 }} className="w-full max-w-sm" />
            <p className="mt-6 text-lg font-semibold tracking-[-0.015em] text-ink">What is the balance telling you?</p>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-3">{anyEntered && !result.ok ? result.error : 'Enter the figures, or load one of the reference’s examples. The reading follows the order the FMRAC teaches: condition and evidence first, then the supported next action.'}</p>
          </div>
        ) : (
          <>
            <LifecycleBars figures={{ commitment: input.commitment ?? null, obligation: input.obligation ?? null, delivered: input.delivered ?? null, paid: input.paid ?? null }} travel={s.method === 'tdy'} />
            <div className="mt-6"><DiagnosisView d={result} /></div>
            {result.procedure && <OpenCase procedure={result.procedure} input={input} method={s.method} />}
          </>
        )}
      </section>
    </div>
  );
}

/** Turns a reading into a case under the fitting procedure, with the figures recorded as read. */
function OpenCase({ procedure, input, method }: { procedure: string; input: BalanceInput; method: MethodKey | '' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const [reference, setReference] = useState('');
  const [unit, setUnit] = useState('private');
  const [busy, setBusy] = useState(false);
  const def = PROCEDURES[procedure];
  if (!def) return null;
  const open = async () => {
    setBusy(true);
    try {
      const title = `${def.short}: ${reference.trim()}`;
      const item = await api.createWorkItem({ title, reference: reference.trim(), visibility: unit === 'private' ? 'private' : 'unit', unit_id: unit === 'private' ? null : unit });
      // Whoever reads the balance and opens the case is working it: it starts in their hands.
      await api.claimWorkItem(item.id, item.version);
      await api.applyProcedure(item.id, procedure);
      const key = `diag-${item.id}`;
      if (LIFECYCLE_PROCEDURES.has(procedure)) {
        if (method) await api.recordEntry(item.id, { kind: 'observation', field: 'purchase_method', value_text: method, step: 'observe_balances', system: 'OAS' }, `${key}-m`);
        for (const p of PHASES) {
          const cents = input[p.key];
          await api.recordEntry(item.id, cents == null
            ? { kind: 'observation', field: FIELD_OF[p.key], not_shown: true, step: 'observe_balances', system: 'OAS' }
            : { kind: 'observation', field: FIELD_OF[p.key], amount: centsToInput(cents), step: 'observe_balances', system: 'OAS' }, `${key}-${p.key}`);
        }
      }
      toast.success('The case is open and in your hands, with the figures recorded as you read them.');
      navigate(`/work/items/${item.id}`);
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  const units = identity?.memberships || [];
  return (
    <div className="mt-6 rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
      <p className="text-sm font-semibold text-ink">Work it as a case</p>
      <p className="mt-0.5 text-xs text-ink-3">Opens a case under <span className="font-medium text-ink-2">{def.title}</span>, with {LIFECYCLE_PROCEDURES.has(procedure) ? 'these figures recorded as read from OAS' : 'its steps ready'}, in your hands. The procedure keeps the order; you decide.</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field label="Document number"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. M67854-26-RC-00112" /></Field>
        <Field label="Where it goes">
          <Select value={unit} onValueChange={setUnit} options={[{ value: 'private', label: 'Private to me' }, ...units.map((m) => ({ value: m.unit_id, label: m.unit_short || m.unit_name }))]} />
        </Field>
        <Button variant="primary" loading={busy} disabled={!reference.trim()} onClick={open} className={cn('rounded-full pr-1.5')}>
          Open the case<span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15"><ArrowUpRight className="h-3.5 w-3.5" /></span>
        </Button>
      </div>
    </div>
  );
}
