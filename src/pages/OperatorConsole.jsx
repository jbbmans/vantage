import React, { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Activity, Database, Download, Globe2, RefreshCw, Save, ServerCog, ShieldCheck, Users } from 'lucide-react';
import * as api from '@/lib/api';
import { useIdentity } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Badge, Button, Field, Input, Panel, Select } from '@/components/ui/primitives';

function bytes(value) {
  if (value == null) return '—';
  if (value < 1048576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1048576).toFixed(2)} MB`;
}

function age(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export default function OperatorConsole() {
  const identity = useIdentity();
  const toast = useToast();
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState(null);
  const [overview, setOverview] = useState(null);
  const [database, setDatabase] = useState(null);
  const [experience, setExperience] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const publicConfig = await api.configuration();
      const adminOrigin = publicConfig.deployment?.admin_url;
      if (adminOrigin && new URL(adminOrigin).origin !== window.location.origin) {
        window.location.replace(`${adminOrigin}/operator`);
        return;
      }
      const [currentConfig, nextOverview, nextDatabase, nextExperience] = await Promise.all([
        api.adminConfiguration(),
        api.adminOverview(),
        api.adminDb(),
        api.adminExperience(),
      ]);
      setConfig(currentConfig);
      setDraft(currentConfig.editable);
      setOverview(nextOverview);
      setDatabase(nextDatabase);
      setExperience(nextExperience);
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (identity?.isOperator) load(); }, [identity?.isOperator]);

  const setValue = (section, key, value) => setDraft((current) => ({
    ...current,
    [section]: { ...current?.[section], [key]: value },
  }));

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.updateConfiguration(draft);
      setConfig(result);
      setDraft(result.editable);
      toast.success('Instance configuration saved and applied.');
      const next = await api.adminOverview();
      setOverview(next);
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      const result = await api.syncMaradmins();
      toast.success(`Official feed refreshed: ${result.updated || 0} checked, ${result.inserted || 0} new.`);
      await load();
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const events = useMemo(
    () => (experience?.rows || []).reduce((sum, row) => sum + Number(row.count || 0), 0),
    [experience]
  );

  if (!identity?.isOperator) return <Navigate to="/" replace />;

  return (
    <div className="page-canvas operator-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <div className="flex items-center gap-2">
            <p className="eyebrow">Restricted instance administration</p>
            <Badge tone="signal">Operator</Badge>
          </div>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Owner console</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">Configure the running Vantage instance, monitor system health, manage integrations, and take a recovery snapshot.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={load} disabled={busy}><RefreshCw className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !draft}><Save className="h-3.5 w-3.5" /> Save changes</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-rule bg-rule mt-6 lg:grid-cols-5">
        {[
          ['Active users', overview?.users, Users],
          ['Active units', overview?.units, ShieldCheck],
          ['Live records', overview?.records, Activity],
          ['Sessions', overview?.sessions, ServerCog],
          ['UX events · 30d', events, Globe2],
        ].map(([label, value, Icon]) => (
          <div key={label} className="bg-panel p-4">
            <Icon className="h-4 w-4 text-text-3" />
            <p className="fig mt-4 text-2xl font-semibold text-text">{value ?? '—'}</p>
            <p className="mt-1 text-xs text-text-3">{label}</p>
          </div>
        ))}
      </div>

      {!draft ? (
        <div className="mt-5 space-y-3">
          <div className="skeleton h-52 rounded-xl" />
          <div className="skeleton h-52 rounded-xl" />
        </div>
      ) : (
        <div className="mt-5 grid min-w-0 gap-4 [&>*]:min-w-0 xl:grid-cols-2">
          <Panel title="Site identity" subtitle="Visible instance labels and announcement">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Product label">
                <Input value={draft.app?.display_name || ''} onChange={(event) => setValue('app', 'display_name', event.target.value)} maxLength={40} />
              </Field>
              <Field label="Organization">
                <Input value={draft.app?.organization_name || ''} onChange={(event) => setValue('app', 'organization_name', event.target.value)} maxLength={120} />
              </Field>
              <Field label="Default theme">
                <Select value={draft.ui?.default_theme || 'light'} onValueChange={(value) => setValue('ui', 'default_theme', value)} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              </Field>
              <Field label="Site announcement" className="sm:col-span-2">
                <Input value={draft.ui?.announcement || ''} onChange={(event) => setValue('ui', 'announcement', event.target.value)} maxLength={240} placeholder="Leave blank to hide the announcement bar" />
              </Field>
            </div>
          </Panel>

          <Panel title="Account policy" subtitle="Changes take effect without a deployment">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Self-registration">
                <Select value={draft.auth?.self_registration ? 'enabled' : 'disabled'} onValueChange={(value) => setValue('auth', 'self_registration', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
              </Field>
              <Field label="Maximum guest duration">
                <Input type="number" min="1" max="365" value={draft.limits?.max_guest_days || 30} onChange={(event) => setValue('limits', 'max_guest_days', Number(event.target.value))} />
              </Field>
              <Field label="Aggregate experience metrics">
                <Select value={draft.experience_metrics?.enabled ? 'enabled' : 'disabled'} onValueChange={(value) => setValue('experience_metrics', 'enabled', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
              </Field>
            </div>
          </Panel>

          <Panel title="Attachments" subtitle="Evidence remains optional and stored with the deployment">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="File uploads">
                <Select value={draft.attachments?.enabled ? 'enabled' : 'disabled'} onValueChange={(value) => setValue('attachments', 'enabled', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
              </Field>
              <Field label="Maximum file size" hint="MB">
                <Input type="number" min="1" max="50" value={Math.round((draft.attachments?.max_bytes || 10485760) / 1048576)} onChange={(event) => setValue('attachments', 'max_bytes', Number(event.target.value) * 1048576)} />
              </Field>
              <Field label="Files per activity">
                <Input type="number" min="1" max="50" value={draft.attachments?.max_per_record || 10} onChange={(event) => setValue('attachments', 'max_per_record', Number(event.target.value))} />
              </Field>
            </div>
          </Panel>

          <Panel
            title="MARADMIN service"
            subtitle="Official Marines.mil RSS ingestion with cached fallback"
            action={<Button variant="ghost" size="sm" onClick={sync} disabled={busy}><RefreshCw className="h-3.5 w-3.5" /> Sync now</Button>}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tracker">
                <Select value={draft.maradmins?.enabled ? 'enabled' : 'disabled'} onValueChange={(value) => setValue('maradmins', 'enabled', value === 'enabled')} options={[{ value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]} />
              </Field>
              <Field label="Refresh interval" hint="minutes">
                <Input type="number" min="5" max="1440" value={draft.maradmins?.refresh_minutes || 30} onChange={(event) => setValue('maradmins', 'refresh_minutes', Number(event.target.value))} />
              </Field>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-rule pt-3 sm:grid-cols-3">
              <div><p className="eyebrow">Cached</p><p className="fig mt-1 text-sm text-text">{overview?.maradmins?.count ?? 0} messages</p></div>
              <div><p className="eyebrow">Last success</p><p className="fig mt-1 text-sm text-text">{age(overview?.maradmins?.lastSuccess)}</p></div>
              <div><p className="eyebrow">State</p><p className={`mt-1 text-sm ${overview?.maradmins?.lastError ? 'text-redline' : 'text-ledger'}`}>{overview?.maradmins?.lastError ? 'Using cache' : 'Healthy'}</p></div>
            </div>
          </Panel>

          <Panel title="Production domains" subtitle="Deployment-owned; change these through reviewed environment configuration">
            <div className="space-y-3">
              {[
                ['Public application', config?.deployment?.public_url],
                ['Owner console', config?.deployment?.admin_url],
              ].map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-center gap-3 rounded-lg border border-rule bg-panel-2/40 px-3 py-2.5">
                  <Globe2 className="h-4 w-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1"><p className="eyebrow">{label}</p><p className="fig truncate text-sm text-text">{value || 'Not configured'}</p></div>
                  {value && <Badge tone={new URL(value).hostname === window.location.hostname ? 'ledger' : 'neutral'}>{new URL(value).hostname === window.location.hostname ? 'Current host' : 'Configured'}</Badge>}
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Database recovery"
            subtitle="Download a consistent, audited snapshot"
            action={database ? <Button variant="ghost" size="sm" asChild><a href="/api/admin/backup" download><Download className="h-3.5 w-3.5" /> Backup</a></Button> : null}
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div><Database className="h-4 w-4 text-text-3" /><p className="fig mt-3 text-lg text-text">{bytes(database?.sizeBytes)}</p><p className="text-xs text-text-3">Database size</p></div>
              <div><p className="eyebrow">Schema</p><p className="fig mt-1 text-lg text-text">v{database?.schemaVersion ?? '—'}</p></div>
              <div><p className="eyebrow">Last backup</p><p className="fig mt-1 text-sm text-text">{age(database?.lastBackupAt)}</p></div>
            </div>
          </Panel>
        </div>
      )}

      <p className="mt-5 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">Security-sensitive values—operator identity, proxy trust, CAC/PIV verification, database path, and secrets—remain deployment-managed and never enter this interface.</p>
    </div>
  );
}
