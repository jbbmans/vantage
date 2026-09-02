import {
  Gauge, ListChecks, Briefcase, Target, GraduationCap, FileBarChart,
  Settings2, Users, Building2, Activity, LifeBuoy,
  ScrollText, ShieldCheck,
} from 'lucide-react';

export const NAV = [
  { to: '/', label: 'Command', icon: Gauge, end: true, key: 'g d' },
  { to: '/activities', label: 'Records', icon: ListChecks, key: 'g a' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'g j' },
  { to: '/team', label: 'Team', icon: Users, key: 'g t', requiresLead: true },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'g w', activeOn: ['/goals'] },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g g' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'g v', activeOn: ['/readiness'] },
  { to: '/maradmins', label: 'MARADMINs', icon: ScrollText, key: 'g m' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, key: 'g p' },
  { to: '/units', label: 'Units', icon: Building2, key: 'g u', requires: 'MANAGE_UNITS' },
  { to: '/help', label: 'Help', icon: LifeBuoy, key: 'g h' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 'g s' },
  { to: '/operator', label: 'Owner console', icon: ShieldCheck, key: 'g o', requiresOperator: true },
];
