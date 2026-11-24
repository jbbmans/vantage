import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, UserPlus, UserMinus, Link2, Mail, Shield, Building2, Download, Search, Sparkles, ClipboardList, Copy, ArrowRightLeft, Send, PenLine, Ticket, ListChecks, Printer } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, EmptyState, Badge, RoleBadge, Panel, Stat, Skeleton, Switch, Segmented } from '@/components/ui/primitives';
import { AssignmentDialog, ACCOUNT_STATUS, type AssignmentTarget } from '@/components/PersonnelRecord';
import { PersonPicker, type PersonSearch } from '@/components/PersonPicker';
import PersonnelBulkDialog from '@/components/PersonnelBulk';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { AiAction, AiResult } from '@/components/AiPanel';
import { clientVisual, DrillDialog, VisualView, type DrillTarget, type OnDrill } from '@/components/analytics';
import { QueryFailure } from '@/components/QueryFailure';
import { DateText, Table, useParam } from '@/components/common';
import { keys, useIdentity, useOrg, useRoles, useTeam, unitsWith, can, useMetrics, useMetricsReport } from '@/lib/queries';
import { ContributorsDialog, MetricTotalsGrid } from '@/components/MetricTotals';
import * as api from '@/lib/api';
import { PERMISSIONS, PERMISSION_LIST, ROLE_TEMPLATE, listPermissions, namedTooLate } from '../../shared/permissions';
import { ECHELONS } from '../../shared/constants';
import { formatDate, formatDollars, NO_VALUE } from '../../shared/metrics';
import { copyToClipboard, cn, downloadText, formatRange, formatStamp, fullName, humanize, isoDay, todayIso, useMediaQuery } from '@/lib/utils';
import DateRangePicker from '@/components/DateRangePicker';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { readWindow, windowDays, windowLink } from '@/lib/periodParams';
import { useWindowParam } from '@/lib/usePeriodParam';
import { DASHBOARD_WINDOW, WORKLOAD_WINDOW, windowSeed } from '@/lib/windows';
import { useView, subtreeOf, viewLabel } from '@/lib/view';
import { teamSections, type TeamSection } from '@/lib/teamAccess';
import { useFocusWhenShown } from '@/lib/keyboard';
import { UnitOverviewPanel } from '@/components/UnitOverview';
import { markTeamSeen } from '@/components/GettingStarted';
import type { DirectoryCandidate, PersonnelRosterRow, TeamPerson, Unit } from '../../shared/types';
import type { Speaker } from '../../shared/workflowMessages';
import { groupFor } from '@/config/nav';
import type { ReportType } from '../../shared/reportCatalog';
import type { AnalyticsSection, FigureFormat } from '../../shared/unitAnalytics';

const TeamWorkload = lazy(() => import('./TeamWorkload'));

// One line on what each page is for. The privacy promise sits where records are opened (the overview and the roster).
const SECTION_LEDES: Partial<Record<TeamSection, string>> = {
  workload: 'Who holds what, what the section is waiting on, and how old the open work is. Counts show what was recorded, not effort.',
  roster: 'Everyone on the team, with their billet, supervisor, dates and roles. Opening a Marine’s record is logged, and their private entries, drafts and career plans never appear.',
  dashboard: 'The unit’s output, casework, duty, training and roster, from shared records only. Select any figure to see the records it counts.',
  roles: 'What each role may do in this unit, and who holds it.',
  units: 'The teams in this command and how they nest.',
  audit: 'Every time someone opened another Marine’s record here: who, whose, and when.',
};
// The report each page prints as, laid out for paper and filed from the report library (ADR-0020).
const SECTION_REPORTS: Partial<Record<TeamSection, ReportType>> = { dashboard: 'unit', workload: 'workload', roster: 'personnel' };

const SECTION_LABELS: Record<TeamSection, string> = {
  overview: 'Overview', workload: 'Workload', roster: 'Roster', dashboard: 'Unit dashboard', invites: 'Invitations', roles: 'Roles', units: 'Units', audit: 'Access log',
};
// Where each section lives. The sections sit in three groups of the menu (ADR-0016), and the heading names the one it is in.
const SECTION_PATHS: Record<TeamSection, string> = {
  overview: '/team', workload: '/team/workload', roster: '/team/roster', dashboard: '/team/dashboard', invites: '/team/invitations', roles: '/team/roles', units: '/team/units', audit: '/team/access-log',
};

/**
 * One of the pages under /team: Personnel's overview at /team, and /team/<section> for the rest, which the menu puts in
 * Personnel, Reports & Analytics or Administration. Which ones a person may open is teamSections'.
 */
export default function Team({ section }: { section: TeamSection }) {
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const { view, views, setView } = useView(identity);
  const [linked, setLinked] = useParam('unit', '');
  useEffect(() => { if (linked && views.some((v) => v.id === linked)) { setView(linked); setLinked(''); } }, [linked, views]); // eslint-disable-line react-hooks/exhaustive-deps
  const unit = view?.id || '';
  const full = view?.level === 'full';
  const subtree = useMemo(() => (unit ? subtreeOf(views, unit) : []), [views, unit]);
  // Meet your team (Your first week) is done once there is a team to meet: not on the page that says there is none.
  useEffect(() => { if (views.length) markTeamSeen(identity?.user.id); }, [identity?.user.id, views.length]);
  const units = org?.units || [];
  const unitLabel = (id: string) => { const u = units.find((x) => x.id === id); return u ? u.short_name || u.name : id; };
  // Accounts and membership are closed in the synthetic demo, so it offers none of the actions that change them.
  const demo = Boolean(identity?.demo);
  const leads = unitsWith(identity, PERMISSIONS.MANAGE_MEMBERS);
  const manageMembers = demo ? [] : leads;
  const manageUnits = unitsWith(identity, PERMISSIONS.MANAGE_UNITS);
  const viewAudit = unitsWith(identity, PERMISSIONS.VIEW_AUDIT);
  const allowed = teamSections(identity, view);
  // A section this view does not offer (a team-level view has no roster) shows the overview instead.
  const shown: TeamSection = allowed.has(section) ? section : 'overview';
  // Only the Units section reads the whole team list (for leaders' names), so every other section paints without it.
  const team = useTeam(shown === 'units');
  const [messaging, setMessaging] = useState(false);
  const [dashboardShow] = useParam('show', 'output');
  const [params] = useSearchParams();
  const report = shown === 'dashboard' ? DASHBOARD_REPORTS[isDashboardShow(dashboardShow) ? dashboardShow : 'output'] : SECTION_REPORTS[shown];
  // From the dashboard or Workload, the report covers the window on screen, so its figures are the page's (the roster
  // stands on today). Custom dates go as custom dates, so the Report library keeps them as dates (ADR-0039).
  const printWindow = shown === 'dashboard' && dashboardShow !== 'personnel' ? windowLink(readWindow(params, DASHBOARD_WINDOW))
    : shown === 'workload' ? windowLink(readWindow(params, WORKLOAD_WINDOW)) : null;
  // Somebody with no unit who follows a link here is told so, under the name of the page they asked for.
  if (!views.length) return <div className="page"><PageHeader eyebrow={groupFor(SECTION_PATHS[section])?.label} title={section === 'overview' ? 'Personnel' : SECTION_LABELS[section]} /><div className="card"><EmptyState icon={Users} title="No unit visibility yet" description="These pages show the Marines, figures and administration of the units you belong to. Join one with an invitation or a join code: enter a code in Settings, under Join with a code." /></div></div>;
  // The overview is headed by the unit it shows; every other section by its own name, with the group and the unit above it.
  // A section this view does not offer keeps the name it was asked for, as the menu and the address do, and says so.
  const missing = shown !== section;
  // Picking another view helps only when one includes it: Administration's pages follow a permission, not the view.
  const elsewhere = missing && views.some((v) => v.id !== unit && teamSections(identity, v).has(section));
  const group = groupFor(SECTION_PATHS[section])?.label;
  const where = viewLabel(view) || unitLabel(unit);

  return (
    <div className="page">
      <PageHeader eyebrow={section === 'overview' ? `${group}${view && subtree.length > 1 ? ' · whole command' : ''}` : `${group} · ${where}${view && subtree.length > 1 ? ', whole command' : ''}`} title={section === 'overview' ? where || 'Personnel' : SECTION_LABELS[section]} lede={missing ? undefined : SECTION_LEDES[shown] ?? (full ? 'The work and people of this view. Private entries, drafts and career plans never appear here, and every open of a member’s record is logged.' : 'Who is in this view, how its teams are doing, and the goals it is working toward. Figures built from fewer than three people are not shown.')}>
        {leads.includes(unit) && <Button onClick={() => setMessaging(true)}><Send className="h-4 w-4" />Email the team</Button>}
        {!missing && unit && report && <Button asChild data-tutorial="dashboard-print"><Link to={`/reports/library?${new URLSearchParams({ type: report, subject: 'unit', unit_id: unit, ...(printWindow || {}) })}`}><Printer className="h-4 w-4" aria-hidden />Print or file</Link></Button>}
        {views.length > 1 && <Select aria-label="View" className="w-64" value={unit} onValueChange={setView} options={views.map((v) => ({ value: v.id, label: `${'\u2003'.repeat(v.depth)}${v.short_name || v.name}${v.teams ? ' (whole command)' : ''}` }))} />}
      </PageHeader>
      {missing ? (
        <div className="card"><EmptyState icon={Users} title={`Not part of the ${where} view`} description={elsewhere ? `Pick a view above that includes ${SECTION_LABELS[section]}, or open the overview of this one.` : views.length > 1 ? `None of your views includes ${SECTION_LABELS[section]}. The overview shows what this one does include.` : `Your role in ${where} does not include ${SECTION_LABELS[section]}. The overview shows what it does include.`} action={<Button asChild><Link to="/team">Open the overview</Link></Button>} /></div>
      ) : (
        <>
          {shown === 'overview' && unit && <UnitOverviewPanel key={unit} unitId={unit} />}
          {shown === 'workload' && unit && <Suspense fallback={<Skeleton className="h-64" />}><TeamWorkload unitId={unit} /></Suspense>}
          {shown === 'roster' && unit && <Roster key={unit} unit={unit} unitLabel={unitLabel} canManage={manageMembers.includes(unit)} subtree={subtree} moveTargets={views.filter((v) => manageMembers.includes(v.id)).map((v) => ({ id: v.id, depth: v.depth, label: v.teams ? `${v.short_name || v.name} (command element)` : v.short_name || v.name }))} />}
          {shown === 'dashboard' && unit && <UnitDashboard unitId={unit} unitLabel={unitLabel(unit)} canExport={can(identity, PERMISSIONS.EXPORT_DATA, unit)} canDetail={can(identity, PERMISSIONS.VIEW_MEMBER_DETAIL, unit)} />}
          {shown === 'invites' && <><Invites unitId={manageMembers.includes(unit) ? unit : manageMembers[0]} unitLabel={unitLabel} /><JoinCodes unitId={manageMembers.includes(unit) ? unit : manageMembers[0]} unitLabel={unitLabel} /></>}
          {shown === 'roles' && <Roles unitId={unit} unitLabel={unitLabel} />}
          {shown === 'units' && (team.isPending ? <Skeleton className="h-64" /> : team.error && !team.data ? <QueryFailure error={team.error} onRetry={() => team.refetch()} what="The units" />
            : <Units units={units} manageUnits={manageUnits} orgAdmin={Boolean(identity?.orgs?.some((o) => o.permissions.includes('org.units')))} roster={team.data?.roster || []} />)}
          {shown === 'audit' && <UnitAudit unitId={viewAudit.includes(unit) ? unit : viewAudit[0]} />}
        </>
      )}
      {unit && <MessageDialog open={messaging} onOpenChange={setMessaging} unitId={unit} unitLabel={viewLabel(view) || unitLabel(unit)} />}
    </div>
  );
}

