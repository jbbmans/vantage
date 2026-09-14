import {
  Gauge, ListChecks, Target, GraduationCap, Users, Activity, Settings2, ShieldCheck, LifeBuoy, FileText, Briefcase,
  type LucideIcon,
} from 'lucide-react';

/**
 * Navigation is grouped by what a person is trying to do, not by which table the data lives in.
 *
 * Every destination here answers a question somebody actually asks. Where two destinations answered
 * the same question they were merged into one with tabs: the queue, tasks, projects and the email
 * behind them are all "what is waiting on me", so they are one Work screen; writing a package and
 * reading what the record shows are both Reports; MARADMINs sit inside Career because the only
 * reason to read one is that it changes your record.
 */
export type NavGroup = 'Workspace' | 'Growth' | 'Organization' | 'More';
export const NAV_GROUPS: NavGroup[] = ['Workspace', 'Growth', 'Organization', 'More'];

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
  secondary?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', group: 'Workspace', hint: 'What needs you now' },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'w', group: 'Workspace', hint: 'Queue, tasks, and the email behind them' },
  { to: '/records', label: 'Records', icon: ListChecks, key: 'r', group: 'Workspace', hint: 'Every outcome you logged' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c', group: 'Growth', hint: 'Training, awards, counseling' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g', group: 'Growth', hint: 'Targets and how they are tracking' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'j', group: 'Growth', hint: 'Dates and requirements' },
  { to: '/reports', label: 'Reports', icon: FileText, key: 'p', group: 'Growth', hint: 'Write a package against the facts' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true, group: 'Organization', hint: 'People, units, and workload' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true, group: 'More' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true, group: 'More' },
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
  '/maradmins': '/career?tab=messages',
  '/activities': '/records',
  '/assist': '/',
};
