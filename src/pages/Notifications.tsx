import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, CircleHelp, Settings2 } from 'lucide-react';
import { PageHeader, Panel, Button, Badge, EmptyState, Select, Segmented, Skeleton, Tabs, type Tone } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { QueryFailure } from '@/components/QueryFailure';
import { useParam } from '@/components/common';
import { keys, useMyRequests, useNotifications } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, formatStamp, timeAgo } from '@/lib/utils';
import {
  GROUP_HINTS, GROUP_LABELS, NOTICE_GROUPS, NOTICE_KINDS, NOTICE_RETENTION_DAYS, isMutableGroup, isNoticeKind,
  type NoticeGroup, type NoticeRow, type NoticesResponse,
} from '../../shared/notifications';
import { REQUEST_KIND_LABELS, REQUEST_STATE_LABELS, type RequestState, type RequestSummary } from '../../shared/workflowMessages';

/**
 * Everything Vantage told this person, and what they were asked (ADR-0031). A notice names what happened, who did it and
 * the record, never anybody's words: what was said is on the record, behind its permissions. Two tabs, kept in the
 * address (?tab=notices or ?tab=asked) so the bell and Today can open either.
 */
type Tab = 'notices' | 'asked';
const TABS: Tab[] = ['notices', 'asked'];
/** Where Settings lists what can be turned off. */
const SETTINGS = '/settings?tab=notifications';
const PAGE_SIZE = 20;

