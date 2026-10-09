import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Archive, ArrowLeftRight, Building2, ClipboardList, Gauge, GraduationCap, IdCard, KeyRound, ScrollText, Settings2, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { ConsoleFrame, ConsoleLayout, type ConsoleSection } from '@/components/ConsoleFrame';
import { PersonnelConsole, PrivacyConsole, RetentionConsole } from '@/components/GovernanceConsole';
import { Select } from '@/components/ui/primitives';
import { LINKS, adminHref } from '@/lib/links';
import type { Identity } from '@/lib/queries';
import type { OrgSummary } from '@/lib/tenancy';
import { remaining } from '@/lib/tenancy';
import { ORG_ROLES, type OrgRole } from '../../shared/permissions';
import * as Sections from './sections';
import * as Config from './configuration';

/**
 * The Unit Manager console (ADR-0006, ADR-0010, ADR-0012): one Unit Instance at a time, for the people who hold its Unit Instance roles.
 * Each page shows only to the roles that can use it; nothing here reads a Marine's records, and nothing here changes what Vantage
 * sets for every Unit Instance.
 */
const consoleOrgs = (identity: Identity) => identity.orgs.filter((o) => o.status === 'active' && o.permissions.includes('org.view'));

function sectionsFor(org: OrgSummary): ConsoleSection[] {
  const can = (p: string) => org.permissions.includes(p);
  const id = org.id;
  return [
    { path: '', label: 'Overview', icon: Gauge, title: org.name, lede: 'Your Unit Instance at a glance: its people, units, roster feed, holds and anything waiting on you.', render: () => <Sections.Overview orgId={id} /> },
    { path: 'people', label: 'People', icon: Users, title: 'People', lede: 'Everyone in the Unit Instance, the Unit Instance roles they hold, and why each person can do what they can.', render: () => <Sections.People org={org} />, hidden: !(can('org.members') || can('org.owners') || can('org.roles')) },
    { path: 'units', label: 'Units and teams', icon: Building2, title: 'Units and teams', lede: 'Every unit and team in the Unit Instance, where it sits and who leads it.', render: () => <Config.UnitsAndTeams org={org} /> },
    { path: 'billets', label: 'Billets', icon: ClipboardList, title: 'Billets', lede: 'The billets your units staff, who holds each one, and which are vacant.', render: () => <Config.Billets org={org} /> },
    { path: 'unit-roles', label: 'Unit roles', icon: Shield, title: 'Unit roles', lede: 'The roles in each unit, what they allow there, and who holds them.', render: () => <Config.UnitRoles org={org} />, hidden: !(can('org.roles') || can('org.members') || can('org.owners')) },
    { path: 'duty', label: 'Duty', icon: ShieldAlert, title: 'Duty', lede: 'The kinds of duty your Unit Instance stands, and the points each earns.', render: () => <Config.Duty org={org} /> },
    { path: 'training', label: 'Training', icon: GraduationCap, title: 'Training', lede: 'The training your Unit Instance requires of its Marines.', render: () => <Config.Training org={org} /> },
    { path: 'work', label: 'Work and reports', icon: SlidersHorizontal, title: 'Work and reports', lede: 'How long a claim on queued work holds, and where reports open.', render: () => <Config.WorkAndReports org={org} /> },
    { path: 'data', label: 'Imports and exports', icon: ArrowLeftRight, title: 'Imports and exports', lede: 'Bring accounts and configuration in, and take structure, rosters, configuration and the audit trail out.', render: () => <Config.ImportsExports org={org} />, hidden: !['org.export', 'org.audit', 'org.members', 'org.personnel', 'org.config'].some(can) },
    { path: 'personnel', label: 'Personnel feed', icon: IdCard, title: 'Personnel feed', lede: 'The roster extract that keeps names, ranks and EAS dates current, and separates people who left.', render: () => <PersonnelConsole orgId={id} />, hidden: !can('org.personnel') },
    { path: 'retention', label: 'Retention', icon: Archive, title: 'Retention and holds', lede: 'How long the work shared with your units is kept, and the legal holds that stop anything being destroyed.', render: () => <RetentionConsole orgId={id} />, hidden: !(can('org.retention') || can('org.holds')) },
    { path: 'access', label: 'Vantage access', icon: KeyRound, title: 'Vantage access', lede: 'Vantage support sees inside your Unit Instance only when you say so, read-only, for a set time.', render: () => <Sections.VantageAccess org={org} />, hidden: !(can('org.access') || can('org.audit')) },
    { path: 'privacy', label: 'Privacy', icon: ShieldCheck, title: 'Privacy inventory', lede: 'What personal information your Unit Instance holds on Vantage, and why.', render: () => <PrivacyConsole orgId={id} />, hidden: !can('org.privacy') },
    { path: 'audit', label: 'Audit trail', icon: ScrollText, title: 'Audit trail', lede: 'Who did what in your Unit Instance, in a tamper-evident chain.', render: () => <Sections.AuditTrail orgId={id} />, hidden: !can('org.audit') },
    { path: 'settings', label: 'Settings', icon: Settings2, title: 'Settings', lede: 'The Unit Instance’s name, whether Vantage support must ask before looking, and what Vantage sets for every Unit Instance.', render: () => <Sections.Settings org={org} extra={<Config.EnterpriseControlsPanel orgId={id} />} /> },
  ];
}

