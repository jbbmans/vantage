import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IdCard, Upload, ShieldAlert, FileSearch, Download, AlertTriangle, Play } from 'lucide-react';
import { Button, Field, Input, Select, Textarea, Panel, Badge, Switch, Skeleton, Stat, EmptyState } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table, DateText } from '@/components/common';
import * as api from '@/lib/api';
import { downloadText, humanize, timeAgo } from '@/lib/utils';

function useAdmin<T = any>(key: string, fn: () => Promise<T>) {
  return useQuery<T>({ queryKey: ['admin', key], queryFn: () => withSudo(fn), retry: false });
}

// Personnel ---------------------------------------------------------------

/**
 * The roster feed. Planning is always offered before applying, and the plan is shown in full,
 * because the alternative is a button that silently rewrites a few thousand service records.
 */
export function PersonnelConsole() {
  const toast = useToast();
  const qc = useQueryClient();
  const stats = useAdmin('personnel', api.adminPersonnel);
  const gaps = useAdmin('personnel-divergence', api.adminPersonnelDivergence);
  const [text, setText] = useState('');
  const [source, setSource] = useState('MCTFS');
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin', 'personnel'] }); qc.invalidateQueries({ queryKey: ['admin', 'personnel-divergence'] }); };

  const run = async (apply: boolean, confirmSeparations = false) => {
    setBusy(true);
    try {
      const res = await withSudo(() => api.adminPersonnelSync(text, source, { apply, confirmSeparations }));
      setPlan(res.plan);
      if (apply) { toast.success('Roster applied.'); setText(''); refresh(); }
    } catch (e) {
      const payload = (e as any)?.payload || {};
      if (payload.code === 'mass_separation') { setPlan((p: any) => p); toast.error(api.errorText(e)); }
      else toast.error(api.errorText(e));
    } finally { setBusy(false); setConfirmApply(false); }
  };

  if (stats.isPending) return <Skeleton className="h-64" />;
  if (stats.error) return <div className="card"><EmptyState icon={ShieldAlert} title="Could not load the roster" description={api.errorText(stats.error)} /></div>;

  const s = stats.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="On the roster" value={s.active.toLocaleString()} hint={`${s.separated.toLocaleString()} separated`} icon={IdCard} />
        <Stat label="Accounts the feed maintains" value={s.linkedAccounts.toLocaleString()} hint="their rank and unit are read-only to them" />
        <Stat label="Last sync" value={s.lastSync ? timeAgo(s.lastSync.at) : 'Never'} hint={s.lastSync ? `${s.lastSync.source}: +${s.lastSync.created} ~${s.lastSync.updated} -${s.lastSync.separated}` : 'no feed has run'} />
      </div>

      <Panel title="Load a roster extract" subtitle="CSV, TSV or JSON. The EDIPI column is required; everything else is matched by common header names.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr]">
          <Field label="Source" hint="named in the audit trail">
            <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="MCTFS" />
          </Field>
          <Field label="Extract" hint={`${text.split('\n').filter(Boolean).length.toLocaleString()} lines`}>
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="DoD ID,Last,First,Grade,PMOS,EAS,RUC&#10;1234567890,Boletz,John,Sgt,3451,2027-06-30,G8" className="font-mono text-xs" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => run(false)} loading={busy} disabled={!text.trim()}><FileSearch className="h-4 w-4" />See what would change</Button>
          <Button variant="primary" disabled={!plan || busy || !text.trim()} onClick={() => setConfirmApply(true)}><Upload className="h-4 w-4" />Apply this roster</Button>
        </div>
      </Panel>

      {plan && (
        <Panel title="What this extract would do" subtitle={`${plan.rowsSeen.toLocaleString()} rows read from ${plan.source}`}>
          {plan.massSeparation && (
            <div className="card mb-3 border-warn/50 bg-warn/5 p-3" role="alert">
              <p className="flex items-center gap-2 text-base font-semibold text-ink"><AlertTriangle className="h-4 w-4 text-warn" />This would separate {plan.massSeparation.count} of {plan.massSeparation.activeBefore} people</p>
              <p className="mt-1 text-sm text-ink-2">That usually means the extract is partial rather than that the command emptied. Those people are held back; nothing about them changes unless you confirm.</p>
              <Button className="mt-2" onClick={() => run(true, true)} loading={busy}>The extract really is the whole command — separate them</Button>
            </div>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge tone="good">{plan.counts.creates} new</Badge>
            <Badge tone="accent">{plan.counts.updates} changed</Badge>
            <Badge tone={plan.counts.separations ? 'warn' : 'neutral'}>{plan.counts.separations} separated</Badge>
            <Badge tone="neutral">{plan.unchanged} unchanged</Badge>
            {plan.counts.conflicts > 0 && <Badge tone="bad">{plan.counts.conflicts} need a person</Badge>}
            {plan.counts.rejected > 0 && <Badge tone="bad">{plan.counts.rejected} rejected rows</Badge>}
          </div>
          {plan.updates.length > 0 && (
            <div className="-mx-4 mb-3 -mt-1">
              <Table minWidth={520} head={<><th className="w-32">EDIPI</th><th>Name</th><th>Changes</th></>}>
                {plan.updates.map((u: any) => (
                  <tr key={u.edipi}><td className="mono text-xs">{u.edipi}</td><td>{u.name}</td>
                    <td className="text-xs text-ink-2">{u.changes.map((c: any) => `${humanize(c.field)}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}</td></tr>
                ))}
              </Table>
            </div>
          )}
          {plan.rejected.length > 0 && (
            <div className="card p-3">
              <p className="mb-1 text-base font-medium text-ink">Rows that could not be read</p>
              <ul className="space-y-0.5 text-xs text-ink-2">{plan.rejected.map((r: any) => <li key={r.line}>Line {r.line}: {r.reason}</li>)}</ul>
            </div>
          )}
          {plan.conflicts.length > 0 && (
            <div className="card mt-3 p-3">
              <p className="mb-1 text-base font-medium text-ink">Held for a person to look at</p>
              <ul className="space-y-0.5 text-xs text-ink-2">{plan.conflicts.map((c: any) => <li key={c.edipi}><span className="mono">{c.edipi}</span> — {c.reason}</li>)}</ul>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Where the roster and the accounts disagree" subtitle="Each of these is somebody whose record could drift. None of them is fixed automatically.">
        {gaps.isPending ? <Skeleton className="h-24" /> : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <GapList title="Accounts with no EDIPI" rows={gaps.data?.accountsWithoutEdipi || []} render={(r: any) => `${r.last_name}, ${r.first_name} (@${r.username})`} empty="Every account is linked." />
            <GapList title="Accounts the roster does not list" rows={gaps.data?.accountsWithoutRoster || []} render={(r: any) => `${r.last_name}, ${r.first_name} — ${r.edipi}`} empty="Every linked account is on the roster." />
            <GapList title="On the roster with no account" rows={gaps.data?.rosterWithoutAccount || []} render={(r: any) => `${r.last_name}, ${r.first_name} — ${r.rank_id || '—'}`} empty="Everyone on the roster has an account." />
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={confirmApply} onOpenChange={setConfirmApply}
        title="Apply this roster?"
        body={`${plan?.counts.creates || 0} people added, ${plan?.counts.updates || 0} records changed, ${plan?.counts.separations || 0} separated. Changed fields stop being editable by the people they belong to.`}
        confirmLabel="Apply the roster" onConfirm={() => run(true)}
      />
    </div>
  );
}

function GapList({ title, rows, render, empty }: { title: string; rows: any[]; render: (r: any) => string; empty: string }) {
  return (
    <div>
      <p className="mb-1.5 text-base font-medium text-ink">{title} <span className="fig text-ink-3">{rows.length ? rows.length : ''}</span></p>
      {rows.length === 0 ? <p className="text-xs text-ink-3">{empty}</p> : (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto text-xs text-ink-2">
          {rows.slice(0, 100).map((r, i) => <li key={r.id || r.edipi || i} className="truncate">{render(r)}</li>)}
        </ul>
      )}
    </div>
  );
}

// Retention ---------------------------------------------------------------

export function RetentionConsole() {
  const toast = useToast();
  const qc = useQueryClient();
  const data = useAdmin('retention', api.adminRetention);
  const [draft, setDraft] = useState<any>(null);
  const [holdDraft, setHoldDraft] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'retention'] });

  const save = async (schedule: any) => {
    try { await withSudo(() => api.adminSaveSchedule(schedule)); toast.success('Schedule saved.'); setDraft(null); setPreview(null); refresh(); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const run = async (apply: boolean) => {
    setBusy(true);
    try {
      const res = await withSudo(() => api.adminRunDisposition(apply));
      setPreview(res);
      if (res.blocked) toast.error(res.blocked);
      else if (apply) { toast.success('Disposition applied.'); refresh(); }
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); setConfirmRun(false); }
  };

  if (data.isPending) return <Skeleton className="h-64" />;
  if (data.error) return <div className="card"><EmptyState icon={ShieldAlert} title="Could not load retention" description={api.errorText(data.error)} /></div>;

  const { schedules, retainableTypes, holds, history } = data.data;
  const holdableTypes: string[] = data.data.holdableTypes || retainableTypes;
  const byType = new Map(schedules.map((s: any) => [s.record_type, s]));
  const pendingCount: number = (preview?.lines || []).reduce((n: number, l: any) => n + (l.disposition === 'review' ? 0 : l.eligible), 0);
  const wouldAct = Boolean(preview) && !preview.blocked && pendingCount > 0;

  return (
    <div className="space-y-4">
      {holds.some((h: any) => h.scope === 'instance') && (
        <div className="card border-warn/50 bg-warn/5 p-3" role="alert">
          <p className="flex items-center gap-2 text-base font-semibold text-ink"><ShieldAlert className="h-4 w-4 text-warn" />An instance-wide legal hold is open</p>
          <p className="mt-1 text-sm text-ink-2">Nothing is disposed of while it stands, whatever the schedules below say.</p>
        </div>
      )}

      <Panel title="Retention schedules" subtitle="Each one is off until you turn it on. A schedule with no citation is somebody's guess, so the authority is a field rather than a note.">
        <div className="-mx-4 -mt-1">
          <Table minWidth={560} head={<><th>Record type</th><th className="w-28">Keep for</th><th className="w-32">Then</th><th>Authority</th><th className="w-24">Enabled</th><th className="w-16"></th></>}>
            {retainableTypes.map((type: string) => {
              const s: any = byType.get(type);
              return (
                <tr key={type}>
                  <td className="font-medium text-ink">{humanize(type)}</td>
                  <td className="fig text-xs">{s ? `${s.retain_days.toLocaleString()} days` : <span className="text-ink-3">not set</span>}</td>
                  <td className="text-xs">{s ? <Badge tone={s.disposition === 'destroy' ? 'bad' : s.disposition === 'anonymize' ? 'warn' : 'neutral'}>{humanize(s.disposition)}</Badge> : ''}</td>
                  <td className="text-xs text-ink-2">{s?.authority || ''}</td>
                  <td>{s ? <Badge tone={s.enabled ? 'good' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge> : ''}</td>
                  <td className="text-right"><Button size="xs" variant="ghost" onClick={() => setDraft(s ? { ...s, enabled: Boolean(s.enabled) } : { record_type: type, retain_days: 2555, disposition: 'review', authority: '', notes: '', enabled: false })}>{s ? 'Edit' : 'Set'}</Button></td>
                </tr>
              );
            })}
          </Table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => run(false)} loading={busy}><FileSearch className="h-4 w-4" />See what is eligible</Button>
          {/* Live only when a fresh preview shows records a schedule would actually act on. A
              destructive button that is clickable with nothing to do invites the click that has
              something to do later, against a stale preview. */}
          <Button variant="danger" disabled={busy || !wouldAct} onClick={() => setConfirmRun(true)}><Play className="h-4 w-4" />Run disposition</Button>
        </div>
      </Panel>

      {preview && !preview.blocked && (
        <Panel title="What disposition would do now">
          {preview.lines.length === 0 ? <p className="text-sm text-ink-3">No schedule is enabled, so there is nothing to run.</p> : (
            <div className="-mx-4 -mt-1">
              <Table minWidth={620} head={<><th>Record type</th><th className="w-32">Action</th><th className="w-28">Cutoff</th><th className="w-24 text-right">Eligible</th><th className="w-24 text-right">Held</th><th className="w-24 text-right">Acted</th></>}>
                {preview.lines.map((l: any) => (
                  <tr key={l.record_type}>
                    <td>{humanize(l.record_type)}{l.skipped && <span className="block text-xs text-warn">{l.skipped}</span>}</td>
                    <td className="text-xs">{humanize(l.disposition)}</td>
                    <td className="fig text-xs">{l.cutoff}</td>
                    <td className="fig text-right">{l.eligible.toLocaleString()}</td>
                    <td className="fig text-right text-ink-3">{l.held.toLocaleString()}</td>
                    <td className="fig text-right">{l.acted.toLocaleString()}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Legal holds" subtitle="A hold suspends disposition for what it covers and always wins over a schedule." action={<Button size="sm" onClick={() => setHoldDraft({ scope: 'instance', subject_id: '', record_type: '', reason: '' })}>Place a hold</Button>}>
        {holds.length === 0 ? <p className="text-sm text-ink-3">No holds are open.</p> : (
          <ul className="divide-y divide-line">
            {holds.map((h: any) => (
              <li key={h.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block text-base font-medium text-ink">{humanize(h.scope)}{h.record_type ? `: ${humanize(h.record_type)}` : ''}</span>
                  <span className="block text-xs text-ink-2">{h.reason}</span>
                  <span className="block text-2xs text-ink-3">placed {timeAgo(h.placed_at)}</span>
                </span>
                <Button size="xs" variant="ghost" onClick={async () => { try { await withSudo(() => api.adminReleaseHold(h.id)); toast.success('Hold released.'); refresh(); } catch (e) { toast.error(api.errorText(e)); } }}>Release</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Disposition history" subtitle="Every run, including the ones that removed nothing. A log with gaps cannot answer the question it exists for.">
        {history.length === 0 ? <p className="text-sm text-ink-3">Disposition has never run.</p> : (
          <div className="-mx-4 -mt-1">
            <Table minWidth={620} head={<><th className="w-40">When</th><th>Record type</th><th className="w-28">Action</th><th className="w-24 text-right">Eligible</th><th className="w-24 text-right">Acted</th><th className="w-20">Mode</th></>}>
              {history.map((r: any) => (
                <tr key={r.id}>
                  <td className="text-xs"><DateText value={r.at} /></td>
                  <td>{humanize(r.record_type)}</td>
                  <td className="text-xs">{humanize(r.disposition)}</td>
                  <td className="fig text-right">{r.eligible.toLocaleString()}</td>
                  <td className="fig text-right">{r.acted.toLocaleString()}</td>
                  <td><Badge tone={r.dry_run ? 'neutral' : 'accent'}>{r.dry_run ? 'Preview' : 'Applied'}</Badge></td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Panel>

      {draft && (
        <ConfirmDialog
          open onOpenChange={() => setDraft(null)}
          title={`Retention for ${humanize(draft.record_type)}`}
          confirmLabel="Save schedule"
          onConfirm={() => save({ ...draft, retain_days: Number(draft.retain_days) })}
          body={
            <div className="space-y-3">
              <Field label="Keep for" hint="days from the record's own date"><Input value={String(draft.retain_days)} onChange={(e) => setDraft({ ...draft, retain_days: e.target.value.replace(/[^0-9]/g, '') })} /></Field>
              <Field label="Then">
                <Select value={draft.disposition} onValueChange={(v) => setDraft({ ...draft, disposition: v })}
                  options={[{ value: 'review', label: 'Report only — never acts on its own' }, { value: 'anonymize', label: 'Anonymize — keep the counts, drop the words' }, { value: 'destroy', label: 'Destroy — remove the row' }]} />
              </Field>
              <Field label="Authority" hint="the schedule this comes from"><Input value={draft.authority || ''} onChange={(e) => setDraft({ ...draft, authority: e.target.value })} placeholder="NARA GRS 2.2, item 010" /></Field>
              <Switch checked={Boolean(draft.enabled)} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Enabled" description="Off means this schedule is recorded but never runs." />
            </div>
          }
        />
      )}

      {holdDraft && (
        <ConfirmDialog
          open onOpenChange={() => setHoldDraft(null)}
          title="Place a legal hold"
          confirmLabel="Place the hold"
          onConfirm={async () => { try { await withSudo(() => api.adminPlaceHold({ ...holdDraft, subject_id: holdDraft.subject_id || null, record_type: holdDraft.record_type || null })); toast.success('Hold placed.'); setHoldDraft(null); refresh(); } catch (e) { toast.error(api.errorText(e)); } }}
          body={
            <div className="space-y-3">
              <Field label="Covers">
                <Select value={holdDraft.scope} onValueChange={(v) => setHoldDraft({ ...holdDraft, scope: v })}
                  options={[{ value: 'instance', label: 'Everything on this instance' }, { value: 'record_type', label: 'One kind of record' }, { value: 'user', label: 'One person' }]} />
              </Field>
              {holdDraft.scope === 'record_type' && (
                <Field label="Record type"><Select value={holdDraft.record_type} onValueChange={(v) => setHoldDraft({ ...holdDraft, record_type: v })} options={holdableTypes.map((t: string) => ({ value: t, label: humanize(t) }))} /></Field>
              )}
              {holdDraft.scope === 'user' && <Field label="Account id" hint="from the Accounts tab"><Input value={holdDraft.subject_id} onChange={(e) => setHoldDraft({ ...holdDraft, subject_id: e.target.value })} /></Field>}
              <Field label="Reason" required><Textarea rows={2} value={holdDraft.reason} onChange={(e) => setHoldDraft({ ...holdDraft, reason: e.target.value })} placeholder="IG inquiry 2026-14" /></Field>
            </div>
          }
        />
      )}

      <ConfirmDialog
        open={confirmRun} onOpenChange={setConfirmRun} danger
        title="Run disposition now?"
        body={`This acts on ${pendingCount.toLocaleString()} records and cannot be undone.`}
        confirmLabel="Run disposition" onConfirm={() => run(true)}
      />
    </div>
  );
}

// Privacy -----------------------------------------------------------------

export function PrivacyConsole() {
  const inv = useAdmin('privacy-inventory', api.adminPrivacyInventory);
  const [open, setOpen] = useState<string | null>(null);
  if (inv.isPending) return <Skeleton className="h-64" />;
  if (inv.error) return <div className="card"><EmptyState icon={ShieldAlert} title="Could not build the inventory" description={api.errorText(inv.error)} /></div>;
  const data = inv.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Tables holding personal data" value={data.summary.piiTables} hint={`of ${data.summary.tables} in the database`} icon={FileSearch} />
        <Stat label="Unclassified columns" value={data.summary.unclassifiedColumns} tone={data.summary.unclassifiedColumns ? 'warn' : 'good'} hint="each one is a question a PIA cannot answer yet" />
        <Stat label="Declared but absent" value={data.summary.staleColumns} tone={data.summary.staleColumns ? 'warn' : 'good'} hint="the declaration has drifted from the schema" />
      </div>

      <Panel
        title="Data inventory"
        subtitle="Built from the live database every time it is opened, so it cannot quietly stop being true the way a written document does."
        action={<Button onClick={async () => { const md = await withSudo(() => fetch('/api/admin/privacy/inventory?format=markdown', { credentials: 'same-origin', headers: { 'x-vantage-client': '1' } }).then((r) => r.text())); downloadText('vantage-data-inventory.md', md); }}><Download className="h-4 w-4" />Export for the PIA</Button>}
      >
        <div className="-mx-4 -mt-1">
          <Table minWidth={680} head={<><th>Table</th><th className="w-24 text-right">Rows</th><th>Purpose</th><th className="w-40">Retention</th><th className="w-24">Gaps</th></>}>
            {data.tables.map((t: any) => (
              <tr key={t.table} className="cursor-pointer" onClick={() => setOpen(open === t.table ? null : t.table)}>
                <td className="font-medium text-ink">{t.table}</td>
                <td className="fig text-right text-xs">{t.rows < 0 ? '—' : t.rows.toLocaleString()}</td>
                <td className="text-xs text-ink-2">{t.purpose || <span className="text-warn">not declared</span>}</td>
                <td className="text-xs">{t.retention ? `${t.retention.retain_days}d ${t.retention.disposition}${t.retention.enabled ? '' : ' (off)'}` : <span className="text-ink-3">none</span>}</td>
                <td>{t.unclassified.length || t.stale.length ? <Badge tone="warn">{t.unclassified.length + t.stale.length}</Badge> : <Badge tone="good">—</Badge>}</td>
              </tr>
            ))}
          </Table>
        </div>
        {open && (() => {
          const t = data.tables.find((x: any) => x.table === open);
          if (!t) return null;
          return (
            <div className="card mt-3 p-4">
              <p className="text-md font-semibold text-ink">{t.table}</p>
              <dl className="mt-2 space-y-1.5 text-sm">
                <div><dt className="inline font-medium text-ink">Authority: </dt><dd className="inline text-ink-2">{t.authority || 'not declared'}</dd></div>
                <div><dt className="inline font-medium text-ink">Who can see it: </dt><dd className="inline text-ink-2">{t.access || 'not declared'}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.columns.map((c: any) => (
                  <Badge key={c.column} tone={c.category === 'unclassified' ? 'warn' : c.category === 'authentication' ? 'bad' : c.category === 'none' || c.category === 'technical' ? 'neutral' : 'accent'}>
                    {c.column} · {c.category}
                  </Badge>
                ))}
              </div>
              {t.stale.length > 0 && <p className="mt-2 text-xs text-warn">Declared but no longer in the schema: {t.stale.join(', ')}</p>}
            </div>
          );
        })()}
      </Panel>
    </div>
  );
}
