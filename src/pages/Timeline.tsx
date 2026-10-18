import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Award, BadgeCheck, BookOpen, CalendarRange, GraduationCap, Info, MessagesSquare, NotebookPen, Plus, Target, type LucideIcon } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Skeleton } from '@/components/ui/primitives';
import { DateText, StatusBadge, useParam } from '@/components/common';
import { QueryFailure } from '@/components/QueryFailure';
import { useRecordTimeline } from '@/lib/queries';
import { formatDate } from '../../shared/metrics';
import { RECORD_KINDS, type TimelineItem, type TimelineResponse } from '../../shared/recordKinds';
import { humanize } from '@/lib/utils';

interface Kind { key: string; one: string; many: string; icon: LucideIcon }

/** The kinds the timeline shows, in the order their filters are offered. */
const KINDS: Kind[] = [
  { key: 'activity', one: 'Activity', many: 'Activities', icon: NotebookPen },
  { key: 'training', one: 'Training', many: 'Training', icon: BookOpen },
  { key: 'pme', one: 'PME', many: 'PME', icon: GraduationCap },
  { key: 'education', one: 'Education', many: 'Education', icon: GraduationCap },
  { key: 'certification', one: 'Certification', many: 'Certifications', icon: BadgeCheck },
  { key: 'qualification', one: 'Qualification', many: 'Qualifications', icon: BadgeCheck },
  { key: 'award', one: 'Award', many: 'Awards', icon: Award },
  { key: 'recognition', one: 'Recognition', many: 'Recognition', icon: Award },
  { key: 'counseling', one: 'Counseling', many: 'Counselings', icon: MessagesSquare },
  { key: 'goal', one: 'Goal reached', many: 'Goals reached', icon: Target },
];
function kindOf(key: string): Kind {
  const known = KINDS.find((k) => k.key === key);
  if (known) return known;
  const label = RECORD_KINDS.find((k) => k.key === key)?.label ?? humanize(key);
  return { key, one: label, many: label, icon: CalendarRange };
}

/** The line under an entry's title: what its own record holds beside the title. */
function describe(item: TimelineItem): { title: string; detail: string | null } {
  if (item.table === 'counselings') return { title: `${humanize(item.title)} counseling`, detail: item.detail ? `by ${item.detail}` : null };
  if (item.table === 'awards') {
    const type = item.detail === 'loa' ? 'Letter of appreciation' : item.detail ? humanize(item.detail) : null;
    return { title: item.title, detail: type && type.toLowerCase() !== item.title.trim().toLowerCase() ? type : null };
  }
  return { title: item.title, detail: item.detail };
}

const listed = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * The person's own records on one line of time, at /record/timeline (ADR-0015). Each entry is read from the record it
 * belongs to when the page asks for it, so it can never disagree with it, and an Activity never stands in for one.
 */
export default function Timeline() {
  const [kind, setKind] = useParam('kind', 'all');
  const [from, setFrom] = useParam('from');
  const [to, setTo] = useParam('to');
  const [, setParams] = useSearchParams();
  const backwards = Boolean(from && to && from > to);
  const params = useMemo(() => (backwards ? { from } : { from: from || undefined, to: to || undefined }), [from, to, backwards]);
  const timeline = useRecordTimeline(params);
  // One change to the address for several filters: two in a row would each start from the same address, and the second win.
  const clear = (...names: string[]) => setParams((p) => { const n = new URLSearchParams(p); names.forEach((k) => n.delete(k)); return n; }, { replace: true });

  return (
    <div className="page">
      <PageHeader eyebrow="Record" title="Timeline" lede="Your activities, training, awards, counselings and goals reached, newest first. Each is read from its own record when you open this page, not copied here: open one to change it.">
        <Button variant="primary" className="xl:hidden" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log an activity</Button>
      </PageHeader>
      {timeline.isError ? <QueryFailure error={timeline.error} what="Your timeline" onRetry={() => timeline.refetch()} /> : (
        <>
          <Kinds data={timeline.data} kind={kind} onKind={setKind} />
          <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
            <Field label="From" className="w-40"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To" className="w-40" error={backwards ? 'Pick a day on or after the start.' : null}><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
            {(from || to) && <Button variant="ghost" onClick={() => clear('from', 'to')}>Clear dates</Button>}
            {timeline.data && <Pending kinds={timeline.data.pending} />}
          </div>
          {timeline.isPending ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
            : backwards ? <div className="card"><EmptyState icon={CalendarRange} title="Those dates are the wrong way round" description="The start is after the end. Change one of them to see your timeline." /></div>
              : <Entries data={timeline.data} kind={kind} dated={Boolean(from || to)} onClear={() => clear('kind', 'from', 'to')} />}
        </>
      )}
    </div>
  );
}

