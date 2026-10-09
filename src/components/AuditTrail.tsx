import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import * as api from '@/lib/api';
import { formatStamp, humanize } from '@/lib/utils';

export interface AuditRow {
  id: string; seq: number; at: string; action: string; actor_username: string | null; subject_username: string | null; entity: string | null; entity_id: string | null;
  unit_id: string | null; detail: string | null; ip: string | null;
  /** A Unit Instance's trail also names people, and marks what Vantage staff did in it. */
  actor_name?: string | null; subject_name?: string | null; actor_is_staff?: number | null;
}
export interface AuditPage { rows: AuditRow[]; next: number | null; chain: { ok: boolean; count: number; reason?: string } | null; actions: string[] | null }
export interface AuditFilter { q: string; action: string; from: string; to: string; unit: string }
const NO_FILTER: AuditFilter = { q: '', action: '', from: '', to: '', unit: '' };

/**
 * One audit trail, filtered and paged on the server so nothing older than a page is out of reach, and downloaded as a
 * file the server records (ADR-0011, ADR-0012). The Vantage Administrator console shows the platform's; the Unit Manager
 * console shows its Unit Instance's, with a unit filter.
 */
export default function AuditTrail({ queryKey, load, exportUrl, fileStem, units, empty }: {
  queryKey: readonly unknown[];
  load: (filter: Partial<AuditFilter> & { limit: number; before?: number }) => Promise<AuditPage>;
  exportUrl: (filter: Partial<AuditFilter>, format: 'csv' | 'json') => string;
  fileStem: string;
  /** The units the trail can be narrowed to; none hides the filter. */
  units?: Array<{ id: string; name: string }>;
  empty: string;
}) {
  const [draft, setDraft] = useState<AuditFilter>(NO_FILTER);
  const [filter, setFilter] = useState<AuditFilter>(NO_FILTER);
  const sent = Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) as Partial<AuditFilter>;
  const { data, isPending, error, refetch } = useQuery<AuditPage>({ queryKey: [...queryKey, 'audit', sent], queryFn: () => withSudo(() => load({ ...sent, limit: 200 })), retry: false });
  const [older, setOlder] = useState<{ rows: AuditRow[]; next: number | null }>({ rows: [], next: null });
  const [loading, setLoading] = useState(''); const [actions, setActions] = useState<string[]>([]);
  const toast = useToast();
  useEffect(() => { setOlder({ rows: [], next: null }); if (data?.actions) setActions(data.actions); }, [data]);
  const filtered = Object.values(filter).some(Boolean);
  // The filter stays on screen while a page loads or fails, so focus stays put and Clear is always at hand.
  const form = (
    <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setFilter({ ...draft, q: draft.q.trim() }); }}>
      <Field label="Search" className="min-w-[12rem] flex-1"><Input placeholder={units ? 'Action, detail, name, username, IP or ID' : 'Action, detail, username, IP or ID'} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} maxLength={80} /></Field>
      <Field label="Action" className="w-52"><Select aria-label="Action" value={draft.action || 'all'} onValueChange={(v) => setDraft({ ...draft, action: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'Every action' }, ...actions.map((a) => ({ value: a, label: humanize(a) }))]} /></Field>
      {units && <Field label="Unit" className="w-48"><Select aria-label="Unit" value={draft.unit || 'all'} onValueChange={(v) => setDraft({ ...draft, unit: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'Every unit' }, ...units.map((u) => ({ value: u.id, label: u.name }))]} /></Field>}
      <Field label="From (UTC)" className="w-40"><Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
      <Field label="To (UTC)" className="w-40"><Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
      <Button type="submit" variant="primary">Apply</Button>
      {filtered && <Button type="button" variant="ghost" onClick={() => { setDraft(NO_FILTER); setFilter(NO_FILTER); }}>Clear</Button>}
    </form>
  );
  if (isPending) return <>{form}<Skeleton className="h-64" /></>;
  if (error || !data) return <>{form}<div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div></>;
  const rows = [...data.rows, ...older.rows];
  const next = older.rows.length ? older.next : data.next;
  const loadOlder = async () => {
    if (!next) return;
    setLoading('older');
    try { const page = await withSudo(() => load({ ...sent, limit: 200, before: next })); setOlder({ rows: [...older.rows, ...page.rows], next: page.next }); }
    catch (e) { toast.error(api.errorText(e)); } finally { setLoading(''); }
  };
  const download = async (format: 'csv' | 'json') => {
    setLoading(format);
    try { const name = await withSudo(() => api.downloadFile(exportUrl(sent, format), `${fileStem}.${format}`)); toast.success(`Downloaded ${name}. The download is in the audit trail.`); }
    catch (e) { toast.error(api.errorText(e)); } finally { setLoading(''); }
  };
  const who = (r: AuditRow) => r.actor_name?.trim() || r.actor_username || (units ? 'Vantage' : 'system');
  return (
    <>
      {form}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {data.chain && <Badge tone={data.chain.ok ? 'good' : 'bad'}>{data.chain.ok ? `Chain intact · ${data.chain.count} entries` : 'Chain broken'}</Badge>}
        <span className="text-xs text-ink-3">{rows.length} shown{filtered ? ', filtered' : ''}, newest first</span>
        <span className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => download('csv')} loading={loading === 'csv'}><Download className="h-3.5 w-3.5" />CSV</Button><Button size="sm" variant="ghost" onClick={() => download('json')} loading={loading === 'json'}><Download className="h-3.5 w-3.5" />JSON</Button></span>
      </div>
      {data.chain && !data.chain.ok && <p className="mb-3 text-sm text-bad">{data.chain.reason}. {units ? 'Tell Vantage support: the trail is kept for every Unit Instance at once.' : 'Restore from a backup taken before that point and investigate.'}</p>}
      <div className="card" style={{ overflow: 'hidden' }}>
        {!rows.length ? <EmptyState title="Nothing matches" description={filtered ? 'Try a wider date range or another action.' : empty} /> : (
          <Table minWidth={900} head={<><th className="w-14">#</th><th className="w-40">When</th><th className="w-36">Actor</th><th className="w-44">Action</th><th className="w-32">Subject</th><th className="w-28">Unit</th><th>Detail</th><th className="w-28">IP</th></>}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="fig text-xs text-ink-3">{r.seq}</td>
                <td className="fig text-xs text-ink-3">{formatStamp(r.at)}</td>
                <td className="text-xs">{who(r)}{r.actor_is_staff ? <Badge tone="warn" className="ml-1">Vantage staff</Badge> : null}</td>
                <td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}</td>
                <td className="text-xs">{r.subject_name?.trim() || r.subject_username || ''}</td>
                <td className="text-xs text-ink-3">{r.unit_id || ''}</td>
                <td className="max-w-xs truncate text-xs text-ink-2" title={r.detail ?? ''}>{r.detail}</td>
                <td className="fig text-2xs text-ink-3">{r.ip || ''}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      {next && <div className="mt-3 flex justify-center"><Button onClick={loadOlder} loading={loading === 'older'}>Load older</Button></div>}
    </>
  );
}
