import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BookmarkPlus, FileText, Play, Printer, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Segmented, Select, Skeleton, Switch } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import DownloadMenu, { type DownloadChoice } from '@/components/DownloadMenu';
import ReportDocumentView from '@/components/ReportDocumentView';
import { PageShell, PeriodSelect } from '@/components/common';
import { can, useIdentity, useMetrics, useTeam } from '@/lib/queries';
import { usePlace } from '@/lib/place';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api';
import { PERMISSIONS } from '../../shared/permissions';
import { EVAL_AREAS, TRAINING_TYPES } from '../../shared/constants';
import { PROCEDURE_LIST } from '../../shared/procedures';
import { PERIOD_OPTIONS } from '../../shared/metrics';
import {
  CASE_STATES, CUSTOM_DATASETS, PERSONNEL_STATUSES, REPORT_GROUPS, REPORT_SPECS, REPORT_TYPES, TRAINING_STATUSES, isReportType,
  type ReportFileFormat, type ReportSpec, type ReportSubject, type ReportType,
} from '../../shared/reportCatalog';

type Params = Record<string, string>;

const SUBJECT_LABEL: Record<ReportSubject, string> = { self: 'You', member: 'A Marine', unit: 'A unit' };
const FILE_LABEL: Record<ReportFileFormat, [string, string]> = {
  pdf: ['PDF', 'Laid out for paper, as the print page'],
  csv: ['Spreadsheet (CSV)', 'The main table'],
  xlsx: ['Excel workbook', 'Every table, a sheet each, and what the report is about'],
  json: ['Vantage file (JSON)', 'The whole report as data'],
};
const humanize = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The query a report runs with: its type, whom it is about, and only the filters it takes. */
function cleanParams(form: Params, spec: ReportSpec): Params {
  const out: Params = { type: spec.key, subject: form.subject };
  if (form.subject === 'member' && form.user_id) out.user_id = form.user_id;
  // A unit's report names its unit; a Marine's keeps the unit it was asked about, whose shared records it reads.
  if ((form.subject === 'unit' || form.subject === 'member') && form.unit_id) out.unit_id = form.unit_id;
  const keys = spec.filters.flatMap((f) => (f === 'sort' ? ['sort', 'direction'] : [f]));
  for (const k of keys) if (form[k]) out[k] = form[k];
  return out;
}

/**
 * Every report Vantage prints and files, in one place (ADR-0020): choose one, whom it is about and its filters, see
 * it, print it on a page laid out for paper, or take it as a PDF, a spreadsheet, a workbook or JSON. Whether you may
 * see it, and which files you may take, is the server's to say; what it says is shown with the report.
 */
