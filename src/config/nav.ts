import {
  Award, BarChart3, BookOpen, BookOpenCheck, Briefcase, Building2, ClipboardList, Compass, FileClock, FilePen, FileText, FolderKanban,
  Gauge, GraduationCap, HeartPulse, History, Inbox, KeyRound, LayoutDashboard, Library, LifeBuoy, ListChecks, Mail, MessagesSquare,
  NotebookPen, ScrollText, Settings2, ShieldCheck, Target, UserPlus, Users, UsersRound, Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { TeamSection } from '@/lib/teamAccess';

/** Who sees a page. Unset means everyone. */
export interface Requirement {
  /** Belongs to, or leads, at least one unit. */
  unit?: boolean;
  /** Holds a Unit Instance role: Lead Unit Manager, Unit Manager, Records Officer or Unit Auditor (the Unit Manager console). */
  orgRole?: boolean;
  /** Vantage staff (the Vantage Administrator console). */
  staff?: boolean;
  maradmins?: boolean;
  /** Not offered in the synthetic demo. */
  notDemo?: boolean;
  /** Offered only in the synthetic demo. */
  demo?: boolean;
  /** One of the Team sections, which depend on the view and on the permissions held in it. */
  team?: TeamSection;
}

export type Count = 'tasks' | 'mail' | 'drafts';

export interface NavPage {
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line under the label in the command palette, and under the title in the header. */
  hint: string;
  /** G then this key. */
  key?: string;
  /** Matches only this path, not the paths beneath it. */
  end?: boolean;
  when?: Requirement;
  count?: Count;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  key: string;
  pages: NavPage[];
  when?: Requirement;
  /** Paths outside the group's own pages that still belong to it (a record's detail page, say). */
  also?: string[];
}

export const HOME: NavPage = { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', hint: 'What needs you now' };

export const GROUPS: NavGroup[] = [
  {
    id: 'work', label: 'Work', icon: Briefcase, key: 'w', hint: 'Taskers, tasks and the correspondence behind them', also: ['/work/items'], pages: [
      { to: '/work/queue', label: 'Queue', icon: Inbox, hint: 'Work to claim, and the work you hold' },
      { to: '/work/tasks', label: 'Tasks', icon: ListChecks, hint: 'Your to-dos and the ones assigned to you', count: 'tasks' },
      { to: '/work/projects', label: 'Projects', icon: FolderKanban, hint: 'Taskers and projects with their tasks' },
      { to: '/work/correspondence', label: 'Correspondence', icon: Mail, hint: 'Threads, replies owed and contacts', count: 'mail' },
    ],
  },
  {
    id: 'record', label: 'Record', icon: BookOpenCheck, key: 'r', hint: 'What you did and what backs it up', also: ['/records'], pages: [
      { to: '/record', end: true, label: 'Overview', icon: LayoutDashboard, hint: 'Your record at a glance' },
      { to: '/record/activities', label: 'Activities', icon: NotebookPen, hint: 'Every activity you logged' },
      { to: '/record/drafts', label: 'Drafts', icon: FilePen, hint: 'Entries drawn from your work, waiting for you', count: 'drafts' },
      { to: '/record/contributions', label: 'Contributions', icon: Workflow, hint: 'What you did on each case you worked' },
      { to: '/goals', label: 'Goals', icon: Target, key: 'g', hint: 'Targets and measurable progress' },
    ],
  },
  {
    id: 'career', label: 'Career', icon: GraduationCap, key: 'c', hint: 'Where you are headed, and what backs it up', pages: [
      { to: '/career', end: true, label: 'Plan', icon: Compass, hint: 'Next steps toward where you are headed' },
      { to: '/career/training', label: 'Training', icon: BookOpen, hint: 'PME, courses and certifications' },
      { to: '/career/awards', label: 'Awards', icon: Award, hint: 'Recommendations and what came of them' },
      { to: '/career/counseling', label: 'Counseling', icon: MessagesSquare, hint: 'Counselings given and received' },
      { to: '/career/readiness', label: 'Readiness', icon: HeartPulse, hint: 'PFT, CFT, rifle, medical and the rest' },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: FileText, key: 'p', hint: 'JEPES and FITREP input from the facts', pages: [
      { to: '/reports', end: true, label: 'Packages', icon: ClipboardList, hint: 'Write a report against the records it cites' },
      { to: '/reports/analysis', label: 'Analysis', icon: BarChart3, hint: 'What your record shows, by period' },
    ],
  },
  {
    id: 'team', label: 'Team', icon: Users, key: 't', hint: 'Your team and the command above it', when: { unit: true }, pages: [
      { to: '/team', end: true, label: 'Overview', icon: LayoutDashboard, hint: 'Who is in this view and how it is doing', when: { team: 'overview' } },
      { to: '/team/workload', label: 'Workload', icon: FileClock, hint: 'Who holds what, and what they did', when: { team: 'workload' } },
      { to: '/team/roster', label: 'Roster', icon: UsersRound, hint: 'Members, billets and moves', when: { team: 'roster' } },
      { to: '/team/dashboard', label: 'Unit dashboard', icon: BarChart3, hint: 'The unit’s shared work, in figures', when: { team: 'dashboard' } },
      { to: '/team/invitations', label: 'Invitations', icon: UserPlus, hint: 'Invitation links and join codes', when: { team: 'invites' } },
      { to: '/team/roles', label: 'Roles', icon: KeyRound, hint: 'Who may do what, and where', when: { team: 'roles' } },
      { to: '/team/units', label: 'Units', icon: Building2, hint: 'The chain of command', when: { team: 'units' } },
      { to: '/team/access-log', label: 'Access log', icon: History, hint: 'Who opened what in this unit', when: { team: 'audit' } },
    ],
  },
  {
    id: 'knowledge', label: 'Knowledge', icon: Library, key: 'k', hint: 'The reference, the messages and the guide', pages: [
      { to: '/reference', label: 'Reference', icon: Library, key: 'f', hint: 'The FMRA desk reference and balance diagnoser' },
      { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', hint: 'Messages that change a requirement', when: { maradmins: true } },
      { to: '/help', label: 'Field guide', icon: BookOpenCheck, key: 'h', hint: 'How Vantage works' },
      { to: '/support', label: 'Support', icon: LifeBuoy, hint: 'Ask a person', when: { notDemo: true } },
    ],
  },
];

export const FOOTER: NavPage[] = [
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', hint: 'Your profile, security and preferences' },
  { to: '/console', label: 'Unit Manager console', icon: ShieldCheck, key: 'o', hint: 'Run your Unit Instance: people, units, roles, the roster feed', when: { orgRole: true, notDemo: true } },
  { to: '/admin', label: 'Vantage Administrator console', icon: KeyRound, hint: 'Run the service', when: { staff: true, notDemo: true } },
  // The demo has no Unit Manager console (every visitor shares the instance); this shows what one governs instead.
  { to: '/governance', label: 'Unit Manager console', icon: ShieldCheck, hint: 'What a Unit Manager governs', when: { demo: true } },
];

/** Every page, for the command palette, the shortcuts and the header. */
export const ALL_PAGES: NavPage[] = [HOME, ...GROUPS.flatMap((g) => g.pages), ...FOOTER];

const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/** The page a path is, or sits beneath: the longest match wins, so /career/awards is Awards, not Plan. */
export function pageFor(pathname: string): NavPage | undefined {
  return [...ALL_PAGES].filter((p) => (p.end || p.to === '/' ? pathname === p.to : under(pathname, p.to))).sort((a, b) => b.to.length - a.to.length)[0];
}

export function groupFor(pathname: string): NavGroup | undefined {
  return GROUPS.find((g) => g.pages.some((p) => p.to !== '/' && under(pathname, p.to)) || (g.also || []).some((a) => under(pathname, a)));
}

/**
 * Old addresses: the destinations that were tabs of one page (/work?tab=mail), and the ones merged into them
 * before that (/correspondence). Each is answered with where it lives now, keeping the rest of its query.
 */
const TABS: Record<string, Record<string, string>> = {
  '/work': { '': '/work/queue', queue: '/work/queue', tasks: '/work/tasks', projects: '/work/projects', mail: '/work/correspondence' },
  '/record': { overview: '/record', entries: '/record/activities', drafts: '/record/drafts', contributions: '/record/contributions' },
  '/career': { plan: '/career', training: '/career/training', awards: '/career/awards', counseling: '/career/counseling', readiness: '/career/readiness', messages: '/maradmins' },
  '/reports': { packages: '/reports', analysis: '/reports/analysis' },
  '/team': { overview: '/team', workload: '/team/workload', roster: '/team/roster', dashboard: '/team/dashboard', invites: '/team/invitations', roles: '/team/roles', units: '/team/units', audit: '/team/access-log' },
};

export const MOVED: Record<string, string> = {
  '/queue': '/work/queue',
  '/correspondence': '/work/correspondence',
  '/studio': '/reports',
  '/activities': '/record/activities',
  '/records': '/record/activities',
  '/readiness': '/career/readiness',
  '/assist': '/',
};

/** Where an old address lives now, or null when it is current. */
export function movedTo(pathname: string, search: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  let target = MOVED[path] ?? null;
  if (!target && TABS[path] && (tab !== null || TABS[path][''])) target = TABS[path][tab ?? ''] ?? TABS[path][''] ?? path;
  if (!target) return null;
  params.delete('tab');
  const rest = params.toString();
  return `${target}${rest ? `?${rest}` : ''}`;
}