type RosterFilter = 'all' | 'no_supervisor' | 'no_billet' | 'ending';
/** How many Marines the roster puts on the page at a time; "Show more" adds as many again. */
const ROSTER_PAGE = 100;
const ROSTER_FILTERS: Array<{ value: RosterFilter; label: string; test: (r: PersonnelRosterRow, soon: string) => boolean }> = [
  { value: 'all', label: 'Everyone', test: () => true },
  { value: 'no_supervisor', label: 'No supervisor', test: (r) => !r.supervisor },
  { value: 'no_billet', label: 'No billet', test: (r) => !r.assignment.billet },
  { value: 'ending', label: 'Ending in 90 days', test: (r, soon) => Boolean(r.assignment.assignment_end && r.assignment.assignment_end <= soon) },
];

/**
 * Personnel → Roster (ADR-0017): each Marine in the unit and the teams beneath it once, on their own team, with billet,
 * supervisor, dates, responsibilities and roles; account status for those the reader manages. Those who manage members
 * change one Marine from the row, or several at once from a selection, previewed before it applies.
 */
function Roster({ unit, unitLabel, canManage, subtree, moveTargets }: { unit: string; unitLabel: (id: string) => string; canManage: boolean; subtree: string[]; moveTargets: Array<{ id: string; depth: number; label: string }> }) {
  // Each read of the roster is logged, so it is not read again on returning to the window.
  const { data, isPending, error, refetch } = useQuery({ queryKey: keys.personnelRoster(unit), queryFn: () => api.personnelRoster(unit), enabled: Boolean(unit), staleTime: 60_000, refetchOnWindowFocus: false, retry: false });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<RosterFilter>('all');
  const [limit, setLimit] = useState(ROSTER_PAGE);
  // One layout at a time: a phone gets the list, anything wider the table, never both in the page.
  const wide = useMediaQuery('(min-width: 640px)');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const [editing, setEditing] = useState<AssignmentTarget | null>(null);
  const [moving, setMoving] = useState<{ person: MovePerson; from: string } | null>(null);
  const [removing, setRemoving] = useState<{ person: PersonnelRosterRow; unit: string } | null>(null);
  const toast = useToast(); const qc = useQueryClient();
  const nameOf = (p: Pick<PersonnelRosterRow, 'rank_abbr' | 'last_name'>) => `${p.rank_abbr || ''} ${p.last_name}`.trim();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['personnel'] }); qc.invalidateQueries({ queryKey: keys.team }); qc.invalidateQueries({ queryKey: ['unit-overview'] }); };
  const remove = async () => {
    if (!removing) return;
    try {
      const r = await api.removeMember(removing.unit, removing.person.id);
      const parts = [r.recordsFrozen && `${r.recordsFrozen} shared ${r.recordsFrozen === 1 ? 'record is' : 'records are'} now read-only`, r.claimsReleased && `${r.claimsReleased} held ${r.claimsReleased === 1 ? 'item is' : 'items are'} back in the queue`,
        r.responsibilitiesEnded && `${r.responsibilitiesEnded} ${r.responsibilitiesEnded === 1 ? 'responsibility' : 'responsibilities'} ended`, r.supervisionsEnded && `${r.supervisionsEnded} ${r.supervisionsEnded === 1 ? 'Marine needs' : 'Marines need'} a new supervisor`].filter(Boolean);
      toast.success(`${nameOf(removing.person)} left ${unitLabel(removing.unit)}.${parts.length ? ` ${parts.join('; ')}.` : ''}`);
      setSelected((s) => { const n = new Set(s); n.delete(removing.person.id); return n; });
      refresh();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setRemoving(null); }
  };
  const manage = canManage && Boolean(data?.canManage);
  const rollup = Boolean(data?.rows.some((r) => r.assignment.unit_id !== unit));
  const soon = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 90); return isoDay(d); }, []);
  const term = q.trim().toLowerCase();
  const matching = useMemo(() => (data?.rows || []).filter((r) => !term || [r.first_name, r.last_name, r.rank_abbr, r.mos, r.assignment.billet, r.team_label, r.supervisor?.last_name, ...r.responsibilities].filter(Boolean).join(' ').toLowerCase().includes(term)), [data, term]);
  const shown = useMemo(() => matching.filter((r) => ROSTER_FILTERS.find((f) => f.value === filter)!.test(r, soon)), [matching, filter, soon]);
  // A new search or filter starts from the top of what it finds.
  useEffect(() => { setLimit(ROSTER_PAGE); }, [term, filter]);
  const visible = useMemo(() => shown.slice(0, limit), [shown, limit]);
  const selectable = (r: PersonnelRosterRow) => manage && r.canManage && !r.self;
  const chosen = useMemo(() => (data?.rows || []).filter((r) => selected.has(r.id) && selectable(r)), [data, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Everyone shown" is everyone on screen: those past "Show more" are not chosen unseen.
  const shownSelectable = visible.filter(selectable);
  const allShown = shownSelectable.length > 0 && shownSelectable.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleShown = () => setSelected((s) => { const n = new Set(s); for (const r of shownSelectable) { if (allShown) n.delete(r.id); else n.add(r.id); } return n; });
  const edit = (r: PersonnelRosterRow) => setEditing({ userId: r.id, name: nameOf(r), assignment: r.assignment, unitLabel: unitLabel(r.assignment.unit_id), supervisor: r.supervisor, checked_in_on: r.checked_in_on, billets: data?.billets || [] });
  const initialsOf = (p: PersonnelRosterRow) => (p.first_name[0] || '') + (p.last_name[0] || '');
  const roles = (p: PersonnelRosterRow) => p.roles.map((r) => <RoleBadge key={r.id} color={r.color}>{r.name}</RoleBadge>);
  const status = (p: PersonnelRosterRow) => (p.status && p.status !== 'active' ? <Badge tone={ACCOUNT_STATUS[p.status].tone}>{ACCOUNT_STATUS[p.status].label}</Badge> : null);
  const dates = (p: PersonnelRosterRow) => [p.checked_in_on && `In ${formatDate(p.checked_in_on)}`, p.assignment.assignment_end && `Ends ${formatDate(p.assignment.assignment_end)}`].filter(Boolean).join(' · ');
  // The box sits in a label a finger can hit (44 px), as the rest of the row's controls are.
  const checkbox = (p: PersonnelRosterRow, className: string) => (selectable(p) ? <label className={cn('inline-flex shrink-0 cursor-pointer items-center justify-center', className)}><input type="checkbox" data-tutorial="roster-select" className="h-4 w-4 accent-accent" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${nameOf(p)}`} /></label> : null);
  // The same controls in the table and in the phone list, so the two never offer different things.
  const actions = (p: PersonnelRosterRow) => {
    const m = p.assignment;
    const memberships = (p.unit_ids.length ? p.unit_ids : [m.unit_id]).map((unit_id) => ({ unit_id }));
    return (
      <span className="inline-flex items-center gap-1">{manage && p.canManage && !p.self && <>
        <Button size="xs" variant="ghost" onClick={() => edit(p)} aria-label={`Change ${p.last_name}’s billet`} title="Billet, dates, supervisor and check-in"><PenLine className="h-3.5 w-3.5" /></Button>
        {moveTargets.some((t) => t.id !== m.unit_id && !memberships.some((x) => x.unit_id === t.id)) && <Button size="xs" variant="ghost" onClick={() => setMoving({ person: { id: p.id, rank_abbr: p.rank_abbr, last_name: p.last_name, memberships }, from: m.unit_id })} aria-label={`Move ${p.last_name} to another team`}><ArrowRightLeft className="h-3.5 w-3.5" /></Button>}
        <Button size="xs" variant="ghost" onClick={() => setRemoving({ person: p, unit: m.unit_id })} aria-label={`Remove ${p.last_name} from ${unitLabel(m.unit_id)}`}><UserMinus className="h-3.5 w-3.5" /></Button>
      </>}<Button size="xs" asChild data-tutorial="roster-open"><Link to={`/team/${p.id}`} aria-label={`Open ${p.rank_abbr || ''} ${p.last_name}`.replace(/\s+/g, ' ')}>Open</Link></Button></span>
    );
  };
  const counts = (f: (typeof ROSTER_FILTERS)[number]) => matching.filter((r) => f.test(r, soon)).length;
  const total = data?.rows.length ?? 0;
  const left = shown.length - visible.length;
  // Showing more keeps the keyboard on the button; when the last of them appear and the button goes, it moves to the
  // first of those, so nobody is sent back to the top of the page.
  const showMore = () => {
    const next = shown[visible.length];
    setLimit((l) => l + ROSTER_PAGE);
    if (left <= ROSTER_PAGE && next) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-person="${next.id}"] a`)?.focus());
  };
  const showing = !data ? '' : shown.length === total ? `Showing ${visible.length} of ${total} ${total === 1 ? 'Marine' : 'Marines'}.` : `Showing ${visible.length} of ${shown.length} matching, ${total} on the roster.`;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search roster" data-tutorial="roster-search" className="pl-8" placeholder="Name, rank, MOS, billet, supervisor…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {canManage && <Button variant="primary" onClick={() => setEnroll(true)}><UserPlus className="h-4 w-4" />Enroll an existing account</Button>}
      </div>
      {data && data.rows.length > 0 && <Segmented className="mb-3" size="sm" label="Show" value={filter} onChange={setFilter} options={ROSTER_FILTERS.map((f) => ({ value: f.value, label: f.value === 'all' ? f.label : `${f.label} (${counts(f)})` }))} />}
      {manage && chosen.length > 0 && (
        <div role="region" aria-label="Selected Marines" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-sm">
          <span className="font-medium text-ink">{chosen.length} selected</span>
          <Button size="sm" variant="primary" onClick={() => setBulk(true)}><ListChecks className="h-4 w-4" />Change {chosen.length === 1 ? 'one' : `all ${chosen.length}`}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}
      <p role="status" aria-live="polite" className={cn('mb-2 text-xs text-ink-3', !showing && 'sr-only')}>{showing}</p>
      {isPending ? <Skeleton className="h-64" /> : error && !data ? <QueryFailure error={error} onRetry={() => refetch()} what="The roster" />
        : !shown.length ? <div className="card"><EmptyState icon={Users} title={data?.rows.length ? 'Nobody matches' : 'No members here yet'} description={data?.rows.length ? 'Try another search or show everyone.' : canManage ? 'Invite Marines from the Invitations page, or enroll an account that already exists.' : 'Nobody has joined this unit yet.'} /></div> : (
        <>
        {/* A phone gets a list: the table's columns leave a name two words wide and the controls off the screen. */}
        {!wide ? <ul className="card divide-y divide-line overflow-hidden p-0" aria-label="Roster">
          {visible.map((p) => (
            <li key={p.id} data-person={p.id} className="flex items-start gap-3 px-4 py-3">
              {checkbox(p, '-m-1 h-11 w-11') ?? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-bold text-ink" aria-hidden>{initialsOf(p)}</span>}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">{p.rank_abbr || ''} {p.last_name}, {p.first_name}</span>
                <span className="block text-xs text-ink-3">{[p.assignment.billet, p.mos, rollup ? p.team_label : p.assignment.is_primary ? null : 'secondary', p.supervisor && `under ${nameOf(p.supervisor)}`, dates(p)].filter(Boolean).join(' · ')}</span>
                <span className="mt-1.5 flex flex-wrap gap-1">{status(p)}{roles(p)}</span>
              </span>
              <span className="shrink-0">{actions(p)}</span>
            </li>
          ))}
        </ul> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <Table label="Roster" head={<>{manage && <th scope="col" className="w-8">{shownSelectable.length > 0 ? <label className="tap -m-1 inline-flex min-w-[2.75rem] cursor-pointer items-center justify-center p-1"><input type="checkbox" className="h-4 w-4 accent-accent" checked={allShown} onChange={toggleShown} aria-label="Select everyone shown" /></label> : <span className="sr-only">Select</span>}</th>}<th scope="col">Marine</th>{rollup && <th scope="col" className="w-40">Team</th>}<th scope="col">Billet</th><th scope="col" className="w-40">Supervisor</th><th scope="col" className="w-32">Dates</th><th scope="col">Roles</th><th scope="col" className="relative w-28"><span className="sr-only">Actions</span></th></>}>
            {visible.map((p) => (
              <tr key={p.id} data-person={p.id}>
                {manage && <td>{checkbox(p, 'tap -m-1 min-w-[2.75rem] p-1')}</td>}
                <td><span className="flex items-center gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-bold text-ink">{initialsOf(p)}</span><span className="min-w-0"><span className="block font-medium text-ink">{p.rank_abbr || ''} {p.last_name}, {p.first_name}</span><span className="block text-xs text-ink-3">{[p.mos, rollup ? null : `${p.team_label}${p.assignment.is_primary ? '' : ' (secondary)'}`].filter(Boolean).join(' · ')}</span></span></span></td>
                {rollup && <td className="text-xs text-ink-2">{p.team_label}{p.assignment.is_primary ? '' : ' (secondary)'}</td>}
                <td className="text-xs text-ink-2"><span className="block">{p.assignment.billet || ''}</span>{p.responsibilities.length > 0 && <span className="block text-2xs text-ink-3">{p.responsibilities.join(', ')}</span>}</td>
                <td className="text-xs text-ink-2">{p.supervisor ? nameOf(p.supervisor) : ''}</td>
                <td className="text-xs text-ink-3">{dates(p)}</td>
                <td><span className="flex flex-wrap gap-1">{status(p)}{roles(p)}</span></td>
                <td className="text-right">{actions(p)}</td>
              </tr>
            ))}
          </Table>
        </div>
        )}
        {left > 0 && (
          <div className="mt-3 flex justify-center">
            <Button onClick={showMore}>Show {Math.min(left, ROSTER_PAGE)} more</Button>
          </div>
        )}
        </>
      )}
      <EnrollDialog open={enroll} onOpenChange={setEnroll} unitId={unit} unitLabel={unitLabel(unit)} />
      <MoveDialog move={moving} onClose={() => setMoving(null)} targets={moveTargets} unitLabel={unitLabel} />
      <AssignmentDialog target={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      {/* One Marine moves to any team the leader manages; a bulk move stays inside this view, as the bulk route does. */}
      <PersonnelBulkDialog open={bulk} onOpenChange={setBulk} unitId={unit} unitLabel={unitLabel(unit)} rows={chosen} billets={data?.billets || []} moveTargets={moveTargets.filter((t) => subtree.includes(t.id))} onDone={() => { setSelected(new Set()); refresh(); }} />
      <ConfirmDialog
        open={Boolean(removing)} onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title={removing ? `Remove ${nameOf(removing.person)} from ${unitLabel(removing.unit)}?` : ''} confirmLabel="Remove"
        body="Their account, private entries and history stay with them. What they shared with this unit becomes read-only, work they were holding here goes back to the queue, their roles here end, and they are signed out everywhere. If it was their last unit in this command, their supervisor, check-in and responsibilities here end too. To keep them in the command, move them instead."
        onConfirm={remove}
      />
    </>
  );
}

