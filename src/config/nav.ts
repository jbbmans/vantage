import {
  Gauge, ListChecks, Briefcase, Target, GraduationCap, FileBarChart, Users, ScrollText, Activity, Mail, Settings2, ShieldCheck, LifeBuoy, Inbox, FileText,
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
  { to: '/queue', label: 'Queue', icon: Inbox, key: 'q', group: 'Work', hint: 'Imported work, and who is holding it' },
  { to: '/work', label: 'Tasks', icon: Briefcase, key: 'w', group: 'Work', hint: 'Your tasks and projects' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g', group: 'Work', hint: 'Targets and how they are tracking' },
  { to: '/correspondence', label: 'Correspondence', icon: Mail, key: 'e', group: 'Work', hint: 'The emails behind the work' },
  { to: '/records', label: 'Records', icon: ListChecks, key: 'r', group: 'Record', hint: 'Every outcome you logged' },
  { to: '/studio', label: 'Report Studio', icon: FileText, key: 'p', group: 'Record', hint: 'Write a package against the facts' },
  { to: '/reports', label: 'Analysis', icon: FileBarChart, key: 'y', group: 'Record', hint: 'What the record shows' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c', group: 'Record', hint: 'Training, awards, counseling' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'j', group: 'Record', hint: 'Dates and requirements' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true, group: 'Organization', hint: 'People and workload' },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', group: 'Organization', hint: 'Messages that affect you' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true, group: 'More' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true, group: 'More' },
  { to: '/help', label: 'Help', icon: LifeBuoy, key: 'h', secondary: true, group: 'More' },
];
