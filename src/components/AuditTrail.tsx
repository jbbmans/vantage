import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table, useParam } from '@/components/common';
import { QueryFailure } from '@/components/QueryFailure';
import { PersonChip, ShowOnlyPerson, personNamed } from '@/components/PersonFilter';
import { useFocusWhenShown } from '@/lib/keyboard';
import * as api from '@/lib/api';
import { formatStamp, humanize } from '@/lib/utils';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, isAuditCategory } from '../../shared/auditCatalog';
import { rangeProblems, type RangeProblem } from '../../shared/dateRange';

export interface AuditRow {
  id: string; seq: number; at: string; action: string; actor_username: string | null; subject_username: string | null; entity: string | null; entity_id: string | null;
  unit_id: string | null; detail: string | null; ip: string | null; actor_id?: string | null; subject_id?: string | null;
  /** User activity, unit administration or enterprise administration (ADR-0013); null only for an action nobody catalogued. */
  category?: string | null;
  /** A Unit Instance's trail also names people, and marks what Vantage staff did in it. */
  actor_name?: string | null; subject_name?: string | null; actor_is_staff?: number | null;
}
export interface AuditPage { rows: AuditRow[]; next: number | null; chain: { ok: boolean; count: number; reason?: string } | null; actions: string[] | null }
/** The filter the form sets. One person, by id, comes from the address (`?person=`) or from a name in an entry. */
export interface AuditFilter { q: string; action: string; category: string; from: string; to: string; unit: string; person?: string }
const NO_FILTER: AuditFilter = { q: '', action: '', category: '', from: '', to: '', unit: '' };
const CATEGORY_OPTIONS = [{ value: 'all', label: 'All' }, ...AUDIT_CATEGORIES.map((c) => ({ value: c, label: AUDIT_CATEGORY_LABELS[c] }))];
const categoryLabel = (c: string | null | undefined) => (isAuditCategory(c) ? AUDIT_CATEGORY_LABELS[c] : 'Uncategorised');
const PAGE = 200;
const rowId = (id: string) => `audit-entry-${id}`;
const PERSON_CHIP = 'audit-person';
const SEARCH = 'audit-search';
/**
 * Where focus goes when the chip or Clear takes itself off the page: the Apply button, which is always there and takes
 * no text, so a phone opens no keyboard.
 */
const APPLY = 'audit-apply';