/** Why some Marines get a team message in Vantage only: no address on file, or one Vantage may not email. */
function inVantageOnly(noEmail: number, outside: number) {
  if (!outside) return 'no email on file';
  const away = `${outside} with an address outside the allowed domains`;
  return noEmail ? `${noEmail} with no email on file, ${away}` : away;
}

function MessageDialog({ open, onOpenChange, unitId, unitLabel }: { open: boolean; onOpenChange: (o: boolean) => void; unitId: string; unitLabel: string }) {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const { data: audience } = useQuery({ queryKey: ['team-audience', unitId], queryFn: () => api.teamAudience(unitId), enabled: open });
  const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setSubject(''); setBody(''); } }, [open]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.messageTeam(unitId, { subject, body });
      const parts = [r.emailed && `${r.emailed} by email`, r.queued && `${r.queued} waiting on their mail server`, r.failed && `${r.failed} undeliverable`, r.refused && `${r.refused} not emailed (address outside the allowed domains)`].filter(Boolean);
      toast.success(`Sent to ${r.recipients} ${r.recipients === 1 ? 'Marine' : 'Marines'} in Vantage${parts.length ? `; ${parts.join(', ')}` : ''}.`);
      onOpenChange(false);
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const tooMany = Boolean(audience && audience.members > audience.limit);
  const reach = !audience ? 'Counting…' : !audience.members ? 'Nobody else is on this roster yet.'
    : tooMany ? `${audience.members} Marines are in ${unitLabel} and the teams beneath it; one message reaches at most ${audience.limit}. Send it to each team beneath instead.`
    : audience.emailEnabled ? `${audience.members} ${audience.members === 1 ? 'Marine' : 'Marines'}: ${audience.withEmail} by email and in Vantage${audience.appOnly ? `, ${audience.appOnly} in Vantage only (${inVantageOnly(audience.appOnly - (audience.outsideDomains || 0), audience.outsideDomains || 0)})` : ''}.`
      : `${audience.members} ${audience.members === 1 ? 'Marine' : 'Marines'}, in Vantage. Email is off on Vantage right now.`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Email ${unitLabel}`} description={reach} size="md"
      footer={<><span className="mr-auto text-2xs text-ink-3">{identity?.user.email ? `Replies go to ${identity.user.email}.` : 'Add an email to your profile so replies reach you.'}</span><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={send} loading={busy} disabled={!subject.trim() || !body.trim() || !audience?.members || tooMany}><Send className="h-4 w-4" />Send</Button></>}>
      <div className="space-y-3">
        <Field label="Subject"><Input autoFocus value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} placeholder="Q4 close-out: what is due Friday" /></Field>
        <Field label="Message" hint={`${body.length} / 5000`}><Textarea rows={8} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} placeholder="Plain words. Each Marine gets their own copy; no one sees anyone else’s address." /></Field>
        <p className="text-2xs leading-relaxed text-ink-3">It goes to everyone in {unitLabel}{' '}and the teams beneath it, from Vantage’s own address, and is recorded in the unit’s access log. Five messages an hour at most.</p>
      </div>
    </Dialog>
  );
}

/** Who is moved: enough to name them and to leave out the teams they are already in. */
type MovePerson = { id: string; rank_abbr: string | null; last_name: string; memberships: Array<{ unit_id: string }> };

function MoveDialog({ move, onClose, targets, unitLabel }: { move: { person: MovePerson; from: string } | null; onClose: () => void; targets: Array<{ id: string; depth: number; label: string }>; unitLabel: (id: string) => string }) {
  const toast = useToast(); const qc = useQueryClient();
  const [to, setTo] = useState(''); const [carry, setCarry] = useState(false); const [busy, setBusy] = useState(false);
  const options = move ? targets.filter((t) => t.id !== move.from && !move.person.memberships.some((m) => m.unit_id === t.id)).sort((x, y) => y.depth - x.depth) : [];
  useEffect(() => { setTo(options[0]?.id || ''); setCarry(false); }, [move]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = move ? `${move.person.rank_abbr || ''} ${move.person.last_name}`.trim() : '';
  const submit = async () => {
    if (!move || !to) return;
    setBusy(true);
    try {
      const r = await api.moveMember(move.from, move.person.id, { to, entries: carry ? 'move' : 'stay' });
      qc.invalidateQueries({ queryKey: keys.team }); qc.invalidateQueries({ queryKey: ['unit-overview'] }); qc.invalidateQueries({ queryKey: ['personnel'] });
      toast.success(`${name} moved to ${unitLabel(to)}.${r.rolesSkipped?.length ? ` Not carried over: ${r.rolesSkipped.join(', ')}.` : ''}`);
      onClose();
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={Boolean(move)} onOpenChange={(o) => { if (!o) onClose(); }} title={`Move ${name}`} description={move ? `From ${unitLabel(move.from)}. Their account, private entries and history stay with them. They sign in again to see the new team.` : ''} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!to}>Move</Button></>}>
      <div className="space-y-3">
        <Field label="New team"><Select value={to} onValueChange={setTo} options={options.map((t) => ({ value: t.id, label: t.label }))} /></Field>
        <Switch checked={carry} onChange={setCarry} label="Take their shared entries with them" description={carry ? `Activities and training they shared with ${move ? unitLabel(move.from) : 'the old team'} move to the new team and stay editable. Team tasks, goals and projects stay behind.` : `Entries stay with ${move ? unitLabel(move.from) : 'the old team'}, where the work was done, and become read-only. They still count toward the command.`} />
        <p className="text-xs text-ink-3">Roles move with them when the new team has the same role and you may grant it. Open work they had claimed on the old team is released.</p>
      </div>
    </Dialog>
  );
}

/** A name the enroll search offers, carrying the account it is. */
type Enrollable = Speaker & { candidate: DirectoryCandidate };
const isEnrollable = (p: Speaker): p is Enrollable => 'candidate' in p;

function EnrollDialog({ open, onOpenChange, unitId, unitLabel }: { open: boolean; onOpenChange: (o: boolean) => void; unitId: string; unitLabel: string }) {
  const toast = useToast(); const qc = useQueryClient();
  const { data: rolesData } = useRoles(open);
  const [picked, setPicked] = useState<DirectoryCandidate | null>(null);
  const [roleId, setRoleId] = useState(''); const [billet, setBillet] = useState(''); const [primary, setPrimary] = useState(false); const [busy, setBusy] = useState(false);
  // Every choice starts again, Make this their primary unit included: the next Marine's primary unit never changes unasked.
  useEffect(() => { if (!open) { setPicked(null); setRoleId(''); setBillet(''); setPrimary(false); } }, [open]);
  // Each offered name carries the account it is, so the account itself is enrolled rather than the picker's row, even
  // when a search is answered again from the query cache after the roster was left and opened again.
  const search = useMemo<PersonSearch>(() => ({
    key: ['directory', unitId],
    load: async (q) => {
      const r = await api.directory(unitId, q);
      return { people: r.results.map((c): Enrollable => ({ id: c.id, username: c.username, name: `${c.rank_abbr || ''} ${c.last_name}, ${c.first_name}`.trim(), rank: c.rank_abbr, candidate: c })), more: r.more };
    },
    minLength: 2,
    none: 'Nobody you lead matches. Send an invitation from the Invitations page instead.',
  }), [unitId]);
  const roles = (rolesData?.roles || []).filter((r) => r.unit_id === unitId && r.key !== 'unit-leader' && !r.is_default);
  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await api.addMember(unitId, { user_id: picked.id, role_id: roleId || null, billet: billet || null, primary });
      qc.invalidateQueries({ queryKey: keys.team }); qc.invalidateQueries({ queryKey: ['personnel'] });
      toast.success(`${picked.last_name} enrolled in ${unitLabel}.`); onOpenChange(false);
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Enroll in ${unitLabel}`} description="For Marines you already lead in another unit you manage. Anyone else joins with an invitation they accept themselves." size="sm" footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!picked}>Enroll</Button></>}>
      <div className="space-y-3">
        {picked ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <span><span className="block font-medium text-ink">{picked.rank_abbr || ''} {picked.last_name}, {picked.first_name}</span><span className="block text-xs text-ink-3">@{picked.username}</span></span>
            <Button size="xs" variant="ghost" onClick={() => setPicked(null)} aria-label={`Change from ${picked.last_name} to someone else`}>Change</Button>
          </div>
        ) : <PersonPicker search={search} label="Find by username or last name" hint="Two letters or more" autoFocus onChoose={(p) => setPicked(isEnrollable(p) ? p.candidate : null)} />}
        {picked && <><Field label="Role" hint="Marine is always granted"><Select value={roleId || '__none'} onValueChange={(v) => setRoleId(v === '__none' ? '' : v)} options={[{ value: '__none', label: 'Marine (default)' }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} /></Field><Field label="Billet"><Input value={billet} onChange={(e) => setBillet(e.target.value)} placeholder="Budget Analyst" /></Field><Switch checked={primary} onChange={setPrimary} label="Make this their primary unit" description="New entries default to sharing here." /></>}
      </div>
    </Dialog>
  );
}

