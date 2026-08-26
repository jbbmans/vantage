import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, BarChart3, Download, Eye, FileSpreadsheet, MonitorCog, Server, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import * as apiClient from '@/lib/api';
import {
  useIdentity, createMany, unitPath, useActivities,
  usePrefs, setPref, flushPrefs,
} from '@/store/useStore';
import { parseSpreadsheet, guessMapping, applyMapping, IMPORT_FIELDS, exportWorkbook } from '@/lib/sheets';
import { screenImport } from '@/lib/duplicates';
import { formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/Dialog';
import { Panel, Button, Select, Badge, EmptyState, Input, Field } from '@/components/ui/primitives';
import {
  useProjects, useTasks, useGoals, useRecognitions, useTrainings,
} from '@/store/useStore';

export default function Settings() {
  const toast = useToast();
  const identity = useIdentity();
  const activities = useActivities();
  const projects = useProjects();
  const tasks = useTasks();
  const goals = useGoals();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const prefs = usePrefs();

  const [importState, setImportState] = useState(null);
  const [audit, setAudit] = useState([]);
  const [serverVersion, setServerVersion] = useState('');
  const [sessions, setSessions] = useState([]);
  const [dbInfo, setDbInfo] = useState(null);
  const [deploymentConfig, setDeploymentConfig] = useState(null);
  const [configDraft, setConfigDraft] = useState(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [experience, setExperience] = useState(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const sheetInput = useRef(null);

  useEffect(() => {
    let live = true;
    apiClient.health().then((h) => { if (live && h?.version) setServerVersion(h.version); }).catch(() => {});
    apiClient.configuration().then((c) => {
      if (!live) return;
      setDeploymentConfig(c);
      setConfigDraft(c.editable || null);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    apiClient.myAudit().then(setAudit).catch(() => setAudit([]));
  }, []);

  useEffect(() => {
    if (identity?.isOperator) {
      apiClient.adminDb().then(setDbInfo).catch(() => setDbInfo(null));
      apiClient.adminExperience().then(setExperience).catch(() => setExperience(null));
    } else {
      setDbInfo(null);
      setExperience(null);
    }
  }, [identity]);

  const loadSessions = () =>
    apiClient.mySessions().then((r) => setSessions(r.sessions || [])).catch(() => setSessions([]));
  useEffect(() => { loadSessions(); }, []);

  const signOutOthers = async () => {
    try {
      const r = await apiClient.revokeOtherSessions();
      toast.success(`${r.revoked} other session${r.revoked === 1 ? '' : 's'} signed out.`);
      loadSessions();
    } catch (err) { toast.error(apiClient.errorText(err)); }
  };

  const revokeOne = async (sid) => {
    try {
      const r = await apiClient.revokeSession(sid);
      // Signing out this very device clears the cookie server-side; a reload
      // lands cleanly on the login screen instead of a half-dead shell.
      if (r.current) { window.location.reload(); return; }
      loadSessions();
    } catch (err) { toast.error(apiClient.errorText(err)); }
  };

  const changePassword = async () => {
    if (pw.next !== pw.confirm) return toast.error('The new passwords do not match.');
    setPwBusy(true);
    try {
      await apiClient.changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', confirm: '' });
      toast.success('Password changed. Every other session was signed out.');
      loadSessions();
    } catch (err) { toast.error(apiClient.errorText(err)); }
    finally { setPwBusy(false); }
  };

  const shortAgent = (ua = '') => {
    if (/mobile/i.test(ua)) return 'Mobile browser';
    if (/firefox/i.test(ua)) return 'Firefox';
    if (/edg\//i.test(ua)) return 'Edge';
    if (/chrome|chromium/i.test(ua)) return 'Chrome';
    if (/safari/i.test(ua)) return 'Safari';
    return ua ? ua.slice(0, 40) : 'Unknown browser';
  };
  const whenShort = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '—');

  const openSheet = async (file) => {
    try {
      const { columns, rows, sheetName } = await parseSpreadsheet(file);
      if (!rows.length) return toast.error('That sheet has no rows.');
      setImportState({ columns, rows, sheetName, mapping: guessMapping(columns) });
    } catch (err) {
      toast.error(err.message || 'Could not read that file.');
    }
  };

  const runImport = async () => {
    const { records, problems } = applyMapping(importState.rows, importState.mapping);
    if (!records.length) return toast.error('No rows had both a title and a readable date.');

    // Importing the same sheet twice is the fastest way to double a fiscal
    // year's dollar figure without noticing, so collisions are dropped here.
    const { fresh, exact } = screenImport(records, activities);
    if (!fresh.length) {
      setImportState(null);
      return toast.error(`Every row already exists. ${exact.length} duplicates skipped.`);
    }

    await createMany('activities', fresh);
    apiClient.trackExperience('import_completed');
    setImportState(null);
    toast.success(
      [
        `Imported ${fresh.length} activities.`,
        exact.length ? `${exact.length} duplicates skipped.` : '',
        problems.length ? `${problems.length} rows unreadable.` : '',
      ].filter(Boolean).join(' ')
    );
  };

  const assignment = identity?.assignments?.[0];
  const interfacePrefs = prefs.interface || {};
  const saveInterface = (key, value) => {
    const next = { ...interfacePrefs, [key]: value };
    setPref('interface', next);
    if (key === 'theme') window.dispatchEvent(new CustomEvent('vantage:theme', { detail: value }));
    if (key === 'density') document.documentElement.setAttribute('data-density', value);
    flushPrefs();
  };

  const setConfigValue = (section, key, value) => setConfigDraft((current) => ({
    ...current,
    [section]: { ...current?.[section], [key]: value },
  }));

  const saveConfiguration = async () => {
    setConfigBusy(true);
    try {
      const saved = await apiClient.updateConfiguration(configDraft);
      setDeploymentConfig(saved);
      setConfigDraft(saved.editable || null);
      toast.success('Deployment settings saved and applied.');
    } catch (err) { toast.error(apiClient.errorText(err)); }
    finally { setConfigBusy(false); }
  };

  return (
    <div className="page-canvas settings-page">
      <div className="border-b border-rule pb-5">
        <p className="eyebrow">Account and deployment controls</p>
        <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Settings console</h2>
        <p className="mt-1.5 max-w-2xl text-base text-text-3">Identity, sessions, data movement, recovery, and deployment boundaries in one auditable place.</p>
      </div>

      <div className="grid gap-7 pt-6 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Settings sections">
          <p className="eyebrow mb-3">Sections</p>
          <nav className="space-y-1 border-l border-rule pl-3 text-sm">
            {[
              ['account', 'Account'],
              ['interface', 'Interface'],
              ['security', 'Password'],
              ['sessions', 'Sessions'],
              ['database', 'Database'],
              ['configuration', 'Configuration'],
              ['experience', 'Experience metrics'],
              ['access-log', 'Access log'],
              ['data', 'Import & export'],
              ['storage', 'Data location'],
            ].map(([id, label]) => <a key={id} href={`#${id}`} className="block rounded-sm px-2 py-1.5 text-text-3 hover:bg-panel-2 hover:text-text">{label}</a>)}
          </nav>
        </aside>
        <div className="min-w-0 space-y-4">

      <Panel id="account" title="Account">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <p className="eyebrow">Name</p>
            <p className="mt-0.5 text-base text-text">
              {identity?.user?.rank?.abbr} {identity?.user?.last_name}, {identity?.user?.first_name}
            </p>
          </div>
          <div>
            <p className="eyebrow">MOS</p>
            <p className="fig mt-0.5 text-base text-text">{identity?.user?.mos || '—'}</p>
          </div>
          <div>
            <p className="eyebrow">Billet</p>
            <p className="mt-0.5 text-base text-text">{assignment?.billet_title || 'None assigned'}</p>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <p className="eyebrow">Assigned unit</p>
            <p className="mt-0.5 text-base text-text-2">
              {unitPath(assignment?.unit_id).map((u) => u.short_name || u.name).join(' › ') || '—'}
            </p>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-ledger" />
          Access comes from active exact-unit membership and role grants, not rank or the org-chart breadcrumb.
          Authorized unit leaders manage those grants and memberships on the Team and Roles pages.
        </p>
      </Panel>

      <Panel
        id="interface"
        title="Interface preferences"
        subtitle="Saved to your account and applied on every device"
        action={<MonitorCog className="h-4 w-4 text-signal" />}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Theme">
            <Select
              value={interfacePrefs.theme || 'light'}
              onValueChange={(value) => saveInterface('theme', value)}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'Match device' },
              ]}
            />
          </Field>
          <Field label="Information density">
            <Select
              value={interfacePrefs.density || 'comfortable'}
              onValueChange={(value) => saveInterface('density', value)}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
            />
          </Field>
          <Field label="Command period">
            <Select
              value={interfacePrefs.dashboardPeriod || 'fiscalQuarter'}
              onValueChange={(value) => saveInterface('dashboardPeriod', value)}
              options={[
                { value: 'week', label: 'This week' },
                { value: 'fiscalQuarter', label: 'Last 12 weeks' },
                { value: 'fiscalYear', label: 'Fiscal year' },
                { value: 'all', label: 'All time' },
              ]}
            />
          </Field>
          <Field label="Report period">
            <Select
              value={interfacePrefs.reportPeriod || 'fiscalYear'}
              onValueChange={(value) => saveInterface('reportPeriod', value)}
              options={[
                { value: 'fiscalQuarter', label: 'Fiscal quarter' },
                { value: 'fiscalYear', label: 'Fiscal year' },
                { value: 'month', label: 'Month' },
                { value: 'year', label: 'Calendar year' },
              ]}
            />
          </Field>
          <Field label="Report opens to">
            <Select
              value={interfacePrefs.reportView || 'narrative'}
              onValueChange={(value) => saveInterface('reportView', value)}
              options={[
                { value: 'narrative', label: 'Evaluation input' },
                { value: 'bullets', label: 'Bullet package' },
                { value: 'delta', label: 'Change report' },
              ]}
            />
          </Field>
          <Field label="Quick Log fields">
            <Select
              value={interfacePrefs.quickLogExpanded ? 'expanded' : 'focused'}
              onValueChange={(value) => saveInterface('quickLogExpanded', value === 'expanded')}
              options={[
                { value: 'focused', label: 'Focused' },
                { value: 'expanded', label: 'Show outcome & notes' },
              ]}
            />
          </Field>
        </div>
        <p className="mt-4 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          Dashboard section visibility and collapsed panels remain configurable from the Command page's Display menu.
        </p>
      </Panel>

      {/* Findings 16 and 28: the shared-workstation controls, on the page a
          Marine actually visits. The server enforces all of it; this is the
          visibility. */}
      <Panel id="security" title="Change your password" subtitle="Changing it signs out every other session">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password" hint="At least 15 characters">
            <Input type="password" autoComplete="new-password" value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={pw.confirm}
              onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Field>
        </div>
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" disabled={pwBusy || !pw.current || pw.next.length < 15 || !pw.confirm} onClick={changePassword}>
            Change password
          </Button>
        </div>
      </Panel>

      <Panel
        id="sessions"
        title="Active sessions"
        subtitle="Every device currently signed in as you"
        bodyClassName="p-0"
        action={sessions.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={signOutOthers}>Sign out other sessions</Button>
        ) : null}
      >
        {sessions.length === 0 ? (
          <EmptyState title="Session list unavailable" description="Try reloading the page." />
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="row flex items-center gap-2.5 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-text-2">
                {shortAgent(s.user_agent)}{s.ip ? ` · ${s.ip}` : ''}
              </span>
              <span className="fig hidden shrink-0 text-2xs text-text-3 sm:inline">last used {whenShort(s.last_used_at)}</span>
              {s.current
                ? <Badge>This device</Badge>
                : <Button variant="ghost" size="sm" onClick={() => revokeOne(s.id)}>Sign out</Button>}
            </div>
          ))
        )}
      </Panel>

      {/* Finding 31: backups belong in the product, not in somebody's memory
          of a shell command. Admin-only; the download itself is audited. */}
      {dbInfo && (
        <Panel
          id="database"
          title="Database"
          subtitle="The SQLite file is the whole system — records, roles, sessions, audit"
          action={
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/admin/backup" download>
                <Download className="h-3.5 w-3.5" />
                Download backup
              </a>
            </Button>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <p className="eyebrow">Size</p>
              <p className="fig mt-0.5 text-md text-text">
                {dbInfo.sizeBytes != null ? `${(dbInfo.sizeBytes / 1048576).toFixed(2)} MB` : '—'}
              </p>
            </div>
            <div>
              <p className="eyebrow">Schema version</p>
              <p className="fig mt-0.5 text-md text-text">{dbInfo.schemaVersion}</p>
            </div>
            <div>
              <p className="eyebrow">Last backup</p>
              <p className="fig mt-0.5 text-md text-text">{whenShort(dbInfo.lastBackupAt)}</p>
            </div>
          </div>
          <p className="mt-3 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
            The download is a consistent snapshot taken while the server keeps running, and every download lands in the
            audit log. Restoring means stopping the server, replacing the file at{' '}
            <span className="fig text-text-2">{dbInfo.path}</span>, and starting it again — the full procedure, and the
            documented lost-administrator recovery (<span className="fig">npm run recover</span>), are in the README.
          </p>
        </Panel>
      )}

      {deploymentConfig && (
        <Panel
          id="configuration"
          title="Deployment configuration"
          subtitle={identity?.isOperator ? 'Safe runtime controls for this Vantage instance' : 'Deployment capabilities and boundaries'}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Palette', deploymentConfig.ui?.palette],
              ['Data mode', deploymentConfig.app?.data_mode],
              ['Authentication', deploymentConfig.auth?.provider],
              ['Self-registration', deploymentConfig.auth?.self_registration ? 'Enabled' : 'Disabled'],
              ['CAC/PIV adapter', deploymentConfig.auth?.cac_piv?.enabled ? 'Enabled' : 'Coded · disabled'],
              ['Attachments', deploymentConfig.attachments?.enabled ? 'Enabled' : 'Disabled'],
              ['Retention purge', deploymentConfig.retention?.purge_days === 0 ? 'Never automatic' : `${deploymentConfig.retention?.purge_days} days`],
              ['UX metrics', deploymentConfig.experience_metrics?.enabled ? 'First-party aggregate' : 'Disabled'],
            ].map(([label, value]) => (
              <div key={label} className="border-l-2 border-signal/30 pl-3">
                <p className="eyebrow">{label}</p>
                <p className="mt-1 text-sm font-medium capitalize text-text">{value || '—'}</p>
              </div>
            ))}
          </div>
          {identity?.isOperator && configDraft ? (
            <div className="mt-4 border-t border-rule pt-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="New account registration">
                  <Select value={configDraft.auth?.self_registration ? 'enabled' : 'disabled'} onValueChange={(value) => setConfigValue('auth', 'self_registration', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
                </Field>
                <Field label="Attachments">
                  <Select value={configDraft.attachments?.enabled ? 'enabled' : 'disabled'} onValueChange={(value) => setConfigValue('attachments', 'enabled', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
                </Field>
                <Field label="Default theme">
                  <Select value={configDraft.ui?.default_theme || 'light'} onValueChange={(value) => setConfigValue('ui', 'default_theme', value)} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
                </Field>
                <Field label="Attachment limit" hint="MB per file">
                  <Input type="number" min="1" max="50" value={Math.round((configDraft.attachments?.max_bytes || 10485760) / 1048576)} onChange={(event) => setConfigValue('attachments', 'max_bytes', Number(event.target.value) * 1048576)} />
                </Field>
                <Field label="Files per record">
                  <Input type="number" min="1" max="50" value={configDraft.attachments?.max_per_record || 10} onChange={(event) => setConfigValue('attachments', 'max_per_record', Number(event.target.value))} />
                </Field>
                <Field label="Guest access maximum" hint="days">
                  <Input type="number" min="1" max="365" value={configDraft.limits?.max_guest_days || 30} onChange={(event) => setConfigValue('limits', 'max_guest_days', Number(event.target.value))} />
                </Field>
                <Field label="Aggregate UX metrics">
                  <Select value={configDraft.experience_metrics?.enabled ? 'enabled' : 'disabled'} onValueChange={(value) => setConfigValue('experience_metrics', 'enabled', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
                </Field>
              </div>
              <div className="mt-4 flex items-start gap-3 border-t border-rule pt-3">
                <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-3">
                  Security-sensitive proxy headers, storage paths, session policy, retention guarantees, and secrets remain deployment-managed in <span className="fig text-text-2">{deploymentConfig.config_file || 'config/app.yaml'}</span> or the hosting secret manager.
                </p>
                <Button variant="primary" size="sm" onClick={saveConfiguration} disabled={configBusy}>{configBusy ? 'Saving…' : 'Save configuration'}</Button>
              </div>
            </div>
          ) : (
            <p className="mt-4 flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
              <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
              Instance Operators can update approved non-secret controls here. Security-sensitive values stay in the reviewed deployment configuration.
            </p>
          )}
        </Panel>
      )}

      {experience && (
        <Panel id="experience" title="Experience metrics" subtitle="Last 30 days · aggregate event counts only">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(experience.rows.reduce((totals, row) => ({
              ...totals,
              [row.event]: (totals[row.event] || 0) + row.count,
            }), {})).sort((a, b) => b[1] - a[1]).map(([event, count]) => (
              <div key={event} className="flex items-center gap-3 rounded-lg bg-panel-2 px-3 py-2.5">
                <BarChart3 className="h-4 w-4 text-signal" />
                <span className="min-w-0 flex-1 truncate text-sm capitalize text-text-2">{event.replaceAll('_', ' ')}</span>
                <span className="fig text-base font-semibold text-text">{count}</span>
              </div>
            ))}
            {experience.rows.length === 0 && <p className="text-sm text-text-3">No aggregate usage events recorded yet.</p>}
          </div>
          <p className="mt-3 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">{experience.privacy}</p>
        </Panel>
      )}

      {/* A Marine can always see who has been reading their record. */}
      <Panel
        id="access-log"
        title="Who has viewed your record"
        subtitle="Protected reads by authorized members of a unit you share are logged"
        bodyClassName="p-0"
      >
        {audit.length === 0 ? (
          <EmptyState icon={Eye} title="Nobody has opened your record" description="Only authorized members of a unit you share can, and each open would show here." />
        ) : (
          audit.slice(0, 12).map((row) => (
            <div key={row.id} className="row flex items-center gap-2.5 px-3 py-1.5">
              <Eye className="h-3 w-3 shrink-0 text-text-3" />
              <span className="min-w-0 flex-1 truncate text-sm text-text-2">
                {row.rank_abbr} {row.last_name} — {row.action.replace(/_/g, ' ')}
              </span>
              <span className="fig shrink-0 text-2xs text-text-3">{formatDTG(row.at)}</span>
            </div>
          ))
        )}
      </Panel>

      <Panel id="data" title="Import and export">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="default"
            size="lg"
            className="justify-start"
            onClick={async () => {
              try {
                await exportWorkbook(
                  {
                    activities: activities.filter((r) => r.user_id === identity?.user?.id),
                    projects: projects.filter((r) => r.user_id === identity?.user?.id),
                    tasks: tasks.filter((r) => r.user_id === identity?.user?.id),
                    goals: goals.filter((r) => r.user_id === identity?.user?.id),
                    recognitions: recognitions.filter((r) => r.user_id === identity?.user?.id),
                    trainings: trainings.filter((r) => r.user_id === identity?.user?.id),
                    contacts: [],
                  },
                  `vantage-${new Date().toISOString().slice(0, 10)}.csv`
                );
                toast.success('CSV exported.');
              } catch (err) { toast.error(err.message); }
            }}
          >
            <Download className="h-4 w-4 text-text-3" />
            <span className="text-left">
              <span className="block text-base text-text">Export my records</span>
              <span className="block text-2xs text-text-3">Your own records only; unit exports require EXPORT_DATA</span>
            </span>
          </Button>

          <Button variant="default" size="lg" className="justify-start" onClick={() => sheetInput.current?.click()}>
            <FileSpreadsheet className="h-4 w-4 text-text-3" />
            <span className="text-left">
              <span className="block text-base text-text">Import CSV or TSV</span>
              <span className="block text-2xs text-text-3">CSV or TSV — duplicates are detected and skipped</span>
            </span>
          </Button>
        </div>

        <input
          ref={sheetInput}
          type="file"
          accept=".csv,.tsv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && openSheet(e.target.files[0])}
        />
      </Panel>

      <Panel id="storage" title="Where your data lives">
        <p className="flex items-start gap-2 text-sm leading-relaxed text-text-2">
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
          <span>
            Records and optional attachments are stored in the database attached to the server that served this page.
            Vantage sends no analytics to third parties. When enabled, its first-party experience metrics store only
            daily aggregate event counts without user, session, IP, record, filename, or free-text fields. The hosting
            provider and authorized infrastructure operators can still control the server and may provide platform logs.
            Exports and backups leave it when an authorized user downloads them.
          </span>
        </p>
        <p className="mt-3 flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-signal" />
          Deleted records are retained rather than erased, so a performance entry can't quietly disappear. Ask an
          administrator if something needs to be removed for real.
        </p>
      </Panel>

      <p className="fig px-1 text-2xs leading-relaxed text-text-3">
        VANTAGE{serverVersion ? ` v${serverVersion}` : ''} — PERFORMANCE RECORD SYSTEM
        <br />
        DESIGNED AND BUILT BY JOHN BERNARD BOLETZ
        <br />
        NO THIRD-PARTY ANALYTICS OR ADVERTISING TELEMETRY
      </p>
        </div>
      </div>

      {importState && (
        <Dialog
          open
          onOpenChange={(v) => !v && setImportState(null)}
          title="Map your columns"
          description={`${importState.rows.length} rows found in "${importState.sheetName}". Match each field to a column.`}
          size="lg"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setImportState(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={runImport}>Import {importState.rows.length} rows</Button>
            </>
          }
        >
          <div className="space-y-2">
            {IMPORT_FIELDS.map((f) => (
              <div key={f.key} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-base text-text-2">
                  {f.label}{f.required && <span className="ml-1 text-redline">*</span>}
                </span>
                <Select
                  className="flex-1"
                  value={importState.mapping[f.key] || ''}
                  onValueChange={(v) =>
                    setImportState((s) => ({ ...s, mapping: { ...s.mapping, [f.key]: v || undefined } }))
                  }
                  placeholder="Not mapped"
                  options={[{ value: '', label: 'Not mapped' }, ...importState.columns.map((c) => ({ value: c, label: c }))]}
                />
              </div>
            ))}
          </div>

          <div className="mt-4 border-t border-rule pt-3">
            <p className="eyebrow mb-2">Preview — first 3 rows</p>
            <div className="space-y-1.5">
              {applyMapping(importState.rows.slice(0, 3), importState.mapping).records.map((r, i) => (
                <p key={i} className="truncate rounded border border-rule bg-panel-2 px-2 py-1 text-xs text-text-2">
                  <span className="fig text-text-3">{r.date || 'no date'}</span> · {r.title || 'no title'}
                  {r.quantity ? ` · ${r.quantity} ${r.unit || ''}` : ''}
                  {r.dollar_amount ? ` · $${r.dollar_amount}` : ''}
                </p>
              ))}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