/**
 * One audit trail, filtered and paged on the server so nothing older than a page is out of reach, and downloaded as a
 * file the server records (ADR-0011, ADR-0012). The Vantage Administrator console shows the platform's; the Unit Manager
 * console shows its Unit Instance's, with a unit filter. Either can be narrowed to one person's entries, what they did
 * and what was done about them, from a name in an entry or a link that carries `?person=`.
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
  const [rangeError, setRangeError] = useState<RangeProblem['fieldErrors'] | null>(null);
  const [person, setPerson] = useParam('person');
  // The person's name: from the entry they were picked in, or from the first page that names them. It is kept while
  // another page loads and when a page holds nothing of theirs. Opened from a link to someone no page has named yet,
  // the chip says only that one person's entries are shown.
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const focusWhenShown = useFocusWhenShown();
  const sent = Object.fromEntries(Object.entries({ ...filter, person }).filter(([, v]) => v)) as Partial<AuditFilter>;
  // The pages read so far stay until the reader asks for a fresh read (Refresh, or another filter): coming back to the
  // window does not fold the list back to its first page and lose their place, and it does not ask for the chain again.
  const trail = useInfiniteQuery({
    queryKey: [...queryKey, 'audit', sent],
    queryFn: ({ pageParam }) => withSudo(() => load({ ...sent, limit: PAGE, ...(pageParam ? { before: pageParam } : {}) })),
    initialPageParam: null as number | null,
    getNextPageParam: (last: AuditPage) => last.next,
    staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const [loading, setLoading] = useState(''); const [actions, setActions] = useState<string[]>([]);
  const toast = useToast();
  // A first page that nothing narrows but the person carries the trail's actions; any other filter keeps the list it was given.
  const listed = trail.data?.pages[0]?.actions;
  useEffect(() => { if (listed) setActions(listed); }, [listed]);
  const rows = useMemo(() => (trail.data?.pages ?? []).flatMap((p) => p.rows), [trail.data]);
  const who = (r: AuditRow) => r.actor_name?.trim() || r.actor_username || (units ? 'Vantage' : 'system');
  const subjectOf = (r: AuditRow) => r.subject_name?.trim() || r.subject_username || '';
  const chain = trail.data?.pages[0]?.chain ?? null;
  const filtered = Object.values(filter).some(Boolean) || Boolean(person);
  const pick = (id: string, name: string) => { setPicked({ id, name }); setPerson(id); focusWhenShown(PERSON_CHIP); };
  const named = person ? personNamed(rows, person, who, subjectOf) : '';
  useEffect(() => { if (person && named) setPicked((p) => (p?.id === person && p.name === named ? p : { id: person, name: named })); }, [person, named]);
  // Show everyone, and Clear, each take their own button off the page: focus goes to Apply, not the page body.
  const everyone = () => { setPerson(''); focusWhenShown(APPLY); };
  // A date range the server would refuse, or one it did refuse, is said at the field it is about, not instead of the list.
  const fieldErrors = trail.error instanceof api.ApiError ? trail.error.fieldErrors : null;
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    // Both days or neither, in order and within the span every range keeps (ADR-0038), checked before anything is sent.
    const problem = draft.from || draft.to ? rangeProblems(draft.from, draft.to, { required: true }) : null;
    if (problem) { setRangeError(problem.fieldErrors); return; }
    setRangeError(null);
    setFilter({ ...draft, q: draft.q.trim() });
  };
  // The filter stays on screen while a page loads or fails, so focus stays put and Clear is always at hand.
  const form = (
    <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={apply} noValidate>
      <Field label="Search" className="min-w-[12rem] flex-1"><Input id={SEARCH} placeholder={units ? 'Action, detail, name, username, IP or ID' : 'Action, detail, username, IP or ID'} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} maxLength={80} /></Field>
      <Field label="Category" className="w-52"><Select aria-label="Category" value={draft.category || 'all'} onValueChange={(v) => setDraft({ ...draft, category: v === 'all' ? '' : v })} options={CATEGORY_OPTIONS} /></Field>
      <Field label="Action" className="w-52"><Select aria-label="Action" value={draft.action || 'all'} onValueChange={(v) => setDraft({ ...draft, action: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'Every action' }, ...actions.map((a) => ({ value: a, label: humanize(a) }))]} /></Field>
      {units && <Field label="Unit" className="w-48"><Select aria-label="Unit" value={draft.unit || 'all'} onValueChange={(v) => setDraft({ ...draft, unit: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'Every unit' }, ...units.map((u) => ({ value: u.id, label: u.name }))]} /></Field>}
      <Field label="From (UTC)" className="w-40" error={rangeError?.from ?? fieldErrors?.from}><Input type="date" value={draft.from} onChange={(e) => { setRangeError(null); setDraft({ ...draft, from: e.target.value }); }} /></Field>
      <Field label="To (UTC)" className="w-40" error={rangeError?.to ?? fieldErrors?.to}><Input type="date" value={draft.to} onChange={(e) => { setRangeError(null); setDraft({ ...draft, to: e.target.value }); }} /></Field>
      <Button id={APPLY} type="submit" variant="primary">Apply</Button>
      {filtered && <Button type="button" variant="ghost" onClick={() => { setRangeError(null); setDraft(NO_FILTER); setFilter(NO_FILTER); everyone(); }}>Clear</Button>}
      {person && <PersonChip id={PERSON_CHIP} name={named || (picked?.id === person ? picked.name : '')} onClear={everyone} />}
    </form>
  );
  if (trail.isPending) return <>{form}<Skeleton className="h-64" /></>;
  if (trail.isError && !trail.data) {
    if (fieldErrors?.from || fieldErrors?.to) return form;
    return <>{form}<QueryFailure error={trail.error} onRetry={() => trail.refetch()} what="The audit trail" /></>;
  }
  const loadOlder = async () => {
    const before = rows.length;
    const result = await trail.fetchNextPage();
    // Focus moves to the first entry the page added, so it is not lost when the button goes after the last page.
    const added = (result.data?.pages ?? []).flatMap((p) => p.rows)[before];
    if (added) window.requestAnimationFrame(() => document.getElementById(rowId(added.id))?.focus());
  };
  const download = async (format: 'csv' | 'json') => {
    setLoading(format);
    try { const name = await withSudo(() => api.downloadFile(exportUrl(sent, format), `${fileStem}.${format}`)); toast.success(`Downloaded ${name}. The download is in the audit trail.`); }
    catch (e) { toast.error(api.errorText(e)); } finally { setLoading(''); }
  };
  const refreshing = trail.isFetching && !trail.isFetchingNextPage;
  return (
    <>
      {form}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {chain && <Badge tone={chain.ok ? 'good' : 'bad'}>{chain.ok ? `Chain intact · ${chain.count} entries` : 'Chain broken'}</Badge>}
        <span className="text-xs text-ink-3" role="status" aria-live="polite">{rows.length} shown{filtered ? ', filtered' : ''}, newest first</span>
        <span className="ml-auto flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => trail.refetch()} loading={refreshing}><RefreshCw className="h-3.5 w-3.5" aria-hidden />Refresh</Button>
          <Button size="sm" variant="ghost" onClick={() => download('csv')} loading={loading === 'csv'}><Download className="h-3.5 w-3.5" aria-hidden />Export CSV</Button>
          <Button size="sm" variant="ghost" onClick={() => download('json')} loading={loading === 'json'}><Download className="h-3.5 w-3.5" aria-hidden />Export JSON</Button>
        </span>
      </div>
      {chain && !chain.ok && <p className="mb-3 text-sm text-bad">{chain.reason}. {units ? 'Tell Vantage support: the trail is kept for every Unit Instance at once.' : 'Restore from a backup taken before that point and investigate.'}</p>}
      {trail.isRefetchError && <p className="mb-2 text-xs text-warn" role="alert">The last refresh failed, so this list may be out of date. {api.errorText(trail.error)}</p>}
      <div className="card" style={{ overflow: 'hidden' }}>
        {!rows.length ? <EmptyState title="Nothing matches" description={!filtered ? empty : person && !Object.values(filter).some(Boolean) ? 'No entry in this trail is by or about this person.' : 'Try a wider date range, another category or another action.'} /> : (
          <Table label="Audit entries, newest first" minWidth={900} head={<><th className="w-14">#</th><th className="w-40">When</th><th className="w-36">Actor</th><th className="w-44">Action and category</th><th className="w-32">Subject</th><th className="w-28">Unit</th><th>Detail</th><th className="w-28">IP</th></>}>
            {rows.map((r) => (
              <tr key={r.id} id={rowId(r.id)} tabIndex={-1}>
                <td className="fig text-xs text-ink-3">{r.seq}</td>
                <td className="fig text-xs text-ink-3">{formatStamp(r.at)}</td>
                <td className="text-xs">{who(r)}{r.actor_is_staff ? <Badge tone="warn" className="ml-1">Vantage staff</Badge> : null}{r.actor_id && r.actor_id !== person ? <ShowOnlyPerson name={who(r)} onPick={() => pick(r.actor_id!, who(r))} /> : null}</td>
                <td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}<span className="block text-2xs text-ink-3">{categoryLabel(r.category)}</span></td>
                <td className="text-xs">{subjectOf(r)}{r.subject_id && r.subject_id !== person ? <ShowOnlyPerson name={subjectOf(r)} onPick={() => pick(r.subject_id!, subjectOf(r))} /> : null}</td>
                <td className="text-xs text-ink-3">{r.unit_id || ''}</td>
                {/* Wrapped in full, never cut to one line: a hash or an approval note is read here, by touch and keyboard too. */}
                <td className="min-w-[14rem] text-xs text-ink-2 [overflow-wrap:anywhere]">{r.detail}</td>
                <td className="fig text-2xs text-ink-3">{r.ip || ''}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      {trail.isFetchNextPageError && <p className="mt-3 text-sm text-bad" role="alert">Older entries could not load. {api.errorText(trail.error)}</p>}
      {trail.hasNextPage && <div className="mt-3 flex justify-center"><Button onClick={loadOlder} loading={trail.isFetchingNextPage}>{trail.isFetchNextPageError ? 'Try again' : 'Load older'}</Button></div>}
    </>
  );
}
