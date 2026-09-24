import {
  Gauge, Target, GraduationCap, Users, Settings2, ShieldCheck, LifeBuoy, FileText, Briefcase, BookOpenCheck,
  ScrollText, Library,
  type LucideIcon,
} from 'lucide-react';

/**
 * Five destinations, each answering one question a Marine actually asks:
 *
 *   Today   What do I need to do, what am I waiting on, and what can I quickly record?
 *   Work    What work exists, what is mine, what can I claim, and where does it stand?
 *   Record  What have I actually done, and what evidence supports it?
 *   Goals   What am I working toward, and how far have I come?
 *   Career  Where am I professionally, and what are my next steps?
 *
 * Team appears for people who lead a unit, because a leader should not need an administration
 * console to see who is carrying what. Reports, MARADMINs and settings stay one click away under
 * More rather than competing with the five.
 *
 * Nothing that used to exist was removed to get here. Readiness is now a tab of Career (it is part
 * of where you stand), activities are a tab of Record (they are what you did), and every old path
 * still lands on the tab that absorbed it.
 */
export type NavGroup = 'Primary' | 'Knowledge' | 'Leading' | 'More';
export const NAV_GROUPS: NavGroup[] = ['Primary', 'Knowledge', 'Leading', 'More'];

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  key: string;
  group: NavGroup;
  /** One line under the label in the command palette and on mobile. */
  hint?: string;
  end?: boolean;
  requiresLead?: boolean;
  requiresOperator?: boolean;
  requiresAi?: boolean;
  /** Hidden when the owner has not turned the MARADMIN feed on, so the rail never offers a dead end. */
  requiresMaradmins?: boolean;
  /** Hidden in the synthetic demo, where accounts and deployment settings are not part of the story. */
  hideInDemo?: boolean;
  secondary?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', group: 'Primary', hint: 'What needs you now' },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'w', group: 'Primary', hint: 'Taskers, the queue, and what is yours' },
  { to: '/record', label: 'Record', icon: BookOpenCheck, key: 'r', group: 'Primary', hint: 'What you did and what backs it up' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g', group: 'Primary', hint: 'Targets and measurable progress' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c', group: 'Primary', hint: 'Next steps, training, readiness' },
  // The FMRA desk reference: how money moves, how each purchase method is evidenced, and what an
  // open balance or a UMT means — with a diagnoser that reads the four figures and says what to check.
  { to: '/reference', label: 'Reference', icon: Library, key: 'f', group: 'Knowledge', hint: 'The FMRA desk reference and balance diagnoser' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true, group: 'Leading', hint: 'Workload, people, and units' },
  { to: '/reports', label: 'Reports', icon: FileText, key: 'p', group: 'More', secondary: true, hint: 'JEPES and FITREP input from the facts' },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', group: 'More', secondary: true, hint: 'Messages that change a requirement', requiresMaradmins: true },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true, group: 'More' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true, group: 'More', hideInDemo: true },
  { to: '/help', label: 'Field guide', icon: LifeBuoy, key: 'h', secondary: true, group: 'More' },
];

/**
 * Where a retired destination now lives. Old links, bookmarks and anything a person pasted into a
 * message keep working and land on the tab that absorbed them.
 */
export const NAV_REDIRECTS: Record<string, string> = {
  '/queue': '/work?tab=queue',
  '/correspondence': '/work?tab=mail',
  '/studio': '/reports?tab=packages',
  '/activities': '/record?tab=entries',
  '/records': '/record?tab=entries',
  '/readiness': '/career?tab=readiness',
  '/assist': '/',
};
