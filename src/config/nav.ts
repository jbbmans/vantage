import {
  Gauge, Target, GraduationCap, Users, Settings2, ShieldCheck, LifeBuoy, FileText, Briefcase, BookOpenCheck,
  ScrollText, Library,
  type LucideIcon,
} from 'lucide-react';

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
  requiresMaradmins?: boolean;
  hideInDemo?: boolean;
  secondary?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: Gauge, end: true, key: 'd', group: 'Primary', hint: 'What needs you now' },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'w', group: 'Primary', hint: 'Taskers, the queue, and what is yours' },
  { to: '/record', label: 'Record', icon: BookOpenCheck, key: 'r', group: 'Primary', hint: 'What you did and what backs it up' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g', group: 'Primary', hint: 'Targets and measurable progress' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c', group: 'Primary', hint: 'Next steps, training, readiness' },
  { to: '/reference', label: 'Reference', icon: Library, key: 'f', group: 'Knowledge', hint: 'The FMRA desk reference and balance diagnoser' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true, group: 'Leading', hint: 'Workload, people, and units' },
  { to: '/reports', label: 'Reports', icon: FileText, key: 'p', group: 'More', secondary: true, hint: 'JEPES and FITREP input from the facts' },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm', group: 'More', secondary: true, hint: 'Messages that change a requirement', requiresMaradmins: true },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true, group: 'More' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true, group: 'More', hideInDemo: true },
  { to: '/help', label: 'Field guide', icon: LifeBuoy, key: 'h', secondary: true, group: 'More' },
];

export const NAV_REDIRECTS: Record<string, string> = {
  '/queue': '/work?tab=queue',
  '/correspondence': '/work?tab=mail',
  '/studio': '/reports?tab=packages',
  '/activities': '/record?tab=entries',
  '/records': '/record?tab=entries',
  '/readiness': '/career?tab=readiness',
  '/assist': '/',
};