const SECTION_PATHS = new Set(['people', 'units', 'billets', 'unit-roles', 'duty', 'training', 'work', 'data', 'personnel', 'retention', 'access', 'privacy', 'audit', 'settings']);
const STORE = 'vantage.console.org';

function OrgConsole({ identity }: { identity: Identity }) {
  const location = useLocation();
  const navigate = useNavigate();
  const orgs = consoleOrgs(identity);
  const [first, ...rest] = location.pathname.split('/').filter(Boolean);
  const current = orgs.find((o) => o.id === first);
  useEffect(() => { if (current) { try { localStorage.setItem(STORE, current.id); } catch { /* per-browser convenience only */ } } }, [current]);
  if (!current) {
    // "/", or a link written without an organization (a notification's /console/access): the last one used, or the first.
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(STORE); } catch { /* none */ }
    const target = orgs.find((o) => o.id === remembered) ?? orgs[0];
    const section = first && SECTION_PATHS.has(first) ? `/${[first, ...rest].join('/')}` : '';
    return <Navigate to={`/${target.id}${section}${location.search}`} replace />;
  }
  const switcher = orgs.length > 1
    ? <Select aria-label="Unit Instance" value={current.id} onValueChange={(id) => navigate(`/${id}${rest.length ? `/${rest.join('/')}` : ''}`)} options={orgs.map((o) => ({ value: o.id, label: o.short_name || o.name }))} />
    : <p className="truncate px-2 text-xs text-white/60 lg:text-white/60">{current.name}</p>;
  const roleLabel = current.roles.map((r) => ORG_ROLES[r as OrgRole]?.label ?? r).join(', ');
  const access = identity.vantageAccess.length > 0;
  return (
    <ConsoleLayout
      identity={identity}
      badge="Unit Manager"
      railLabel="Unit Manager console"
      eyebrow="Unit Manager console"
      headerLabel={<>{current.name} · {roleLabel}{current.expiresAt ? ` until ${new Date(current.expiresAt).toLocaleDateString()}` : ''}</>}
      sections={sectionsFor(current)}
      prefix={`/${current.id}`}
      context={switcher}
      banner={access ? <p className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-ink lg:px-8">You hold Vantage access into a Unit Instance, ending {remaining(identity.vantageAccess[0].expiresAt)}. <a className="link" href={adminHref('/access')}>Manage it</a></p> : undefined}
    />
  );
}

export default function ConsoleApp() {
  return (
    <ConsoleFrame
      // One address for everything puts the console under /console; a host of its own puts it at the root.
      basename={LINKS.split && !LINKS.console.endsWith('/console') ? '/' : '/console'}
      documentTitle="Unit Manager console | Vantage"
      loaderLabel="Opening the Unit Manager console…"
      variant="console"
      admits={(identity) => consoleOrgs(identity).length > 0}
      denied={{ title: 'This is the Unit Manager console', description: 'It is for the Unit Managers, Records Officers and Unit Auditors of a Unit Instance on Vantage. Your work is in the app; your leader can tell you who your Unit Managers are.' }}
    >
      {(identity) => <OrgConsole identity={identity} />}
    </ConsoleFrame>
  );
}
