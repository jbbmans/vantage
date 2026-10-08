import { Activity, Archive, BarChart3, Building2, Database, Fingerprint, Gauge, HeartPulse, KeyRound, Mail, ScrollText, Settings2, ShieldCheck, Sparkles, ToggleRight, UserCog, Users, Wrench } from 'lucide-react';
import { ConsoleFrame, ConsoleLayout, type ConsoleSection } from '@/components/ConsoleFrame';
import { PrivacyConsole } from '@/components/GovernanceConsole';
import { LINKS } from '@/lib/links';
import { PLATFORM_ROLES, type PlatformRole } from '../../shared/permissions';
import type { Identity } from '@/lib/queries';
import * as Sections from './sections';
import { Access, Accounts, Organizations, PlatformHolds, Staff } from './people';
import { FeatureFlags, Maintenance, MaintenanceBanner, Operations, SignInHealth } from './operations';

/**
 * The Vantage Administrator console (ADR-0006, ADR-0010): the service, for Vantage staff. Unit Instances appear here as
 * containers; seeing inside one takes its Lead Unit Managers' approval. Each page shows only to the staff roles that can use it.
 * The operations pages (ADR-0011) describe the service itself: its health, sign-in, feature flags and maintenance.
 */
function sectionsFor(permissions: string[]): ConsoleSection[] {
  const can = (p: string) => permissions.includes(p);
  return [
    { path: '', label: 'Overview', icon: Gauge, title: 'The service', lede: 'Unit Instances, accounts, access, the database, email and the integrity of the audit chain at a glance.', render: () => <Sections.Overview />, hidden: !can('platform.view') },
    { path: 'operations', label: 'Operations', icon: HeartPulse, title: 'Operations', lede: 'Whether the service is healthy: every check, the build and schema it runs, its backups and its scheduled jobs.', render: () => <Operations />, hidden: !can('platform.view') },
    { path: 'orgs', label: 'Unit Instances', icon: Building2, title: 'Unit Instances', lede: 'Every command on Vantage, its Lead Unit Managers and its state. What is inside one is its own.', render: () => <Organizations />, hidden: !can('platform.view') },
    { path: 'accounts', label: 'Accounts', icon: Users, title: 'Accounts', lede: 'Sign-in help for anyone on Vantage: unlocks, temporary passwords, second factors and sign-in details.', render: () => <Accounts />, hidden: !can('platform.accounts') },
    { path: 'access', label: 'Vantage access', icon: KeyRound, title: 'Vantage access', lede: 'Read-only, time-limited looks inside a Unit Instance, each one approved by its Lead Unit Managers.', render: () => <Access />, hidden: !can('platform.view') },
    { path: 'staff', label: 'Staff', icon: UserCog, title: 'Vantage staff', lede: 'Who runs the service, and with which role.', render: () => <Staff />, hidden: !can('platform.view') },
    { path: 'sign-in', label: 'Sign-in health', icon: Fingerprint, title: 'Sign-in health', lede: 'Whether each way in still lets people in: revocation lists, trusted CAs, organization sign-in, lockouts and second factors.', render: () => <SignInHealth />, hidden: !can('platform.view') },
    { path: 'flags', label: 'Feature flags', icon: ToggleRight, title: 'Feature flags', lede: 'The service’s switches: the ones changed here, and the ones set when it is deployed.', render: () => <FeatureFlags />, hidden: !can('platform.view') },
    { path: 'settings', label: 'Settings', icon: Settings2, title: 'Platform settings', lede: 'What everyone sees: the service name and the announcement.', render: () => <Sections.RuntimeSettings />, hidden: !can('platform.settings') },
    { path: 'metrics', label: 'Metrics', icon: BarChart3, title: 'Metrics', lede: 'The value types and categories every record is counted in.', render: () => <Sections.MetricsSettings />, hidden: !can('platform.settings') },
    { path: 'ai', label: 'AI', icon: Sparkles, title: 'AI assistance', lede: 'GenAI.mil models, budgets, and whether AI is offered at all.', render: () => <Sections.AiSettings />, hidden: !can('platform.ai') },
    { path: 'email', label: 'Email', icon: Mail, title: 'Email', lede: 'How Vantage sends mail, and what it has sent.', render: () => <Sections.EmailConsole />, hidden: !can('platform.email') },
    { path: 'usage', label: 'Usage', icon: Activity, title: 'Usage and reliability', lede: 'How Vantage is used and where it fails, without anyone’s content.', render: () => <Sections.UsageConsole />, hidden: !can('platform.usage') },
    { path: 'privacy', label: 'Privacy', icon: ShieldCheck, title: 'Privacy inventory', lede: 'What personal information the service holds, and why.', render: () => <PrivacyConsole />, hidden: !can('platform.audit') },
    { path: 'audit', label: 'Audit trail', icon: ScrollText, title: 'Platform audit trail', lede: 'What Vantage staff did, sign-ins, and every access request, in the tamper-evident chain. Each Unit Instance’s own actions are in its trail.', render: () => <Sections.AuditLog />, hidden: !can('platform.audit') },
    { path: 'holds', label: 'Legal holds', icon: Archive, title: 'Platform legal holds', lede: 'Holds on the service itself, over every Unit Instance.', render: () => <PlatformHolds />, hidden: !can('platform.data') },
    { path: 'maintenance', label: 'Maintenance', icon: Wrench, title: 'Maintenance', lede: 'Closing the service for work, with a reason, and the database tasks that keep it sound. Every step is audited.', render: () => <Maintenance />, hidden: !can('platform.view') },
    { path: 'data', label: 'Backup and recovery', icon: Database, title: 'Backup and recovery', lede: 'Backups and the whole-service archive.', render: () => <Sections.DataAdmin />, hidden: !can('platform.data') },
  ];
}

export default function AdminApp() {
  return (
    <ConsoleFrame
      // A host of its own puts the console at the root; one shared with the application puts it under /admin.
      basename={LINKS.split && !LINKS.admin.endsWith('/admin') ? '/' : '/admin'}
      documentTitle="Vantage Administrator console"
      loaderLabel="Opening the Vantage Administrator console…"
      variant="admin"
      admits={(identity: Identity) => identity.platform.roles.length > 0}
      denied={{ title: 'This is the Vantage Administrator console', description: 'It is for Vantage staff, the people who run Vantage itself. If you are a Unit Manager of a Unit Instance on Vantage, the Unit Manager console is where you manage it.' }}
    >
      {(identity) => (
        <ConsoleLayout
          identity={identity}
          badge="Vantage"
          railLabel="Vantage Administrator console"
          eyebrow="Vantage Administrator"
          headerLabel={<>Vantage staff · {identity.platform.roles.map((r) => PLATFORM_ROLES[r as PlatformRole]?.label ?? r).join(', ')}</>}
          sections={sectionsFor(identity.platform.permissions)}
          banner={<MaintenanceBanner />}
        />
      )}
    </ConsoleFrame>
  );
}
