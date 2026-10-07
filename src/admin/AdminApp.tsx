import { Activity, Archive, BarChart3, Building2, Database, Gauge, KeyRound, Mail, ScrollText, Settings2, ShieldCheck, Sparkles, UserCog, Users } from 'lucide-react';
import { ConsoleFrame, ConsoleLayout, type ConsoleSection } from '@/components/ConsoleFrame';
import { PrivacyConsole } from '@/components/GovernanceConsole';
import { LINKS } from '@/lib/links';
import type { Identity } from '@/lib/queries';
import * as Sections from './sections';
import { Access, Accounts, Organizations, PlatformHolds, Staff } from './people';

/**
 * The Vantage admin dashboard (ADR-0006): the service, for Vantage staff. Organizations appear here as containers;
 * seeing inside one takes that organization's approval. Each page shows only to the staff roles that can use it.
 */
function sectionsFor(permissions: string[]): ConsoleSection[] {
  const can = (p: string) => permissions.includes(p);
  return [
    { path: '', label: 'Overview', icon: Gauge, title: 'The service', lede: 'Unit Instances, accounts, access, the database, email and the integrity of the audit chain at a glance.', render: () => <Sections.Overview />, hidden: !can('platform.view') },
    { path: 'orgs', label: 'Unit Instances', icon: Building2, title: 'Unit Instances', lede: 'Every command on Vantage, its owners and its state. What is inside one is its own.', render: () => <Organizations />, hidden: !can('platform.view') },
    { path: 'accounts', label: 'Accounts', icon: Users, title: 'Accounts', lede: 'Sign-in help for anyone on Vantage: unlocks, temporary passwords, second factors and sign-in details.', render: () => <Accounts />, hidden: !can('platform.accounts') },
    { path: 'access', label: 'Vantage access', icon: KeyRound, title: 'Vantage access', lede: 'Read-only, time-limited looks inside a Unit Instance, each one approved by its owners.', render: () => <Access />, hidden: !can('platform.view') },
    { path: 'staff', label: 'Staff', icon: UserCog, title: 'Vantage staff', lede: 'Who runs the service, and with which role.', render: () => <Staff />, hidden: !can('platform.view') },
    { path: 'settings', label: 'Settings', icon: Settings2, title: 'Platform settings', lede: 'What everyone sees: the service name, sign-up, self-service Unit Instances, maintenance and the announcement.', render: () => <Sections.RuntimeSettings />, hidden: !can('platform.settings') },
    { path: 'metrics', label: 'Metrics', icon: BarChart3, title: 'Metrics', lede: 'The value types and categories every record is counted in.', render: () => <Sections.MetricsSettings />, hidden: !can('platform.settings') },
    { path: 'ai', label: 'AI', icon: Sparkles, title: 'AI assistance', lede: 'GenAI.mil models, budgets, and whether AI is offered at all.', render: () => <Sections.AiSettings />, hidden: !can('platform.ai') },
    { path: 'email', label: 'Email', icon: Mail, title: 'Email', lede: 'How Vantage sends mail, and what it has sent.', render: () => <Sections.EmailConsole />, hidden: !can('platform.email') },
    { path: 'usage', label: 'Usage', icon: Activity, title: 'Usage and reliability', lede: 'How Vantage is used and where it fails, without anyone’s content.', render: () => <Sections.UsageConsole />, hidden: !can('platform.usage') },
    { path: 'privacy', label: 'Privacy', icon: ShieldCheck, title: 'Privacy inventory', lede: 'What personal information the service holds, and why.', render: () => <PrivacyConsole />, hidden: !can('platform.audit') },
    { path: 'audit', label: 'Audit trail', icon: ScrollText, title: 'Platform audit trail', lede: 'What Vantage staff did, sign-ins, and every access request, in the tamper-evident chain. Each Unit Instance’s own actions are in its trail.', render: () => <Sections.AuditLog />, hidden: !can('platform.audit') },
    { path: 'holds', label: 'Legal holds', icon: Archive, title: 'Platform legal holds', lede: 'Holds on the service itself, over every Unit Instance.', render: () => <PlatformHolds />, hidden: !can('platform.data') },
    { path: 'data', label: 'Backup and recovery', icon: Database, title: 'Backup and recovery', lede: 'Backups, the whole-service archive and maintenance mode.', render: () => <Sections.DataAdmin />, hidden: !can('platform.data') },
  ];
}

export default function AdminApp() {
  return (
    <ConsoleFrame
      // A host of its own puts the dashboard at the root; one shared with the application puts it under /admin.
      basename={LINKS.split && !LINKS.admin.endsWith('/admin') ? '/' : '/admin'}
      documentTitle="Vantage admin"
      loaderLabel="Opening the admin dashboard…"
      variant="admin"
      admits={(identity: Identity) => identity.platform.roles.length > 0}
      denied={{ title: 'This is the Vantage admin dashboard', description: 'It is for the people who run Vantage itself. If you run a Unit Instance on Vantage, its owner console is where you manage it.' }}
    >
      {(identity) => (
        <ConsoleLayout
          identity={identity}
          badge="Vantage"
          railLabel="Admin dashboard"
          eyebrow="Vantage admin"
          headerLabel={<>Vantage admin · {identity.platform.roles.join(', ')}</>}
          sections={sectionsFor(identity.platform.permissions)}
        />
      )}
    </ConsoleFrame>
  );
}
