import {
  Gauge, ListChecks, Briefcase, Target, GraduationCap, FileBarChart, Users, ScrollText, Activity, Sparkles, Settings2, ShieldCheck, LifeBuoy,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  key: string;
  end?: boolean;
  requiresLead?: boolean;
  requiresOperator?: boolean;
  requiresAi?: boolean;
  secondary?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true, key: 'd' },
  { to: '/records', label: 'Records', icon: ListChecks, key: 'r' },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'w' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'c' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'j' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, key: 'p' },
  { to: '/team', label: 'Team', icon: Users, key: 't', requiresLead: true },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'm' },
  { to: '/assist', label: 'AI assist', icon: Sparkles, key: 'a', requiresAi: true },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 's', secondary: true },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'o', requiresOperator: true, secondary: true },
  { to: '/help', label: 'Help', icon: LifeBuoy, key: 'h', secondary: true },
];
