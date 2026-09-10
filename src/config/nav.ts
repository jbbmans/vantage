import {
  Gauge, ListChecks, Briefcase, Target, GraduationCap, FileBarChart, Users, ScrollText, Activity, Sparkles, Settings2, ShieldCheck, LifeBuoy,
  type LucideIcon,
} from 'lucide-react';

/** Navigation is grouped by what a person is trying to do, not by which table the data lives in. */
export type NavGroup = 'Work' | 'Record' | 'Organization' | 'More';
export const NAV_GROUPS: NavGroup[] = ['Work', 'Record', 'Organization', 'More'];

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
  { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', group: 'Work', hint: 'What needs you now' },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'w', group: 'Work', hint: 'Tasks, projects and cases' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g', group: 'Work', hint: 'Targets and how they are tracking' },
  { to: '/records', label: 'Records', icon: ListChecks, key: 'r', group: 'Record', hint: 'Every outcome you logged' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, key: 'p', group: 'Record', hint: 'Build a package from the facts' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c', group: 'Record', hint: 'Training, awards, counseling' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'j', group: 'Record', hint: 'Dates and requirements' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true, group: 'Organization', hint: 'People and workload' },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', group: 'Organization', hint: 'Messages that affect you' },
  { to: '/assist', label: 'AI assist', icon: Sparkles, key: 'a', requiresAi: true, group: 'Organization', hint: 'Drafting help' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true, group: 'More' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true, group: 'More' },
  { to: '/help', label: 'Help', icon: LifeBuoy, key: 'h', secondary: true, group: 'More' },
];