export default function Notifications() {
  const [tabParam, setTab] = useParam('tab', 'notices');
  const tab: Tab = (TABS as string[]).includes(tabParam) ? (tabParam as Tab) : 'notices';
  // The counts beside the tabs are the bell's: the same query, so they never disagree.
  const unread = useNotifications().data?.unread;
  const waiting = useMyRequests().data?.asked_of_you.length;
  return (
    <div className="page page-narrow">
      <PageHeader
        title="Notifications"
        lede={`What happened on records you are part of, and what you were asked. A notice says what happened and where; what anyone wrote is on the record itself. Notices are kept for ${NOTICE_RETENTION_DAYS} days.`}
      >
        <Button variant="ghost" asChild><Link to={SETTINGS}><Settings2 className="h-4 w-4" aria-hidden />Choose what you are told</Link></Button>
      </PageHeader>
      <Tabs value={tab} onChange={(v) => setTab(v)} className="mb-4" tabs={[
        { value: 'notices', label: 'Notices', count: unread || undefined },
        { value: 'asked', label: 'Asked of you / You asked', count: waiting || undefined },
      ]} />
      {tab === 'notices' ? <Notices /> : <Asked />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Notices

type Show = 'all' | 'unread';
const isGroup = (value: string): value is NoticeGroup => (NOTICE_GROUPS as readonly string[]).includes(value);
/** A link inside the application, which the router can follow. The server sends no other kind, and this keeps it so. */
const inApp = (url: string | null): string | null => (url && url.startsWith('/') && !url.startsWith('//') ? url : null);
/** "3 new comments", for a notice that stands for more than one event. */
function manyText(n: NoticeRow): string | null {
  if (!isNoticeKind(n.kind) || !n.count || n.count < 2) return null;
  const spec = NOTICE_KINDS[n.kind];
  return 'many' in spec ? `${n.count} ${spec.many}` : null;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A polite status line that says something once, then clears, so the same words can be said again later. Two things
 * said together ("Marked read." as a refresh brings "1 new notice") are both kept.
 */
function useStatus(): [string, (text: string) => void] {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!text) return;
    const t = window.setTimeout(() => setText(''), 8000);
    return () => window.clearTimeout(t);
  }, [text]);
  const say = useCallback((next: string) => setText((said) => (!said || said.includes(next) ? next : `${said} ${next}`)), []);
  return [text, say];
}

function Notices() {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showParam, setShow] = useParam('show', 'all');
  const [groupParam, setGroup] = useParam('group', 'all');
  const show: Show = showParam === 'unread' ? 'unread' : 'all';
  const group: NoticeGroup | null = isGroup(groupParam) ? groupParam : null;
  const view = `${show}:${group ?? 'all'}`;
  const [status, say] = useStatus();
  const [marking, setMarking] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Under ['notifications'], so whatever refreshes the bell refreshes this list too; polled as the bell is.
  const list = useInfiniteQuery({
    queryKey: [...keys.notifications, 'page', show, group ?? 'all'],
    queryFn: ({ pageParam }) => api.notifications({ limit: PAGE_SIZE, cursor: pageParam, filter: show, group }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: NoticesResponse) => last.next_cursor,
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => {
    const ids = new Set<string>();
    return (list.data?.pages ?? []).flatMap((p) => p.rows).filter((r) => !ids.has(r.id) && (ids.add(r.id), true));
  }, [list.data]);
  const unread = list.data?.pages[0]?.unread ?? 0;

  // A refresh that brings unread notices that were not there says so. Older ones loaded by "Show more" are not new.
  const seen = useRef<{ view: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    const pages = list.data?.pages;
    if (!pages) return;
    const all = pages.flatMap((p) => p.rows);
    if (seen.current?.view !== view) { seen.current = { view, ids: new Set(all.map((r) => r.id)) }; return; }
    const known = seen.current.ids;
    const fresh = (pages[0]?.rows ?? []).filter((r) => !r.read_at && !known.has(r.id)).length;
    for (const r of all) known.add(r.id);
    if (fresh) say(plural(fresh, 'new notice', 'new notices'));
  }, [list.data, view, say]);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.notifications });

  // Following a notice marks it read first, then goes there in the application. A new tab is the browser's to open.
  const follow = async (event: React.MouseEvent<HTMLAnchorElement>, n: NoticeRow, to: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      if (!n.read_at) api.markRead(n.id).then(refresh, () => undefined);
      return;
    }
    event.preventDefault();
    if (!n.read_at) await api.markRead(n.id).catch(() => undefined);
    refresh();
    navigate(to);
  };

  const markOne = async (n: NoticeRow) => {
    setMarking(n.id);
    try {
      await api.markRead(n.id);
      await refresh();
      say('Marked read.');
      // The button is gone: focus stays on the notice, or on the list when the Unread view no longer shows it.
      window.requestAnimationFrame(() => (document.getElementById(`notice-${n.id}`) ?? listRef.current ?? headingRef.current)?.focus());
    } catch (e) { toast.error(api.errorText(e)); } finally { setMarking(null); }
  };

  const markAll = async () => {
    setMarking('all');
    try {
      const { updated } = await api.markAllRead(group);
      await refresh();
      const where = group ? ` in ${GROUP_LABELS[group]}` : '';
      toast.success(updated ? `${plural(updated, 'notice', 'notices')}${where} marked read.` : `Nothing${where} was unread.`);
    } catch (e) { toast.error(api.errorText(e)); } finally { setMarking(null); }
  };

  const empty = show === 'unread'
    ? { title: group ? `Nothing unread in ${GROUP_LABELS[group]}` : 'You are caught up', description: 'Nothing is unread. Choose All to see the notices you have read.' }
    : group
      ? { title: `Nothing in ${GROUP_LABELS[group]} yet`, description: GROUP_HINTS[group] }
      : { title: 'No notices yet', description: 'When someone asks you something, decides on your record, names you, or comments on a record you are part of, it is listed here.' };

  return (
    <section aria-labelledby="notices-heading">
      <h2 id="notices-heading" ref={headingRef} tabIndex={-1} className="sr-only">Notices</h2>
      <p role="status" aria-live="polite" className="sr-only">{status}</p>
      <div className="card mb-4 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Show" value={show} onChange={(v) => setShow(v)} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
          <Select aria-label="Group" className="max-sm:w-full sm:w-60" value={group ?? 'all'} onValueChange={setGroup}
            options={[{ value: 'all', label: 'All groups' }, ...NOTICE_GROUPS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))]} />
          <Button className="max-sm:w-full sm:ml-auto" onClick={markAll} loading={marking === 'all'} disabled={!unread || marking !== null}>
            <CheckCheck className="h-4 w-4" aria-hidden />Mark all read
          </Button>
        </div>
        {group && (
          <p className="text-xs leading-relaxed text-ink-3">
            {GROUP_HINTS[group]}{' '}
            {isMutableGroup(group) ? <>You can turn these off in <Link className="link" to={SETTINGS}>Settings → Notifications</Link>.</> : 'These always arrive.'}
          </p>
        )}
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : list.isError && !list.data ? (
        <QueryFailure error={list.error} onRetry={() => list.refetch()} what="Your notices" />
      ) : rows.length === 0 && !list.hasNextPage ? (
        <div className="card"><EmptyState icon={Bell} title={empty.title} description={empty.description} /></div>
      ) : (
        <>
          {list.isRefetchError && <p className="mb-2 text-xs text-warn" role="alert">The last refresh failed, so this list may be out of date. {api.errorText(list.error)}</p>}
          {rows.length > 0 && (
            <ul ref={listRef} tabIndex={-1} aria-label="Notices" className="card divide-y divide-line overflow-hidden focus:outline-none">
              {rows.map((n) => <NoticeItem key={n.id} n={n} onFollow={follow} onMarkRead={markOne} busy={marking === n.id} disabled={marking !== null} />)}
            </ul>
          )}
          {list.isFetchNextPageError && (
            <p className="mt-3 text-sm text-bad" role="alert">More notices could not load. {api.errorText(list.error)}</p>
          )}
          {list.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>{list.isFetchNextPageError ? 'Try again' : 'Show more'}</Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function NoticeItem({ n, onFollow, onMarkRead, busy, disabled }: {
  n: NoticeRow;
  onFollow: (event: React.MouseEvent<HTMLAnchorElement>, n: NoticeRow, to: string) => void;
  onMarkRead: (n: NoticeRow) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const unread = !n.read_at;
  const to = inApp(n.action_url);
  const many = manyText(n);
  const title = <>{unread && <Badge tone="accent" className="mr-2 align-middle">New</Badge>}{n.title}</>;
  return (
    <li id={`notice-${n.id}`} tabIndex={-1} className={cn('flex items-start gap-3 px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', unread && 'bg-accent-soft/40')}>
      <span className={cn('mt-2.5 badge-dot', unread ? 'bg-accent' : 'bg-line-strong')} aria-hidden />
      <div className="min-w-0 flex-1">
        {to
          ? <Link to={to} onClick={(e) => onFollow(e, n, to)} className={cn('tap flex items-center break-words text-sm hover:underline', unread ? 'font-semibold text-ink' : 'font-medium text-ink-2')}><span>{title}</span></Link>
          : <p className={cn('break-words text-sm', unread ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>{title}</p>}
        {n.label && !n.title.includes(n.label) && <p className="mt-0.5 break-words text-sm text-ink-2">{n.label}</p>}
        {many && many !== n.title && <p className="mt-0.5 text-xs text-ink-2">{many}</p>}
        {n.message && <p className="mt-0.5 whitespace-pre-line break-words text-sm text-ink-2">{n.message}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-3">
          <span>{GROUP_LABELS[n.group] ?? 'Notice'}</span>
          {n.org_name && <><span aria-hidden>·</span><span title="Unit Instance"><span className="sr-only">Unit Instance: </span>{n.org_name}</span></>}
          <span aria-hidden>·</span>
          <time dateTime={n.created_at} title={formatStamp(n.created_at)}>{timeAgo(n.created_at)}</time>
        </p>
      </div>
      {!to && unread && (
        <Button size="sm" className="shrink-0" onClick={() => onMarkRead(n)} loading={busy} disabled={disabled && !busy} aria-label={`Mark read: ${n.title}`}>Mark read</Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Asked of you / You asked

const STATE_TONES: Record<RequestState, Tone> = { open: 'accent', answered: 'good', looks_right: 'good', needs_changes: 'warn', withdrawn: 'neutral', closed: 'neutral' };
/** The first words of a request, on one line: enough to know which one it is, the rest is on the record. */
function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

function Asked() {
  const requests = useMyRequests();
  if (requests.isPending) return <div className="space-y-4" aria-hidden><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (requests.isError) return <QueryFailure error={requests.error} onRetry={() => requests.refetch()} what="Your questions and review requests" />;
  const { asked_of_you: asked, you_asked: sent } = requests.data;
  return (
    <div className="space-y-4">
      <Panel title="Asked of you" subtitle="Questions and review requests waiting on your answer. You answer on the record itself." padded={false}>
        {asked.length
          ? <ul className="divide-y divide-line">{asked.map((r) => <RequestItem key={r.id} r={r} side="asked" />)}</ul>
          : <EmptyState className="py-8" icon={CircleHelp} title="Nothing is waiting on you" description="When someone asks you a question about a record, or asks you to review one, it is listed here until you answer it." />}
      </Panel>
      <Panel title="You asked" subtitle="Questions and review requests you sent: open ones until they are answered, and answered or closed ones for 14 days." padded={false}>
        {sent.length
          ? <ul className="divide-y divide-line">{sent.map((r) => <RequestItem key={r.id} r={r} side="sent" />)}</ul>
          : <EmptyState className="py-8" icon={CircleHelp} title="You have not asked anyone" description="Ask a question or ask for review in a record’s discussion, and it is listed here with its answer." />}
      </Panel>
    </div>
  );
}

function RequestItem({ r, side }: { r: RequestSummary; side: 'asked' | 'sent' }) {
  const open = r.state === 'open';
  const words = excerpt(r.body);
  return (
    <li className="px-4 py-3 sm:px-5">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={r.kind === 'review_request' ? 'info' : 'neutral'}>{REQUEST_KIND_LABELS[r.kind]}</Badge>
        {side === 'sent' && <Badge tone={STATE_TONES[r.state]}>{REQUEST_STATE_LABELS[r.state]}</Badge>}
      </p>
      <Link to={r.url} className="tap mt-1 flex items-center break-words text-sm font-semibold text-ink hover:underline">{r.label}</Link>
      {words && <p className="break-words text-sm text-ink-2">{words}</p>}
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-3">
        <span>{side === 'asked' ? `Asked by ${r.author_name}` : `You asked ${r.addressee_name}`}</span>
        <span aria-hidden>·</span>
        <time dateTime={r.created_at} title={formatStamp(r.created_at)}>{timeAgo(r.created_at)}</time>
        {side === 'sent' && !open && r.closed_at && <><span aria-hidden>·</span><span>{REQUEST_STATE_LABELS[r.state]} <time dateTime={r.closed_at} title={formatStamp(r.closed_at)}>{timeAgo(r.closed_at)}</time></span></>}
      </p>
      {open && !r.can_answer && (
        <p className="mt-1.5 text-sm text-ink">
          {side === 'asked'
            ? 'You can no longer answer this. Whoever asked you can withdraw it.'
            : `${r.addressee_name} can no longer answer this. You can withdraw it on the record.`}
        </p>
      )}
    </li>
  );
}
