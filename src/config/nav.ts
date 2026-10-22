import {
  Award, BarChart3, BookOpen, BookOpenCheck, Briefcase, Building2, CalendarRange, ClipboardList, Compass, FileClock, FilePen, FileText, FolderKanban,
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
  /** Opens a console of its own, outside the application. */
  away?: boolean;
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
  /** Sits at the foot of the menu, with Settings, rather than among the destinations. */
  foot?: boolean;
}

export const HOME: NavPage = { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', hint: 'What needs you now' };

/**
 * The menu, in the order of the specification's top-level structure (ADR-0016). A page sits in the group that answers
 * its question, and keeps its address when it moves between groups: /career/awards is Records → Awards. The header,
 * the document title, the palette, the shortcuts and every sentence that names a place (placeName) read it from here.
 */
export const GROUPS: NavGroup[] = [
  {
    id: 'work', label: 'Work', icon: Briefcase, key: 'w', hint: 'Taskers, tasks, correspondence and the reference you work from', also: ['/work/items', '/records/tasks', '/records/projects'], pages: [
      { to: '/work/queue', label: 'Queue', icon: Inbox, hint: 'Work to claim, and the work you hold' },
      { to: '/work/tasks', label: 'Tasks', icon: ListChecks, hint: 'Your to-dos and the ones assigned to you', count: 'tasks' },
      { to: '/work/projects', label: 'Projects', icon: FolderKanban, hint: 'Taskers and projects with their tasks' },
      { to: '/work/correspondence', label: 'Correspondence', icon: Mail, hint: 'Threads, replies owed and contacts', count: 'mail' },
      { to: '/reference', label: 'Reference', icon: Library, key: 'f', hint: 'The FMRA desk reference and balance diagnoser' },
    ],
  },
  {
    id: 'records', label: 'Records', icon: BookOpenCheck, key: 'r', hint: 'What you did, and what backs it up', also: ['/records'], pages: [
      { to: '/record', end: true, label: 'Overview', icon: LayoutDashboard, hint: 'Your record at a glance' },
      { to: '/record/timeline', label: 'Timeline', icon: CalendarRange, hint: 'Everything you recorded, newest first' },
      { to: '/record/activities', label: 'Activities', icon: NotebookPen, hint: 'Every activity you logged' },
      { to: '/career/awards', label: 'Awards', icon: Award, hint: 'Recommendations and what came of them' },
      { to: '/career/counseling', label: 'Counseling', icon: MessagesSquare, hint: 'Counselings given and received' },
      { to: '/record/drafts', label: 'Drafts', icon: FilePen, hint: 'Entries drawn from your work, waiting for you', count: 'drafts' },
      { to: '/record/contributions', label: 'Contributions', icon: Workflow, hint: 'What you did on each case you worked' },
    ],
  },
  {
    id: 'personnel', label: 'Personnel', icon: Users, key: 't', hint: 'The Marines in your units, and what they hold', when: { unit: true }, also: ['/team'], pages: [
      { to: '/team', end: true, label: 'Overview', icon: LayoutDashboard, hint: 'Who is in this view and how it is doing', when: { team: 'overview' } },
      { to: '/team/roster', label: 'Roster', icon: UsersRound, hint: 'Members, billets and moves', when: { team: 'roster' } },
      { to: '/team/workload', label: 'Workload', icon: FileClock, hint: 'Who holds what, and what they did', when: { team: 'workload' } },
    ],
  },
  {
    id: 'development', label: 'Training & Development', icon: GraduationCap, key: 'c', hint: 'Training, goals and where you are headed', also: ['/records/goals'], pages: [
      { to: '/career/training', label: 'Training', icon: BookOpen, hint: 'PME, courses and certifications' },
      { to: '/career', end: true, label: 'Career plan', icon: Compass, hint: 'Next steps toward where you are headed' },
      { to: '/goals', label: 'Goals', icon: Target, key: 'g', hint: 'Targets and measurable progress' },
      { to: '/career/readiness', label: 'Readiness', icon: HeartPulse, hint: 'PFT, CFT, rifle, medical and the rest' },
      { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', hint: 'Messages that change a requirement', when: { maradmins: true } },
    ],
  },
  {
    id: 'reports', label: 'Reports & Analytics', icon: FileText, key: 'p', hint: 'Evaluation input, and what the records show', pages: [
      { to: '/reports', end: true, label: 'Packages', icon: ClipboardList, hint: 'Write a JEPES or FITREP report against the records it cites' },
      { to: '/reports/analysis', label: 'Analysis', icon: BarChart3, hint: 'What your record shows, by period' },
      { to: '/team/dashboard', label: 'Unit dashboard', icon: BarChart3, hint: 'The unit’s shared work, in figures', when: { team: 'dashboard' } },
    ],
  },
  {
    id: 'admin', label: 'Administration', icon: ShieldCheck, key: 'a', hint: 'Who may do what, and who opened what', pages: [
      { to: '/team/invitations', label: 'Invitations', icon: UserPlus, hint: 'Invitation links and join codes', when: { team: 'invites' } },
      { to: '/team/roles', label: 'Roles', icon: KeyRound, hint: 'Who may do what, and where', when: { team: 'roles' } },
      { to: '/team/units', label: 'Units', icon: Building2, hint: 'The chain of command', when: { team: 'units' } },
      { to: '/team/access-log', label: 'Access log', icon: History, hint: 'Who opened what in this unit', when: { team: 'audit' } },
      { to: '/console', label: 'Unit Manager console', icon: ShieldCheck, key: 'o', away: true, hint: 'Run your Unit Instance: people, units, roles, the roster feed', when: { orgRole: true, notDemo: true } },
      { to: '/admin', label: 'Vantage Administrator console', icon: KeyRound, away: true, hint: 'Run the service', when: { staff: true, notDemo: true } },
      // The demo has no Unit Manager console (every visitor shares the instance); this shows what one governs instead.
      { to: '/governance', label: 'Unit Manager console', icon: ShieldCheck, hint: 'What a Unit Manager governs', when: { demo: true } },
    ],
  },
  {
    id: 'help', label: 'Help', icon: LifeBuoy, key: 'h', hint: 'How Vantage works, and a person to ask', foot: true, pages: [
      { to: '/help', label: 'Field guide', icon: BookOpenCheck, hint: 'How Vantage works, and where everything is' },
      { to: '/support', label: 'Support', icon: LifeBuoy, hint: 'Ask a person', when: { notDemo: true } },
    ],
  },
];

export const FOOTER: NavPage[] = [
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', hint: 'Your profile, security and preferences' },
];

/** Every page, for the command palette, the shortcuts and the header. */
export const ALL_PAGES: NavPage[] = [HOME, ...GROUPS.flatMap((g) => g.pages), ...FOOTER];

const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/**
 * The page a path is, or sits beneath: the longest match wins, so /career/awards is Awards, not Career plan. A trailing
 * slash is ignored, as the router ignores it: /record/ is Records → Overview.
 */
export function pageFor(pathname: string): NavPage | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  return [...ALL_PAGES].filter((p) => (p.end || p.to === '/' ? path === p.to : under(path, p.to))).sort((a, b) => b.to.length - a.to.length)[0];
}

/**
 * The group a path belongs to: the group of the page it is, since a page keeps its address when it changes group
 * (/team/roles is Administration, /team/roster Personnel); otherwise the group that claims the path beneath its pages
 * (a case, an entry, a Marine's page), the longest claim winning: a goal at /records/goals/<id> is Training &
 * Development's, though Records claims /records. Today and Settings belong to none.
 */
export function groupFor(pathname: string): NavGroup | undefined {
  const page = pageFor(pathname);
  if (page) return GROUPS.find((g) => g.pages.includes(page));
  const claims = GROUPS.flatMap((g) => (g.also || []).filter((a) => under(pathname, a)).map((a) => ({ g, a })));
  return claims.sort((x, y) => y.a.length - x.a.length)[0]?.g;
}

/** Where a page is, the way the menu names it: "Records → Awards", or "Today". For sentences that tell someone where to look. */
export function placeName(to: string): string {
  const page = pageFor(to.split(/[?#]/)[0]);
  if (!page) return to;
  const group = GROUPS.find((g) => g.pages.includes(page));
  return group ? `${group.label} → ${page.label}` : page.label;
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
