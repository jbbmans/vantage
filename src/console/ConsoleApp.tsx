import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Archive, Building2, Gauge, IdCard, KeyRound, ScrollText, Settings2, ShieldCheck, Users } from 'lucide-react';
import { ConsoleFrame, ConsoleLayout, type ConsoleSection } from '@/components/ConsoleFrame';
import { PersonnelConsole, PrivacyConsole, RetentionConsole } from '@/components/GovernanceConsole';
import { Select } from '@/components/ui/primitives';
import { LINKS, adminHref } from '@/lib/links';
import type { Identity } from '@/lib/queries';
import type { OrgSummary } from '@/lib/tenancy';
import { remaining } from '@/lib/tenancy';
import * as Sections from './sections';

/**
 * The owner console (ADR-0006): one organization at a time, for the people who hold its organization roles. Each page
 * shows only to the roles that can use it; nothing here reads a Marine's records.
 */
const consoleOrgs = (identity: Identity) => identity.orgs.filter((o) => o.status === 'active' && o.permissions.includes('org.view'));

function sectionsFor(org: OrgSummary): ConsoleSection[] {
  const can = (p: string) => org.permissions.includes(p);
  const id = org.id;
  return [
    { path: '', label: 'Overview', icon: Gauge, title: org.name, lede: 'Your Unit Instance at a glance: its people, units, roster feed, holds and anything waiting on you.', render: () => <Sections.Overview orgId={id} /> },
    { path: 'people', label: 'People', icon: Users, title: 'People', lede: 'Everyone in the Unit Instance, the Unit Instance roles they hold, and why each person can do what they can.', render: () => <Sections.People org={org} />, hidden: !(can('org.members') || can('org.owners') || can('org.roles')) },
    { path: 'units', label: 'Units', icon: Building2, title: 'Units', lede: 'Every unit in the Unit Instance and who leads it.', render: () => <Sections.Units org={org} /> },
    { path: 'personnel', label: 'Personnel feed', icon: IdCard, title: 'Personnel feed', lede: 'The roster extract that keeps names, ranks and EAS dates current, and separates people who left.', render: () => <PersonnelConsole orgId={id} />, hidden: !can('org.personnel') },
    { path: 'retention', label: 'Retention', icon: Archive, title: 'Retention and holds', lede: 'How long the work shared with your units is kept, and the legal holds that stop anything being destroyed.', render: () => <RetentionConsole orgId={id} />, hidden: !(can('org.retention') || can('org.holds')) },
    { path: 'access', label: 'Vantage access', icon: KeyRound, title: 'Vantage access', lede: 'Vantage support sees inside your Unit Instance only when you say so, read-only, for a set time.', render: () => <Sections.VantageAccess org={org} />, hidden: !(can('org.access') || can('org.audit')) },
    { path: 'privacy', label: 'Privacy', icon: ShieldCheck, title: 'Privacy inventory', lede: 'What personal information your Unit Instance holds on Vantage, and why.', render: () => <PrivacyConsole orgId={id} />, hidden: !can('org.privacy') },
    { path: 'audit', label: 'Audit trail', icon: ScrollText, title: 'Audit trail', lede: 'Who did what in your Unit Instance, in a tamper-evident chain.', render: () => <Sections.AuditTrail orgId={id} />, hidden: !can('org.audit') },
    { path: 'settings', label: 'Settings', icon: Settings2, title: 'Settings', lede: 'The Unit Instance’s name, whether Vantage support must ask before looking, and its structure export.', render: () => <Sections.Settings org={org} />, hidden: !(can('org.settings') || can('org.owners') || can('org.export')) },
  ];
}

const SECTION_PATHS = new Set(['people', 'units', 'personnel', 'retention', 'access', 'privacy', 'audit', 'settings']);
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
  const roleLabel = current.roles.map((r) => ({ owner: 'Owner', admin: 'Administrator', records: 'Records officer', auditor: 'Auditor' })[r]).join(', ');
  const access = identity.vantageAccess.length > 0;
  return (
    <ConsoleLayout
      identity={identity}
      badge="Owner"
      railLabel="Owner console"
      eyebrow="Owner console"
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
      documentTitle="Owner console | Vantage"
      loaderLabel="Opening the owner console…"
      variant="console"
      admits={(identity) => consoleOrgs(identity).length > 0}
      denied={{ title: 'This is the owner console', description: 'It is for the owners and administrators of a Unit Instance on Vantage. Your work is in the app; your leader or your Unit Instance’s owner can tell you who runs it.' }}
    >
      {(identity) => <OrgConsole identity={identity} />}
    </ConsoleFrame>
  );
}
