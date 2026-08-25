import {
  Gauge, ListChecks, Briefcase, Target, GraduationCap, FileBarChart,
  Settings2, Users, Shield, Building2, Activity, LifeBuoy,
} from 'lucide-react';

/**
 * Navigation lives in its own module so the shell and the command palette can
 * both read it without importing each other.
 *
 * `requires` is a permission bit that must be held somewhere for the item to
 * appear. Presentation only — the server refuses the data regardless, so
 * hiding a link is a courtesy, not a control.
 */
export const NAV = [
  { to: '/', label: 'Command', icon: Gauge, end: true, key: 'g d' },
  { to: '/activities', label: 'Records', icon: ListChecks, key: 'g a' },
  { to: '/readiness', label: 'Readiness', icon: Activity, key: 'g j' },
  { to: '/team', label: 'Team', icon: Users, key: 'g t', requiresLead: true },
  { to: '/work', label: 'Work', icon: Briefcase, key: 'g w' },
  { to: '/goals', label: 'Goals', icon: Target, key: 'g g' },
  { to: '/career', label: 'Career', icon: GraduationCap, key: 'g v' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, key: 'g p' },
  { to: '/units', label: 'Units', icon: Building2, key: 'g u', requires: 'MANAGE_UNITS' },
  { to: '/roles', label: 'Roles', icon: Shield, key: 'g o', requires: 'MANAGE_ROLES' },
  { to: '/help', label: 'Help', icon: LifeBuoy, key: 'g h' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 'g s' },
];