/** One filter per kind that has entries in the window, with how many it has there. */
function Kinds({ data, kind, onKind }: { data?: TimelineResponse; kind: string; onKind: (k: string) => void }) {
  const counts = data?.counts || {};
  const offered = [...KINDS.filter((k) => counts[k.key] || k.key === kind).map((k) => k.key), ...Object.keys(counts).filter((k) => !KINDS.some((x) => x.key === k))];
  const chip = (key: string, label: string, n: number | undefined) => (
    <Button key={key} size="sm" variant={kind === key ? 'primary' : 'default'} className="shrink-0" aria-pressed={kind === key} onClick={() => onKind(key)}>
      {label}{n != null && <span className="fig opacity-75">{n}</span>}
    </Button>
  );
  return (
    // One row that scrolls sideways on a phone, as the queue's filters do.
    <div className="scroll-x-quiet -mx-4 mb-3 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label="Kinds of record">
      {chip('all', 'Everything', data?.total)}
      {offered.map((key) => chip(key, kindOf(key).many, counts[key] ?? 0))}
    </div>
  );
}

/** Kinds the timeline will hold once Vantage records them, named so an empty timeline is not read as none. */
function Pending({ kinds }: { kinds: TimelineResponse['pending'] }) {
  if (!kinds.length) return null;
  const names = listed(kinds.map((k, i) => (i === 0 ? k.label : k.label.toLowerCase())));
  const one = kinds.length === 1;
  return (
    <p className="flex basis-full items-start gap-2 text-xs leading-relaxed text-ink-3">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{names} {one ? 'is' : 'are'} not on your timeline yet, because Vantage does not record {one ? 'it' : 'them'} so far. Seeing none here does not mean you had none.</span>
    </p>
  );
}

function Entries({ data, kind, dated, onClear }: { data?: TimelineResponse; kind: string; dated: boolean; onClear: () => void }) {
  const items = useMemo(() => (data?.items || []).filter((i) => kind === 'all' || i.kind === kind), [data, kind]);
  // Newest first from the server; a month heading wherever the month changes.
  const months = useMemo(() => {
    const out: Array<{ key: string; items: TimelineItem[] }> = [];
    for (const item of items) {
      const key = item.date.slice(0, 7);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(item); else out.push({ key, items: [item] });
    }
    return out;
  }, [items]);
  if (!data) return null;
  const expected = kind === 'all' ? data.total : data.counts[kind] ?? 0;

  if (!items.length) {
    if (!data.total && !dated) {
      return <div className="card"><EmptyState icon={CalendarRange} title="Nothing on your timeline yet" description="Log an activity, or add training or an award under Career. Each shows here from its own record."
        action={<Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log an activity</Button>} /></div>;
    }
    return <div className="card"><EmptyState icon={CalendarRange} title={kind === 'all' ? 'Nothing in these dates' : `No ${kindOf(kind).many.toLowerCase()} in these dates`} description="Widen the dates, or show everything." action={<Button onClick={onClear}>Show everything</Button>} /></div>;
  }

  return (
    <div className="space-y-5">
      {expected > items.length && <p className="text-xs text-ink-3">Showing the newest <span className="fig">{items.length}</span> of <span className="fig">{expected}</span>. Narrow the dates to see older entries.</p>}
      {months.map((m) => (
        <section key={m.key}>
          <h2 className="eyebrow mb-2">{formatDate(`${m.key}-01`, 'MMMM yyyy')}</h2>
          <ol className="card divide-y divide-line overflow-hidden p-0">
            {m.items.map((item) => <Entry key={`${item.table}:${item.id}`} item={item} />)}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Entry({ item }: { item: TimelineItem }) {
  const k = kindOf(item.kind);
  const { title, detail } = describe(item);
  return (
    <li>
      <Link to={item.href} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3"><k.icon className="h-3.5 w-3.5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink group-hover:underline">{title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-3">
            <span>{k.one}</span>{detail && <span>· {detail}</span>}{item.from_work && <Badge>From your work</Badge>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-2"><DateText value={item.date} /><StatusBadge value={item.status} /></span>
      </Link>
    </li>
  );
}