function Invites({ unitId, unitLabel }: { unitId: string; unitLabel: (id: string) => string }) {
  const toast = useToast(); const { data: identity } = useIdentity(); const { data: org } = useOrg(); const { data: rolesData } = useRoles();
  const { data, refetch } = useQuery({ queryKey: ['invites', unitId], queryFn: () => api.listInvites(unitId), enabled: Boolean(unitId) });
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', rank_id: '', billet: '', role_id: '' });
  const [busy, setBusy] = useState(false); const [created, setCreated] = useState<any>(null);
  const roles = (rolesData?.roles || []).filter((r) => r.unit_id === unitId && r.key !== 'unit-leader' && !r.is_default);
  const create = async () => { setBusy(true); try { const r = await api.createInvite(unitId, { email: form.email || undefined, first_name: form.first_name || undefined, last_name: form.last_name || undefined, rank_id: form.rank_id || null, billet: form.billet || null, role_id: form.role_id || null }); setCreated(r); refetch(); if (r.emailed) toast.success(`Invitation emailed to ${form.email}.`); else if (r.emailError) toast.error(r.emailError); else toast.success('Invitation link created. Copy it and send it yourself.'); setForm({ email: '', first_name: '', last_name: '', rank_id: '', billet: '', role_id: '' }); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={`Invite to ${unitLabel(unitId)}`} subtitle="A link that works for seven days" className="lg:col-span-1">
        <div className="space-y-3">
          <Field label="Email" hint={identity?.instance.emailEnabled ? 'emailed automatically' : 'optional; email is not configured, so you send the link'}><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="First name"><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field><Field label="Last name"><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
            <Field label="Rank"><Select value={form.rank_id || '__none'} onValueChange={(v) => setForm({ ...form, rank_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Not set' }, ...(org?.ranks || []).map((r) => ({ value: r.id, label: r.abbr }))]} /></Field><Field label="Billet"><Input value={form.billet} onChange={(e) => setForm({ ...form, billet: e.target.value })} /></Field></div>
          <Field label="Role on arrival"><Select value={form.role_id || '__none'} onValueChange={(v) => setForm({ ...form, role_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Marine (default)' }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} /></Field>
          <Button variant="primary" className="w-full" onClick={create} loading={busy}>{form.email && identity?.instance.emailEnabled ? <><Mail className="h-4 w-4" />Send invitation</> : <><Link2 className="h-4 w-4" />Create link</>}</Button>
          {created && <div className="border-l-2 border-l-good border-y border-r border-line p-3 text-xs"><p className="font-medium text-ink">Invitation ready{created.emailed ? ' and emailed' : ''}.</p><p data-invite-url className="mt-1 break-all font-mono text-ink-2">{created.url}</p><Button size="xs" className="mt-2" onClick={async () => { if (await copyToClipboard(created.url)) toast.success('Link copied.'); else toast.error('Could not copy.'); }}><Copy className="h-3 w-3" />Copy link</Button></div>}
        </div>
      </Panel>
      <Panel title="Open invitations" className="lg:col-span-2" padded={false}>
        {!data?.invites?.length ? <EmptyState title="No open invitations" /> : (
          <Table label="Open invitations" head={<><th scope="col">Invitee</th><th scope="col">Role · billet</th><th scope="col" className="w-28">Expires</th><th scope="col" className="w-28">By</th><th scope="col" className="relative w-20"><span className="sr-only">Actions</span></th></>}>
            {data.invites.map((i: any) => <tr key={i.id}><td><span className="block text-ink">{i.email || 'Link invitation'}</span><span className="block text-xs text-ink-3">{[i.payload.first_name, i.payload.last_name].filter(Boolean).join(' ')}</span></td><td className="text-xs text-ink-2">{roles.find((r) => r.id === i.payload.role_id)?.name || 'Marine'}{i.payload.billet ? ` · ${i.payload.billet}` : ''}</td><td className="text-xs"><DateText value={i.expires_at} /></td><td className="text-xs text-ink-3">{i.by_last || ''}</td><td className="text-right">{i.used_at ? <Badge tone="good">Used</Badge> : <Button size="xs" variant="ghost" onClick={async () => { try { await api.revokeInvite(i.id); refetch(); } catch (e) { toast.error(api.errorText(e)); } }}>Revoke</Button>}</td></tr>)}
          </Table>
        )}
      </Panel>
    </div>
  );
}

const CODE_LIFETIMES = [{ value: '24', label: '1 day' }, { value: '168', label: '7 days' }, { value: '720', label: '30 days' }, { value: 'never', label: 'Until revoked' }];

function joinCodeState(c: { revoked_at: string | null; expires_at: string | null; max_uses: number | null; uses: number }) {
  if (c.revoked_at) return { label: 'Revoked', tone: 'neutral' as const };
  if (c.expires_at && Date.parse(c.expires_at) < Date.now()) return { label: 'Expired', tone: 'neutral' as const };
  if (c.max_uses != null && c.uses >= c.max_uses) return { label: 'Used up', tone: 'neutral' as const };
  return { label: 'Live', tone: 'good' as const };
}

/** One code a leader reads out at formation or posts to the section chat; each Marine enters it in Settings and joins. */
function JoinCodes({ unitId, unitLabel }: { unitId: string; unitLabel: (id: string) => string }) {
  const toast = useToast(); const { data: rolesData } = useRoles();
  const { data, refetch } = useQuery({ queryKey: ['join-codes', unitId], queryFn: () => api.listJoinCodes(unitId), enabled: Boolean(unitId) });
  const [form, setForm] = useState({ role_id: '', note: '', max_uses: '', lifetime: '168' });
  const [busy, setBusy] = useState(false); const [created, setCreated] = useState<{ code: string } | null>(null); const [revoking, setRevoking] = useState<any>(null);
  const roles = (rolesData?.roles || []).filter((r) => r.unit_id === unitId && r.key !== 'unit-leader' && !r.is_default);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createJoinCode(unitId, { role_id: form.role_id || null, note: form.note.trim() || null, max_uses: form.max_uses ? Number(form.max_uses) : null, expires_in_hours: form.lifetime === 'never' ? null : Number(form.lifetime) });
      setCreated(r); refetch(); setForm({ ...form, note: '', max_uses: '' }); toast.success('Join code created.');
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const codes: any[] = data?.invites || [];
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={`Join code for ${unitLabel(unitId)}`} subtitle="One code for a whole formation" className="lg:col-span-1">
        <div className="space-y-3">
          <p className="text-xs text-ink-3">Anyone signed in who enters the code under Settings joins the unit. Use it where you can see who is in the room; send a named invitation to anyone else.</p>
          <Field label="Role on arrival"><Select value={form.role_id || '__none'} onValueChange={(v) => setForm({ ...form, role_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Marine (default)' }, ...roles.map((r) => ({ value: r.id, label: r.name }))]} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Works for"><Select value={form.lifetime} onValueChange={(v) => setForm({ ...form, lifetime: v })} options={CODE_LIFETIMES} /></Field>
            <Field label="Uses" hint="blank: no limit"><Input type="number" inputMode="numeric" min={1} max={1000} value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} /></Field>
          </div>
          <Field label="Note" hint="who it is for; Marines see it"><Input maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Second squad, 1 October formation" /></Field>
          <Button variant="primary" className="w-full" onClick={create} loading={busy} data-tutorial="join-code-create"><Ticket className="h-4 w-4" />Create join code</Button>
          {created && <div className="border-l-2 border-l-good border-y border-r border-line p-3 text-xs"><p className="font-medium text-ink">Copy it now. Vantage keeps only a fingerprint of it and cannot show it again.</p><p data-join-code className="mt-1 font-mono text-lg tracking-wider text-ink">{created.code}</p><Button size="xs" className="mt-2" onClick={async () => { if (await copyToClipboard(created.code)) toast.success('Code copied.'); else toast.error('Could not copy.'); }}><Copy className="h-3 w-3" />Copy code</Button></div>}
        </div>
      </Panel>
      <Panel title="Join codes" className="lg:col-span-2" padded={false}>
        {!codes.length ? <EmptyState title="No join codes" description="Create one to enroll a group at once." /> : (
          <Table label="Join codes" head={<><th scope="col">Code</th><th scope="col">Role · note</th><th scope="col" className="w-20">Used</th><th scope="col" className="w-28">Expires</th><th scope="col" className="relative w-24"><span className="sr-only">Actions</span></th></>}>
            {codes.map((c) => { const state = joinCodeState(c); return (
              <tr key={c.id}><td className="font-mono text-xs text-ink">{c.code_hint}-·····</td><td className="text-xs text-ink-2">{roles.find((r) => r.id === c.role_id)?.name || 'Marine'}{c.note ? ` · ${c.note}` : ''}</td><td className="fig text-xs">{c.uses}{c.max_uses != null ? ` of ${c.max_uses}` : ''}</td><td className="text-xs">{c.expires_at ? <DateText value={c.expires_at} /> : <span className="text-ink-3">Until revoked</span>}</td><td className="text-right">{state.label === 'Live' ? <Button size="xs" variant="ghost" aria-label={`Revoke join code ${c.code_hint}`} onClick={() => setRevoking(c)}>Revoke</Button> : <Badge tone={state.tone}>{state.label}</Badge>}</td></tr>
            ); })}
          </Table>
        )}
      </Panel>
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => { if (!o) setRevoking(null); }} title={`Revoke join code ${revoking?.code_hint}?`} body="Nobody else can join with it. Marines who already joined stay in the unit." confirmLabel="Revoke" onConfirm={async () => { try { await api.revokeJoinCode(unitId, revoking.id); refetch(); toast.success('Join code revoked.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}

function Roles({ unitId, unitLabel }: { unitId: string; unitLabel: (id: string) => string }) {
  const toast = useToast(); const qc = useQueryClient();
  const { data, isPending } = useRoles();
  const [editing, setEditing] = useState<any>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<any>(null);
  const roles = (data?.roles || []).filter((r) => r.unit_id === unitId);
  const myPosition = data?.positions?.[unitId] ?? 0;
  const save = async () => {
    setBusy(true);
    try {
      const body = { unit_id: unitId, name: editing.name, description: editing.description || null, color: editing.color || null, position: Number(editing.position) || 0, permissions: editing.permissions };
      if (editing.id) { const r = await api.updateRole(editing.id, body); if (r.sessionsRevoked) toast.info(`${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'} signed out so the change applies.`); } else await api.createRole(body);
      qc.invalidateQueries({ queryKey: keys.roles }); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role saved.'); setEditing(null);
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const togglePerm = (bit: number) => setEditing((e: any) => ({ ...e, permissions: e.permissions & bit ? e.permissions & ~bit : e.permissions | bit }));
  const groups = [...new Set(PERMISSION_LIST.map((p) => p.group))];
  // What the role being edited names now, as saved: a permission a role must name is settled when the role is made.
  const saved = editing?.id ? roles.find((r) => r.id === editing.id)?.permissions ?? null : null;
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm text-ink-2">Roles in <strong className="text-ink">{unitLabel(unitId)}</strong>. Permissions apply in this unit and the units beneath it, never above it. You can only manage roles below your own position ({myPosition}).</p><Button variant="primary" onClick={() => setEditing({ name: '', description: '', color: '#6b7a8f', position: Math.max(0, myPosition - 10), permissions: ROLE_TEMPLATE[1].permissions })}><Shield className="h-4 w-4" />New role</Button></div>
      {isPending ? <Skeleton className="h-40" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {roles.map((r) => (
            <article key={r.id} className="card p-4">
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2"><span className="badge-dot h-3 w-3" style={{ backgroundColor: r.color || '#6b7a8f' }} /><h3 className="text-base font-semibold text-ink">{r.name}</h3>{r.is_default ? <Badge>Default</Badge> : null}{r.key === 'unit-leader' ? <Badge tone="accent">Leader</Badge> : null}</div><span className="fig text-xs text-ink-3">pos {r.position}</span></div>
              {r.description && <p className="mt-1 text-sm text-ink-2">{r.description}</p>}
              <ul className="mt-2 flex flex-wrap gap-1">{listPermissions(r.permissions).map((k) => <li key={k}><Badge tone={k === 'ADMINISTRATOR' ? 'bad' : 'neutral'}>{PERMISSION_LIST.find((p) => p.key === k)?.label}</Badge></li>)}</ul>
              {r.editable && <div className="mt-3 flex justify-end gap-1 border-t border-line pt-2"><Button size="xs" variant="ghost" onClick={() => setEditing({ ...r, description: r.description || '', color: r.color || '#6b7a8f' })}>Edit</Button>{!r.is_default && r.key !== 'unit-leader' && <Button size="xs" variant="ghost" onClick={() => setConfirm(r)}>Delete</Button>}</div>}
            </article>
          ))}
        </div>
      )}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing?.id ? `Edit ${editing.name}` : 'New role'} description="Changing permissions signs out everyone who holds the role so the new scope applies immediately." footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!editing?.name?.trim()}>Save role</Button></>}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3"><Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} disabled={editing.key === 'unit-leader' || editing.is_default} /></Field><Field label="Position" hint="0-99"><Input type="number" min={0} max={99} className="w-20" value={editing.position} onChange={(e) => setEditing({ ...editing, position: e.target.value })} /></Field><Field label="Color"><input type="color" className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface" value={editing.color || '#6b7a8f'} onChange={(e) => setEditing({ ...editing, color: e.target.value })} aria-label="Role color" /></Field></div>
            <Field label="Description"><Textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-1.5"><span className="text-xs text-ink-3">Start from:</span>{ROLE_TEMPLATE.filter((t) => !t.owner).map((t) => <button key={t.key} type="button" className="rounded-full border border-line px-2 py-0.5 text-2xs hover:border-line-strong" onClick={() => setEditing({ ...editing, permissions: t.permissions })}>{t.name}</button>)}</div>
            {groups.map((g) => <fieldset key={g}><legend className="eyebrow mb-1.5">{g}</legend><div className="space-y-1">{PERMISSION_LIST.filter((p) => p.group === g).map((p) => { const late = namedTooLate(PERMISSIONS[p.key], saved); return <label key={p.key} className={cn('flex items-start gap-2 rounded-md px-2 py-1.5', late ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-surface-2', p.dangerous && 'border border-bad/30')}><input type="checkbox" className="mt-1" checked={Boolean(editing.permissions & PERMISSIONS[p.key])} disabled={late} onChange={() => togglePerm(PERMISSIONS[p.key])} /><span><span className="block text-sm font-medium text-ink">{p.label}</span><span className="block text-xs text-ink-3">{p.hint}</span>{late && <span className="block text-xs text-ink-2">Not for a role that exists. Make a new role that names it.</span>}</span></label>; })}</div></fieldset>)}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Delete the ${confirm?.name} role?`} body="Everyone holding it loses those permissions and is signed out." onConfirm={async () => { try { await api.deleteRole(confirm.id); qc.invalidateQueries({ queryKey: keys.roles }); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role deleted.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </>
  );
}

function Units({ units, manageUnits, orgAdmin, roster }: { units: Unit[]; manageUnits: string[]; orgAdmin: boolean; roster: TeamPerson[] }) {
  const toast = useToast(); const qc = useQueryClient(); const { data: identity } = useIdentity();
  // A unit with no parent founds an organization: Vantage staff set those up.
  const foundsOrgs = Boolean(identity?.platform?.permissions.includes('platform.orgs'));
  const [editing, setEditing] = useState<any>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<any>(null); const [transfer, setTransfer] = useState<any>(null); const [newOwner, setNewOwner] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: keys.org }); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: keys.team }); };
  const save = async () => { setBusy(true); try { if (editing.id) await api.updateUnit(editing.id, { name: editing.name, short_name: editing.short_name || null, echelon: editing.echelon, location: editing.location || null, parent_id: editing.parent_id || null }); else await api.createUnit({ name: editing.name, short_name: editing.short_name || null, echelon: editing.echelon, location: editing.location || null, parent_id: editing.parent_id || null }); refresh(); toast.success('Unit saved.'); setEditing(null); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  const tree = (parent: string | null, depth = 0): Array<Unit & { depth: number }> => units.filter((u) => (u.parent_id || null) === parent).flatMap((u) => [{ ...u, depth }, ...tree(u.id, depth + 1)]);
  const rows = tree(null);
  const orphans = units.filter((u) => u.parent_id && !units.some((p) => p.id === u.parent_id)).map((u) => ({ ...u, depth: 0 }));
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm text-ink-2">Units you can manage. Authority flows down: leading a command reaches every team beneath it, and leading a team reaches nothing above it.</p><Button variant="primary" onClick={() => setEditing({ name: '', short_name: '', echelon: 'section', location: '', parent_id: manageUnits[0] || '' })} disabled={!manageUnits.length}><Building2 className="h-4 w-4" />New unit</Button></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <Table label="Units" head={<><th scope="col">Unit</th><th scope="col" className="w-36">Echelon</th><th scope="col" className="w-40">Leader</th><th scope="col" className="relative w-40"><span className="sr-only">Actions</span></th></>}>
          {[...rows, ...orphans].map((u) => { const owner = roster.find((p) => p.id === u.owner_user_id); const canManage = manageUnits.includes(u.id); return (
            <tr key={u.id}><td><span style={{ paddingLeft: `${u.depth * 16}px` }} className="flex items-center gap-2"><span className="font-medium text-ink">{u.name}</span>{u.short_name && <span className="text-xs text-ink-3">{u.short_name}</span>}<span className="fig text-2xs text-ink-3">{u.code}</span></span></td><td className="text-xs text-ink-2">{ECHELONS.find((e) => e.value === u.echelon)?.label || humanize(u.echelon)}</td><td className="text-xs text-ink-2">{owner ? `${owner.rank_abbr || ''} ${owner.last_name}` : u.owner_user_id === identity?.user.id ? 'You' : u.owner_user_id ? 'Set' : <span className="text-warn">Unclaimed</span>}</td>
              <td className="text-right">{canManage && <span className="flex justify-end gap-1"><Button size="xs" variant="ghost" onClick={() => setEditing({ ...u, short_name: u.short_name || '', location: u.location || '', parent_id: u.parent_id || '' })}>Edit</Button>{(u.owner_user_id === identity?.user.id || orgAdmin) && <Button size="xs" variant="ghost" onClick={() => { setTransfer(u); setNewOwner(''); }}>Transfer</Button>}<Button size="xs" variant="ghost" onClick={() => setConfirm(u)}>Archive</Button></span>}</td></tr>
          ); })}
        </Table>
      </div>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing?.id ? `Edit ${editing.name}` : 'New unit'} size="sm" footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!editing?.name?.trim()}>Save</Button></>}>
        {editing && <div className="space-y-3"><Field label="Name" required><Input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Short name"><Input value={editing.short_name} onChange={(e) => setEditing({ ...editing, short_name: e.target.value })} /></Field><Field label="Echelon"><Select value={editing.echelon} onValueChange={(v) => setEditing({ ...editing, echelon: v })} options={ECHELONS.map((e) => ({ value: e.value, label: e.label }))} /></Field></div><Field label="Location"><Input value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field><Field label="Parent unit" hint={foundsOrgs ? 'none founds a new organization' : 'required: units sit inside your organization'}><Select value={editing.parent_id || '__none'} onValueChange={(v) => setEditing({ ...editing, parent_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'None (a new organization)', disabled: !foundsOrgs }, ...units.filter((u) => u.id !== editing.id && manageUnits.includes(u.id)).map((u) => ({ value: u.id, label: u.short_name || u.name }))]} /></Field></div>}
      </Dialog>
      <Dialog open={Boolean(transfer)} onOpenChange={(o) => { if (!o) setTransfer(null); }} title={`Transfer leadership of ${transfer?.short_name || transfer?.name}`} description="The new leader receives the Unit Leader role. You keep your other roles." size="sm" footer={<><Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button><Button variant="primary" disabled={!newOwner} onClick={async () => { try { await api.transferOwnership(transfer.id, newOwner); refresh(); toast.success('Leadership transferred.'); setTransfer(null); } catch (e) { toast.error(api.errorText(e)); } }}>Transfer</Button></>}>
        <Field label="New leader"><Select value={newOwner} onValueChange={setNewOwner} placeholder="Pick a member" options={roster.filter((p) => p.id !== identity?.user.id && p.memberships.some((m) => m.unit_id === transfer?.id)).map((p) => ({ value: p.id, label: `${p.rank_abbr || ''} ${p.last_name}, ${p.first_name}`.trim() }))} /></Field>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Archive ${confirm?.name}?`} body="Members keep their records; shared entries in this unit are frozen. Sub-units must be moved or archived first." confirmLabel="Archive" onConfirm={async () => { try { await api.archiveUnit(confirm.id); refresh(); toast.success('Unit archived.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </>
  );
}

/** What the unit dashboard shows: what the unit produced (shared outcomes), or one area of its analytics. */
type DashboardShow = 'output' | AnalyticsSection;
const DASHBOARD_SHOWS: Array<{ value: DashboardShow; label: string }> = [
  { value: 'output', label: 'Output' }, { value: 'work', label: 'Casework' }, { value: 'duty', label: 'Duty' }, { value: 'training', label: 'Training' }, { value: 'personnel', label: 'Personnel' },
];
const isDashboardShow = (v: string): v is DashboardShow => DASHBOARD_SHOWS.some((s) => s.value === v);
// The dashboard's window is kept in the address (?days=, or custom dates) so "Print or file" and a shared link carry it.
const dashboardSeed = windowSeed(DASHBOARD_WINDOW);
// The report each part of the dashboard prints as, so "Print or file" carries what is on screen.
const DASHBOARD_REPORTS: Record<DashboardShow, ReportType> = { output: 'unit', work: 'financial', duty: 'duty', training: 'training', personnel: 'personnel' };
const SHOW_LEDES: Record<AnalyticsSection, string> = {
  work: 'Cases this unit and the units beneath it hold: what is open, how old, what came in and what was resolved.',
  duty: 'Duty recorded in the window: who stood how much, of what kind, and what still waits for approval.',
  training: 'Shared training in the window, and where each Marine stands on what the command requires.',
  personnel: 'Who is on the roster today, by grade, team and MOS, and where a supervisor, billet or end date needs a look.',
};

function UnitDashboard({ unitId, unitLabel, canExport, canDetail }: { unitId: string; unitLabel: string; canExport: boolean; canDetail: boolean }) {
  const toast = useToast();
  const [show, setShow] = useParam('show', 'output');
  const shown: DashboardShow = isDashboardShow(show) ? show : 'output';
  const range = useWindowParam(DASHBOARD_WINDOW);
  const { period, custom } = range;
  const { from, to } = useMemo(() => windowDays({ period, from: range.from, to: range.to, custom }), [period, range.from, range.to, custom]);
  // The export holds the dates on screen, or every date: what it held before dates could be chosen (ADR-0039).
  const exportJson = async (days: { from: string; to: string } | null) => {
    try {
      const r = await api.unitExport(unitId, days ?? undefined);
      downloadText(days ? `vantage-${unitId}-${days.from}-to-${days.to}.json` : `vantage-${unitId}-${todayIso()}.json`, JSON.stringify(r, null, 2), 'application/json');
      toast.success(days ? `Unit export for ${formatRange(days.from, days.to)} downloaded.` : 'Unit export of every date downloaded.');
    } catch (e) { toast.error(api.errorText(e)); }
  };
  const exportLabel = <><Download className="h-4 w-4" />Export unit data</>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-tutorial="dashboard-show">
        <Segmented label="Show" value={shown} onChange={setShow} options={DASHBOARD_SHOWS.map((s) => ({ ...s, id: `dashboard-tab-${s.value}`, controls: 'dashboard-panel' }))} />
        {shown !== 'personnel' && <DateRangePicker label="Window" presets={DASHBOARD_WINDOW.options} seed={dashboardSeed} value={range} ignored={range.ignored} onChange={range.set} className="w-40" />}
        <span className="text-xs text-ink-3">{shown === 'output' ? `Shared entries only · ${formatRange(from, to)}` : shown === 'personnel' ? 'As of today' : formatRange(from, to)}</span>
        {canExport && (shown === 'personnel'
          // The roster stands on today, so there are no dates on screen to export by.
          ? <Button className="ml-auto" onClick={() => exportJson(null)}>{exportLabel}</Button>
          : (
            <Menu>
              <MenuTrigger asChild><Button className="ml-auto">{exportLabel}</Button></MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => exportJson({ from, to })}><span className="flex flex-col"><span>These dates</span><span className="text-2xs text-ink-3">{formatRange(from, to)}</span></span></MenuItem>
                <MenuItem onSelect={() => exportJson(null)}><span className="flex flex-col"><span>Every date</span><span className="text-2xs text-ink-3">All of the unit’s shared work</span></span></MenuItem>
              </MenuContent>
            </Menu>
          ))}
      </div>
      {/* The tabs change the address, so one panel holds whichever is chosen, named by its tab. */}
      <div id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${shown}`}>
        {shown === 'output'
          ? <UnitOutput unitId={unitId} unitLabel={unitLabel} from={from} to={to} canExport={canExport} canDetail={canDetail} />
          : <UnitAnalyticsPanel key={`${unitId}:${shown}`} unitId={unitId} section={shown} from={from} to={to} />}
      </div>
    </div>
  );
}

/**
 * Reading a unit's figures is audited, so a read is not repeated on focus or failure, and a minute-old answer is used
 * as it is; a change to the records refreshes it.
 */
const AUDITED_READ = { staleTime: 60_000, refetchOnWindowFocus: false, retry: false } as const;

/** One area of the unit's analytics: every figure answers a question, and every bar opens the records it counts. */
function UnitAnalyticsPanel({ unitId, section, from, to }: { unitId: string; section: AnalyticsSection; from: string; to: string }) {
  const q = useQuery({ queryKey: keys.unitAnalytics(unitId, section, from, to), queryFn: () => api.unitAnalytics(unitId, section, from, to), ...AUDITED_READ });
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError) return <div className="card"><QueryFailure error={q.error} onRetry={() => q.refetch()} what="These figures" /></div>;
  const d = q.data;
  const ask = drill ? { from: d.from, to: d.to, visual: drill.visual.id, key: drill.bucket.key, series: drill.series?.key ?? null } : null;
  const at = drill?.series ? drill.visual.series.findIndex((x) => x.key === drill.series!.key) : -1;
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">{SHOW_LEDES[section]}</p>
      {d.visuals.filter((v) => v.kind === 'kpis').map((v) => <VisualView key={v.id} visual={v} onDrill={setDrill} />)}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {d.visuals.filter((v) => v.kind !== 'kpis').map((v) => <VisualView key={v.id} visual={v} onDrill={setDrill} className={v.kind === 'columns' ? 'lg:col-span-2' : undefined} />)}
      </div>
      {d.notes.length > 0 && <ul className="space-y-1 text-xs leading-relaxed text-ink-3">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {drill && ask && (
        <DrillDialog
          title={`${drill.bucket.label}${drill.series ? ` · ${drill.series.label}` : ''}`}
          description={drill.visual.question}
          queryKey={keys.unitAnalyticsDrill({ unitId, section, ...ask })}
          load={() => api.unitAnalyticsDrill(unitId, section, ask)}
          expected={at >= 0 ? drill.bucket.values[at] : drill.bucket.value}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

/** The Marines the Output tab lists before "Show all": enough to read, few enough that the page below stays a few Tab stops away. */
const MEMBERS_SHOWN = 25;

/**
 * What the unit produced in the window, from shared outcomes: the figures, one metric month by month and by category,
 * readiness, and the members behind it. Each month and category opens the outcomes it adds up.
 */
function UnitOutput({ unitId, unitLabel, from, to, canExport, canDetail }: { unitId: string; unitLabel: string; from: string; to: string; canExport: boolean; canDetail: boolean }) {
  const cfg = useMetrics();
  const dashboard = useQuery({ queryKey: keys.dashboard(unitId, from, to), queryFn: () => api.unitDashboard(unitId, from, to), ...AUDITED_READ });
  const { data } = dashboard;
  const unitMetricParams = useMemo(() => ({ from, to, unit_id: unitId }), [from, to, unitId]);
  const unitMetrics = useMetricsReport(unitMetricParams, true, AUDITED_READ);
  // A brief is of the window it was drafted for; another window on screen puts it away rather than show it under the wrong dates.
  const [drafted, setBrief] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number }; from: string; to: string } | null>(null);
  const brief = drafted && drafted.from === from && drafted.to === to ? drafted : null;
  const series = unitMetrics.data?.monthly || [];
  const [picked, setPicked] = useState('');
  const top = series.find((m) => m.metricId === picked) || series[0];
  const total = top ? [...(unitMetrics.data?.headline || []), ...(unitMetrics.data?.tracked || [])].find((t) => t.metricId === top.metricId) : undefined;
  const [opened, setOpened] = useState<{ month?: string; category?: string; value: number; outcomes: number; label: string } | null>(null);
  const [allMembers, setAllMembers] = useState(false);
  const membersId = useId();
  if (dashboard.isError) return <QueryFailure error={dashboard.error} onRetry={() => dashboard.refetch()} what="The unit’s output" />;
  if (dashboard.isPending || !data) return <Skeleton className="h-64" />;
  const t = data.totals;
  // The server lists only the Marines the reader may see by Marine; the page shows the first of them, and says so.
  const members: any[] = data.members;
  const listed = allMembers ? members : members.slice(0, MEMBERS_SHOWN);
  const format: FigureFormat = total?.kind === 'money' ? 'money' : total?.kind === 'duration' ? 'hours' : 'number';
  const noun = 'outcome';
  const months = top ? clientVisual({
    id: 'output_months', question: `How much ${top.metricLabel.toLowerCase()} did the unit record each month?`, kind: 'columns', format, noun,
    buckets: top.points.map((p) => ({ key: p.key, label: p.label, values: [p.value], counts: [p.outcomes] })),
  }) : null;
  const categories = top ? clientVisual({
    id: 'output_categories', question: `Where did the ${top.metricLabel.toLowerCase()} land?`, kind: 'bars', format, noun,
    note: 'By the category each outcome was recorded under.',
    buckets: (unitMetrics.data?.byCategory || []).map((c) => ({ c, m: c.totals.find((x) => x.metricId === top.metricId) }))
      .filter((x) => x.m && x.m.outcomes)
      .map(({ c, m }) => ({ key: c.value, label: c.value, values: [m!.value], counts: [m!.outcomes] }))
      .sort((a, b) => b.values[0] - a.values[0]),
  }) : null;
  const picker = series.length > 1 ? <Select aria-label="Figure" className="w-48" value={top?.metricId || ''} onValueChange={setPicked} options={series.map((m) => ({ value: m.metricId, label: m.metricLabel }))} /> : null;
  const onMonth: OnDrill = ({ bucket }) => {
    const point = top?.points.find((p) => p.key === bucket.key);
    if (point) setOpened({ month: point.key, value: point.value, outcomes: point.outcomes, label: `in ${point.label}` });
  };
  const onCategory: OnDrill = ({ bucket }) => setOpened({ category: bucket.key, value: bucket.value, outcomes: bucket.count, label: `under ${bucket.label}, ${formatRange(from, to)}` });
  return (
    <div className="space-y-4">
      <div>
        <h3 className="eyebrow mb-2">What the unit produced in this window</h3>
        <MetricTotalsGrid
          headline={unitMetrics.data?.headline || []}
          tracked={unitMetrics.data?.tracked || []}
          prior={unitMetrics.data?.priorHeadline || []}
          params={unitMetricParams}
          emptyTitle="Nothing measurable shared in this window"
          emptyDescription="Members have shared no entry carrying a quantity, a value, or logged hours."
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Members" value={t.members} hint={`${t.contributors} shared something`} />
        <Stat label="Outcomes with a result" value={`${t.completeness}%`} hint={t.completeness >= 100 ? 'every one says what came of it' : 'the rest need a result written'} tone={t.completeness < 60 ? 'warn' : undefined} />
        <Stat label="Needs attention" value={t.overdue_tasks + t.counseling_due} hint={`${t.overdue_tasks} overdue tasks, ${t.counseling_due} counselings due`} tone={t.overdue_tasks + t.counseling_due ? 'warn' : 'good'} />
      </div>
      {months && categories ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <VisualView className="lg:col-span-2" visual={months} onDrill={onMonth} first="Month" actions={picker} />
          <VisualView visual={categories} onDrill={onCategory} first="Category" />
        </div>
      ) : (
        <div className="card"><EmptyState title="Not enough shared outcomes for a chart yet" description="Shared outcomes that carry a quantity, a value or hours will show month by month here." /></div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Readiness and pipeline"><dl className="grid grid-cols-2 gap-2 text-sm">{[['Avg PFT', t.avg_pft ?? NO_VALUE], ['Avg CFT', t.avg_cft ?? NO_VALUE], ['Readiness reported', `${t.readiness_reported}/${t.members}`], ['Active goals', t.active_goals], ['Goals achieved', t.goals_achieved], ['Awards in progress', t.awards_in_progress]].map(([k, v]) => <div key={String(k)} className="rounded-md border border-line px-3 py-2"><dt className="eyebrow">{k}</dt><dd className="fig mt-0.5 font-semibold text-ink">{String(v)}</dd></div>)}</dl></Panel>
        <Panel className="lg:col-span-2" title="Members" subtitle={canDetail ? 'open a Marine to see their shared record' : 'member detail requires the Open member records permission'} padded={false}>
          {!members.length ? <EmptyState title={canDetail ? 'No members' : 'Member breakdown hidden'} /> : (
            <>
            <div id={membersId}>
            <Table label="Members" head={<><th>Marine</th><th className="w-28 text-right">{cfg.currency_label}</th><th className="w-24 text-right">With a result</th><th className="w-24 text-right" title="How many outcomes they shared. Provenance for the figures, not a score.">Shared</th><th className="w-24">Last shared</th><th className="w-28">Counseling</th></>}>
              {listed.map((m) => <tr key={m.id}><td><Link to={`/team/${m.id}`} className="font-medium text-ink hover:underline">{m.rank_abbr || ''} {m.name}</Link>{(m.team || m.billet) && <span className="block text-xs text-ink-3">{[m.team, m.billet].filter(Boolean).join(' · ')}</span>}</td><td className="fig text-right text-xs">{m.dollars ? formatDollars(m.dollars) : ''}</td><td className={cn('fig text-right text-xs', m.completeness != null && m.completeness < 60 && 'text-warn')}>{m.completeness == null ? NO_VALUE : `${m.completeness}%`}</td><td className="fig text-right text-xs text-ink-3">{m.entries}</td><td className="text-xs"><DateText value={m.last_entry} fallback="none" /></td><td>{m.counseling_due ? <Badge tone="warn">Due</Badge> : <span className="text-xs text-ink-3"><DateText value={m.last_counseling} fallback="" /></span>}</td></tr>)}
            </Table>
            </div>
            {members.length > MEMBERS_SHOWN && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-3">
                {allMembers ? null : <span>Showing the first {MEMBERS_SHOWN} of {members.length}.</span>}
                <button type="button" className="link no-print" aria-expanded={allMembers} aria-controls={membersId} onClick={() => setAllMembers(!allMembers)}>{allMembers ? 'Show fewer' : `Show all ${members.length}`}</button>
              </p>
            )}
            </>
          )}
        </Panel>
      </div>
      {canExport && <Panel title="Command brief" subtitle="AI summarizes aggregate totals only; no names leave the server" action={<AiAction workflow="command_brief" input={{ unit_id: unitId, from, to }} label="Draft brief" onResult={(output, meta) => setBrief({ output, meta, from, to })} />}>{brief ? <AiResult output={brief.output} meta={brief.meta} primaryKey="executive_summary" /> : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />A one-paragraph read of {unitLabel} for the window above.</p>}</Panel>}
      {opened && total && (
        <ContributorsDialog
          total={total}
          params={{ ...unitMetricParams, category: opened.category, month: opened.month }}
          figure={{ value: opened.value, outcomes: opened.outcomes, label: opened.label }}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}

/**
 * The unit's access log, newest first, a page at a time. Each entry names who opened what and whose it was; a read that
 * fails says so rather than showing an empty log.
 */
function UnitAudit({ unitId }: { unitId: string }) {
  const log = useInfiniteQuery({
    queryKey: ['unit-audit', unitId],
    queryFn: ({ pageParam }) => api.unitAudit(unitId, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last: api.AccessLogPage<api.UnitAccessRow>) => last.next,
    enabled: Boolean(unitId), refetchOnWindowFocus: false, retry: false,
  });
  const rows = (log.data?.pages ?? []).flatMap((p) => p.rows);
  // Focus moves to the first entry a page added, so it is not lost when the button goes after the last page.
  const focusWhenShown = useFocusWhenShown();
  const loadOlder = async () => {
    const before = rows.length;
    const added = ((await log.fetchNextPage()).data?.pages ?? []).flatMap((p) => p.rows)[before];
    if (added) focusWhenShown(`unit-access-${added.id}`);
  };
  return (
    <Panel title="Who has been reading records in this unit" subtitle="Every cross-person open is logged with the actor, the subject, and the time" padded={false}>
      {log.isPending ? <div className="p-3" aria-hidden><Skeleton className="h-48" /></div>
        : log.isError && !log.data ? <QueryFailure className="" error={log.error} onRetry={() => log.refetch()} what="The access log" />
        : !rows.length ? <EmptyState icon={ClipboardList} title="No access events yet" /> : (
          <>
            <Table label="Who has been reading records in this unit" head={<><th className="w-40">When</th><th className="w-40">Who</th><th>Action</th><th className="w-40">Subject</th><th>Detail</th></>}>
              {rows.map((r) => (
                <tr key={r.id} id={`unit-access-${r.id}`} tabIndex={-1}>
                  <td className="fig text-xs text-ink-3">{formatStamp(r.at)}</td>
                  <td className="text-xs">{fullName({ rank_abbr: r.actor_rank, first_name: r.actor_first, last_name: r.actor_last }) || 'system'}</td>
                  <td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}</td>
                  <td className="text-xs">{fullName({ first_name: r.subject_first, last_name: r.subject_last })}</td>
                  <td className="text-xs text-ink-3 [overflow-wrap:anywhere]">{r.detail}</td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line p-3">
              <span className="text-xs text-ink-3" role="status" aria-live="polite">{rows.length} shown, newest first</span>
              {log.isFetchNextPageError && <span className="text-xs text-bad" role="alert">Older entries could not load. {api.errorText(log.error)}</span>}
              {log.hasNextPage && <Button size="sm" onClick={loadOlder} loading={log.isFetchingNextPage}>{log.isFetchNextPageError ? 'Try again' : 'Load older'}</Button>}
            </div>
          </>
        )}
    </Panel>
  );
}