export default function ReportLibrary() {
  const place = usePlace();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const metrics = useMetrics();
  const { data: team } = useTeam(Boolean(identity?.canLead));
  const [search, setSearch] = useSearchParams();
  const initialType = isReportType(search.get('type')) ? (search.get('type') as ReportType) : 'individual';
  const [form, setForm] = useState<Params>(() => Object.fromEntries(search.entries()));
  const [type, setType] = useState<ReportType>(initialType);
  const spec = REPORT_SPECS[type];
  const [ran, setRan] = useState<Params | null>(() => (search.get('type') ? cleanParams(withDefaults(Object.fromEntries(search.entries()), REPORT_SPECS[initialType], null), REPORT_SPECS[initialType]) : null));
  const [saving, setSaving] = useState(false);

  const units = useMemo(() => (identity?.views || []).filter((v) => v.level === 'full' || can(identity, PERMISSIONS.MANAGE_MEMBERS, v.id)), [identity]);
  const marines = useMemo(() => (team?.roster || []).filter((p) => p.canOpen && p.id !== identity?.user.id)
    .map((p) => ({ value: p.id, label: [p.rank_abbr, `${p.last_name}, ${p.first_name}`].filter(Boolean).join(' ') })), [team, identity]);
  const subjects = spec.subjects.filter((s) => (s === 'member' ? marines.length > 0 : s === 'unit' ? units.length > 0 : true));
  const startUnit = units.find((u) => u.id === identity?.defaultViewId)?.id ?? units[0]?.id ?? null;
  const chosen = withDefaults(form, spec, startUnit);
  // Whom it is about falls back to someone this person may choose: a link may name a Marine before the roster has loaded.
  const f = subjects.includes(chosen.subject as ReportSubject) || !subjects.length ? chosen : { ...chosen, subject: subjects[0] };
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const dataset = CUSTOM_DATASETS[f.dataset] || CUSTOM_DATASETS.activities;
  const columns = (f.columns || dataset.defaults.join(',')).split(',').filter((c) => dataset.columns.some((x) => x.key === c));

  const run = useQuery({
    queryKey: ['report-center', 'run', ran], queryFn: () => api.runReport(ran!), enabled: Boolean(ran),
    // Reading a Marine's or a unit's report is audited, so it is read when asked for, not again on every focus. Nothing
    // is kept once another is run, so running one again, or opening a saved one, reads it afresh.
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false,
  });
  const definitions = useQuery({ queryKey: ['report-center', 'definitions'], queryFn: api.reportDefinitions });

  const go = (params: Params) => {
    setSearch(params, { replace: true });
    if (JSON.stringify(params) === JSON.stringify(ran)) run.refetch(); else setRan(params);
  };
  const choose = (next: ReportType) => { setType(next); setForm((p) => ({ subject: REPORT_SPECS[next].subjects.includes(p.subject as ReportSubject) ? p.subject : '', user_id: p.user_id || '', unit_id: p.unit_id || '' })); };
  const open = (d: api.ReportDefinitionRow) => {
    if (!isReportType(d.type)) return;
    const s = REPORT_SPECS[d.type];
    const next = withDefaults({ ...d.params }, s, startUnit);
    setType(d.type); setForm(next); go(cleanParams(next, s));
  };
  const remove = async (d: api.ReportDefinitionRow) => {
    try { await api.deleteReportDefinition(d.id); toast.success(`Deleted ${d.name}.`); qc.invalidateQueries({ queryKey: ['report-center', 'definitions'] }); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const params = cleanParams(f, spec);
  const doc = run.data;
  const files: DownloadChoice[] = (doc?.files || []).map((fmt) => ({ label: FILE_LABEL[fmt][0], hint: FILE_LABEL[fmt][1], url: api.reportFileUrl(ran!, fmt), fallback: `vantage-report.${fmt}` }));
  const print = () => { window.open(`/reports/print?${new URLSearchParams({ ...ran!, autoprint: '1' })}`, '_blank', 'noopener'); };

  return (
    <PageShell eyebrow={place.group} title="Report library" lede="Every report Vantage prints and files: yours, a Marine’s you lead, or a unit’s. Choose one, whom it is about and its filters, then print it or take it as a file.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_1fr]">
        <nav aria-label="Reports" className="space-y-4">
          {REPORT_GROUPS.map((g) => (
            <div key={g}>
              <h2 className="eyebrow mb-1.5">{g}</h2>
              <ul className="space-y-1">
                {REPORT_TYPES.filter((t) => REPORT_SPECS[t].group === g).map((t) => (
                  <li key={t}>
                    <button type="button" aria-current={t === type ? 'true' : undefined} onClick={() => choose(t)}
                      className={cn('w-full rounded-md border px-3 py-2 text-left transition-colors', t === type ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-2')}>
                      <span className="block text-sm font-medium text-ink">{REPORT_SPECS[t].title}</span>
                      <span className="block text-xs leading-snug text-ink-3">{REPORT_SPECS[t].question}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <SavedReports rows={definitions.data} loading={definitions.isPending} onOpen={open} onDelete={remove} />
        </nav>

        <div className="min-w-0 space-y-4">
          <Panel title={spec.title} subtitle={spec.question}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {subjects.length > 1 ? (
                <div className="sm:col-span-2 xl:col-span-3">
                  <p className="mb-1.5 text-base font-medium text-ink">About</p>
                  <Segmented label="Whom the report is about" value={f.subject as ReportSubject} onChange={(v) => setForm((p) => ({ ...p, subject: v, ...(v === 'member' ? { unit_id: '' } : {}) }))} options={subjects.map((s) => ({ value: s, label: SUBJECT_LABEL[s] }))} />
                </div>
              ) : null}
              {f.subject === 'member' ? <Field label="Marine"><Select value={f.user_id} onValueChange={(v) => setForm((p) => ({ ...p, user_id: v, unit_id: '' }))} options={marines} placeholder="Choose a Marine" /></Field> : null}
              {f.subject === 'unit' ? <Field label="Unit" hint="With the units beneath it"><Select value={f.unit_id} onValueChange={(v) => set('unit_id', v)} options={units.map((u) => ({ value: u.id, label: `${' '.repeat(Math.min(u.depth, 4))}${u.short_name || u.name}` }))} placeholder="Choose a unit" /></Field> : null}
              {spec.filters.includes('period') ? <Field label="Period"><PeriodSelect value={f.period} onChange={(v) => set('period', v)} /></Field> : null}
              {spec.filters.includes('track') ? <Field label="Evaluation"><Select value={f.track || 'auto'} onValueChange={(v) => set('track', v === 'auto' ? '' : v)} options={[{ value: 'auto', label: 'By rank' }, { value: 'jepes', label: 'JEPES' }, { value: 'fitrep', label: 'FITREP' }]} /></Field> : null}
              {spec.filters.includes('category') ? <Field label="Category"><Select value={f.category} onValueChange={(v) => set('category', v)} options={[{ value: '', label: 'Every category' }, ...metrics.categories.map((c) => ({ value: c.name, label: c.name }))]} /></Field> : null}
              {spec.filters.includes('area') ? <Field label="Area"><Select value={f.area} onValueChange={(v) => set('area', v)} options={[{ value: '', label: 'Every area' }, ...EVAL_AREAS.map((a) => ({ value: a, label: a }))]} /></Field> : null}
              {spec.filters.includes('kind') ? <Field label="Type"><Select value={f.kind} onValueChange={(v) => set('kind', v)} options={[{ value: '', label: 'Every type' }, ...TRAINING_TYPES.map((t) => ({ value: t, label: t === 'pme' ? 'PME' : humanize(t) }))]} /></Field> : null}
              {spec.filters.includes('status') ? <Field label={type === 'personnel' ? 'Who' : 'Standing'}><Select value={f.status || 'all'} onValueChange={(v) => set('status', v === 'all' ? '' : v)} options={[...(type === 'personnel' ? PERSONNEL_STATUSES : TRAINING_STATUSES)]} /></Field> : null}
              {spec.filters.includes('as_of') ? <Field label="Standing on" hint="Today when blank"><Input type="date" value={f.as_of} onChange={(e) => set('as_of', e.target.value)} /></Field> : null}
              {spec.filters.includes('procedure') ? <Field label="Procedure"><Select value={f.procedure} onValueChange={(v) => set('procedure', v)} options={[{ value: '', label: 'Every procedure' }, ...PROCEDURE_LIST.map((p) => ({ value: p.key, label: p.short })), { value: 'none', label: 'No procedure' }]} /></Field> : null}
              {spec.filters.includes('state') ? <Field label="Cases"><Select value={f.state || 'open'} onValueChange={(v) => set('state', v)} options={[...CASE_STATES]} /></Field> : null}
              {spec.filters.includes('overdue') ? <div className="self-end"><Switch checked={f.overdue === '1'} onChange={(v) => set('overdue', v ? '1' : '')} label="Only overdue cases" /></div> : null}
              {spec.filters.includes('dataset') ? (
                <Field label="Records">
                  <Select value={dataset.key} onValueChange={(v) => setForm((p) => ({ ...p, dataset: v, columns: '', group: '', sort: '' }))}
                    options={Object.values(CUSTOM_DATASETS).filter((d) => !d.unitOnly || f.subject === 'unit').map((d) => ({ value: d.key, label: d.label }))} />
                </Field>
              ) : null}
              {spec.filters.includes('group') ? <Field label="Group by"><Select value={f.group} onValueChange={(v) => set('group', v)} options={[{ value: '', label: 'No grouping' }, ...dataset.groups.map((g) => ({ value: g, label: dataset.columns.find((c) => c.key === g)?.label || humanize(g) }))]} /></Field> : null}
              {spec.filters.includes('sort') ? (
                <Field label="Order by">
                  <div className="flex gap-2">
                    <Select className="min-w-0 flex-1" value={f.sort || dataset.sorts[0]} onValueChange={(v) => set('sort', v)} options={dataset.sorts.map((s) => ({ value: s, label: dataset.columns.find((c) => c.key === s)?.label || humanize(s) }))} />
                    <Segmented size="sm" label="Direction" value={(f.direction || 'desc') as 'asc' | 'desc'} onChange={(v) => set('direction', v)} options={[{ value: 'asc', label: 'Up', ariaLabel: 'Ascending' }, { value: 'desc', label: 'Down', ariaLabel: 'Descending' }]} />
                  </div>
                </Field>
              ) : null}
            </div>
            {spec.filters.includes('columns') ? (
              <fieldset className="mt-3">
                <legend className="mb-1.5 text-base font-medium text-ink">Columns</legend>
                <div className="flex flex-wrap gap-1.5">
                  {dataset.columns.filter((c) => c.key !== 'owner' || f.subject === 'unit').map((c) => {
                    const on = columns.includes(c.key);
                    return <button key={c.key} type="button" aria-pressed={on} onClick={() => set('columns', (on ? columns.filter((x) => x !== c.key) : [...columns, c.key]).join(','))}
                      className={cn('rounded-full border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent-soft/60 text-ink' : 'border-line text-ink-2 hover:bg-surface-2')}>{c.label}</button>;
                  })}
                </div>
              </fieldset>
            ) : null}
            {!subjects.length ? <p className="mt-3 text-sm text-ink-2" role="note">This report is about a unit, and you have none whose shared records you may view. Your own reports are under Your record.</p> : null}
            <p className="mt-3 text-xs text-ink-3">{spec.needs}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => go(params)} loading={run.isFetching} disabled={!subjects.length || (f.subject === 'member' && !f.user_id) || (f.subject === 'unit' && !f.unit_id)}><Play className="h-4 w-4" aria-hidden />Run report</Button>
              <Button onClick={() => setSaving(true)}><BookmarkPlus className="h-4 w-4" aria-hidden />Save these choices</Button>
            </div>
          </Panel>

          {!ran ? <div className="card"><EmptyState icon={FileText} title="Choose a report and run it" description="It shows here as it prints: its title, whom it is about, the period, the filters, then its figures and tables." /></div>
            : run.isPending ? <Skeleton className="h-96" />
              : run.error || !doc ? <div className="card"><EmptyState title="Could not run the report" description={api.errorText(run.error)} /></div> : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {doc.files.length < 4 ? <p className="mr-auto text-xs text-ink-3">{doc.files.length ? 'A PDF only: a spreadsheet or data file of someone else’s records needs the export permission in their unit.' : 'No file: taking a unit’s report away needs the export permission in that unit. It prints from here.'}</p> : null}
                    <Button onClick={print}><Printer className="h-4 w-4" aria-hidden />Print</Button>
                    {files.length ? <DownloadMenu choices={files} /> : null}
                  </div>
                  <ReportDocumentView doc={doc} />
                </div>
              )}
        </div>
      </div>
      <SaveDialog open={saving} onOpenChange={setSaving} type={type} params={params} units={units.filter((u) => can(identity, PERMISSIONS.VIEW_RECORDS, u.id) && identity?.unitIds.includes(u.id))} defaultUnit={f.subject === 'unit' ? f.unit_id : ''}
        onSaved={() => qc.invalidateQueries({ queryKey: ['report-center', 'definitions'] })} />
    </PageShell>
  );
}

/** A report's choices with what it starts on where they are not set: whom it is about, its period, its records. */
function withDefaults(form: Params, spec: ReportSpec, firstUnit: string | null): Params {
  const subject = spec.subjects.includes(form.subject as ReportSubject) ? form.subject : form.user_id && spec.subjects.includes('member') ? 'member' : spec.subjects.includes('self') ? 'self' : 'unit';
  return {
    ...form, subject,
    user_id: form.user_id || '', unit_id: form.unit_id || (subject === 'unit' ? firstUnit || '' : ''),
    period: form.period || spec.period || '', dataset: form.dataset || (spec.key === 'custom' ? 'activities' : ''),
  };
}

function SavedReports({ rows, loading, onOpen, onDelete }: { rows?: api.ReportDefinitionRow[]; loading: boolean; onOpen: (d: api.ReportDefinitionRow) => void; onDelete: (d: api.ReportDefinitionRow) => void }) {
  return (
    <div>
      <h2 className="eyebrow mb-1.5">Saved reports</h2>
      {loading ? <Skeleton className="h-16" /> : !rows?.length ? <p className="text-xs text-ink-3">Save a report’s choices to run it again in one step. Its records are read fresh each time.</p> : (
        <ul className="space-y-1">
          {rows.map((d) => (
            <li key={d.id} className="flex items-start gap-1 rounded-md border border-line px-2 py-1.5">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(d)}>
                <span className="block truncate text-sm text-ink">{d.name}</span>
                <span className="block truncate text-2xs text-ink-3">{isReportType(d.type) ? REPORT_SPECS[d.type].title : d.type}{d.mine ? '' : ` · ${d.owner_name || 'Shared'}`}</span>
              </button>
              {d.visibility === 'unit' ? <Badge tone="neutral" className="shrink-0">Shared</Badge> : null}
              {d.mine ? <Button size="xs" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => onDelete(d)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SaveDialog({ open, onOpenChange, type, params, units, defaultUnit, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; type: ReportType; params: Params; units: Array<{ id: string; name: string; short_name: string | null }>; defaultUnit: string; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = unit || (units.some((u) => u.id === defaultUnit) ? defaultUnit : units[0]?.id || '');
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { type: _type, ...rest } = params;
      await api.saveReportDefinition({ name, type, params: rest, visibility: share ? 'unit' : 'private', unit_id: share ? target : null });
      toast.success(`Saved ${name.trim()}.`); onSaved(); onOpenChange(false); setName(''); setShare(false);
    } catch (e) { setError(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Save these choices" description="The report, whom it is about and its filters, under a name. The records are read fresh each time it runs."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" error={error}><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={[REPORT_SPECS[type].title, PERIOD_OPTIONS.find((p) => p.value === params.period)?.label].filter(Boolean).join(', ')} /></Field>
        {units.length ? <Switch checked={share} onChange={setShare} label="Share with a unit" description="Its members see the choices and run it with their own authority. A shared report names no Marine." /> : null}
        {share ? <Field label="Unit"><Select value={target} onValueChange={setUnit} options={units.map((u) => ({ value: u.id, label: u.short_name || u.name }))} /></Field> : null}
      </div>
    </Dialog>
  );
}
