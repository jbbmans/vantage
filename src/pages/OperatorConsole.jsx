import React, { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Activity, Copy, Database, Download, Globe2, KeyRound, RefreshCw, Save,
  ServerCog, ShieldAlert, ShieldCheck, Trash2, Users,
} from 'lucide-react';
import * as api from '@/lib/api';
import { useIdentity } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Badge, Button, Field, Input, Panel, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';

const incidentTone = (value) => {
  if (value === 'critical' || value === 'high') return 'redline';
  if (value === 'closed' || value === 'mitigated') return 'ledger';
  if (value === 'investigating' || value === 'acknowledged') return 'signal';
  return 'neutral';
};

const INCIDENT_STATUS_OPTIONS = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'closed', label: 'Closed' },
];

const INCIDENT_TRANSITIONS = {
  submitted: ['acknowledged', 'investigating', 'closed'],
  acknowledged: ['investigating', 'mitigated', 'closed'],
  investigating: ['mitigated', 'closed'],
  mitigated: ['investigating', 'closed'],
  closed: ['investigating'],
};

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
  const [integrations, setIntegrations] = useState({ clients: [], units: [], enabled: false });
  const [integrationName, setIntegrationName] = useState('');
  const [integrationUnitId, setIntegrationUnitId] = useState('');
  const [integrationDays, setIntegrationDays] = useState(90);
  const [revealedToken, setRevealedToken] = useState('');
  const [incidents, setIncidents] = useState([]);
  const [incidentDetail, setIncidentDetail] = useState(null);
  const [incidentStatus, setIncidentStatus] = useState('');
  const [incidentNote, setIncidentNote] = useState('');
  const [incidentVisibility, setIncidentVisibility] = useState('reporter');
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
      const [currentConfig, nextOverview, nextDatabase, nextExperience, nextIntegrations, nextIncidents] = await Promise.all([
        api.adminConfiguration(),
        api.adminOverview(),
        api.adminDb(),
        api.adminExperience(),
        api.adminIntegrations(),
        api.adminSecurityIncidents(),
      ]);
      setConfig(currentConfig);
      setDraft(currentConfig.editable);
      setOverview(nextOverview);
      setDatabase(nextDatabase);
      setExperience(nextExperience);
      setIntegrations(nextIntegrations);
      setIncidents(nextIncidents.incidents || []);
      setIncidentDetail((current) => current
        ? (nextIncidents.incidents || []).find((row) => row.id === current.id) || null
        : null);
      setIntegrationUnitId((current) => current || nextIntegrations.units?.[0]?.id || '');
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

  const createIntegration = async () => {
    setBusy(true);
    setRevealedToken('');
    try {
      const created = await api.createIntegration({
        name: integrationName,
        unit_id: integrationUnitId,
        expires_in_days: Number(integrationDays),
      });
      setRevealedToken(created.token);
      setIntegrationName('');
      setIntegrations(await api.adminIntegrations());
      toast.success('Exact-unit integration credential created. Copy it now.');
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const revokeIntegration = async (id) => {
    setBusy(true);
    try {
      await api.revokeIntegration(id);
      setIntegrations(await api.adminIntegrations());
      toast.success('Integration credential revoked.');
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const openIncident = (incident) => {
    setIncidentDetail(incident);
    setIncidentStatus(incident.status);
    setIncidentNote('');
    setIncidentVisibility('reporter');
  };

  const saveIncidentUpdate = async () => {
    if (!incidentDetail) return;
    setBusy(true);
    try {
      await api.updateSecurityIncident(incidentDetail.id, {
        status: incidentStatus,
        note: incidentNote,
        visible_to_reporter: incidentVisibility === 'reporter',
      });
      const next = await api.adminSecurityIncidents();
      setIncidents(next.incidents || []);
      const refreshed = (next.incidents || []).find((row) => row.id === incidentDetail.id) || null;
      setIncidentDetail(refreshed);
      setIncidentStatus(refreshed?.status || '');
      setIncidentNote('');
      window.dispatchEvent(new CustomEvent('vantage:notifications-refresh'));
      toast.success('Security case updated and audited.');
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

          <Panel title="Enterprise API" subtitle="Read-only credentials bound to one exact unit">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="API surface">
                <Select
                  value={draft.integrations?.enabled ? 'enabled' : 'disabled'}
                  onValueChange={(value) => setValue('integrations', 'enabled', value === 'enabled')}
                  options={[{ value: 'disabled', label: 'Disabled' }, { value: 'enabled', label: 'Enabled' }]}
                />
              </Field>
              <Field label="Client name">
                <Input value={integrationName} onChange={(event) => setIntegrationName(event.target.value)} maxLength={80} placeholder="Approved downstream system" />
              </Field>
              <Field label="Exact unit">
                <Select
                  value={integrationUnitId}
                  onValueChange={setIntegrationUnitId}
                  options={(integrations.units || []).map((unit) => ({ value: unit.id, label: `${unit.code} · ${unit.short_name || unit.name}` }))}
                />
              </Field>
              <Field label="Credential lifetime" hint="days">
                <Input type="number" min="1" max="365" value={integrationDays} onChange={(event) => setIntegrationDays(Number(event.target.value))} />
              </Field>
              <div className="flex items-end sm:col-span-2">
                <Button
                  className="w-full justify-center"
                  onClick={createIntegration}
                  disabled={busy || integrationName.trim().length < 3 || !integrationUnitId}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Generate credential
                </Button>
              </div>
            </div>

            {revealedToken && (
              <div className="mt-4 rounded-lg border border-signal/40 bg-signal/5 p-3">
                <p className="text-sm font-medium text-text">Copy this credential now. VANTAGE will not show it again.</p>
                <div className="mt-2 flex min-w-0 gap-2">
                  <Input readOnly value={revealedToken} className="min-w-0 font-mono text-xs" aria-label="New integration credential" />
                  <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(revealedToken)}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2 border-t border-rule pt-3">
              {(integrations.clients || []).length === 0 && <p className="text-sm text-text-3">No integration credentials issued.</p>}
              {(integrations.clients || []).map((client) => (
                <div key={client.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-rule bg-panel-2/40 px-3 py-2.5">
                  <KeyRound className="h-4 w-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{client.name}</p>
                    <p className="fig truncate text-2xs text-text-3">{client.unit_code} · {client.token_hint} · expires {age(client.expires_at)}</p>
                  </div>
                  <Badge tone={client.active ? 'ledger' : 'neutral'}>{client.active ? 'Active' : 'Revoked'}</Badge>
                  {client.active && (
                    <Button variant="ghost" size="sm" onClick={() => revokeIntegration(client.id)} disabled={busy}>
                      <Trash2 className="h-3.5 w-3.5" /> Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-text-3">Credentials expose only unit-shared activity fields and aggregates. Private records, notes, attachments, rosters, drafts, and child units are excluded.</p>
          </Panel>

          <Panel id="security-incidents" title="Security incident queue" subtitle="Confidential reports visible only to the reporter and Instance Operator">
            <div className="mb-3 grid grid-cols-2 gap-3 border-b border-rule pb-3 sm:grid-cols-3">
              <div><p className="eyebrow">Open</p><p className="fig mt-1 text-lg text-text">{incidents.filter((row) => row.status !== 'closed').length}</p></div>
              <div><p className="eyebrow">Critical / high</p><p className="fig mt-1 text-lg text-text">{incidents.filter((row) => row.status !== 'closed' && ['critical', 'high'].includes(row.severity)).length}</p></div>
              <div><p className="eyebrow">Submitted</p><p className="fig mt-1 text-lg text-text">{incidents.filter((row) => row.status === 'submitted').length}</p></div>
            </div>
            <div className="space-y-2">
              {incidents.length === 0 && <p className="text-sm text-text-3">No confidential security reports submitted.</p>}
              {incidents.map((incident) => (
                <div key={incident.id} className="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-rule bg-panel-2/40 p-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-text">{incident.title}</p>
                      <Badge tone={incidentTone(incident.status)}>{incident.status}</Badge>
                      <Badge tone={incidentTone(incident.severity)}>{incident.severity}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-text-3">
                      {incident.reporter_rank_abbr ? `${incident.reporter_rank_abbr} ` : ''}{incident.reporter_last_name}, {incident.reporter_first_name}
                      {' · '}Case {incident.id.slice(0, 8)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => openIncident(incident)}>Manage</Button>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-text-3">Case content never enters unit exports, enterprise API responses, experience metrics, or unit-leader dashboards. Status changes and notes are append-only audit events.</p>
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

      <Dialog
        open={Boolean(incidentDetail)}
        onOpenChange={(open) => !open && setIncidentDetail(null)}
        title={incidentDetail?.title || 'Security incident'}
        description={incidentDetail ? `Case ${incidentDetail.id.slice(0, 8)} · ${incidentDetail.reporter_username}` : ''}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setIncidentDetail(null)}>Close</Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || (!incidentNote.trim() && incidentStatus === incidentDetail?.status)}
              onClick={saveIncidentUpdate}
            >
              {busy ? 'Saving…' : 'Save case update'}
            </Button>
          </>
        )}
      >
        {incidentDetail && (
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,.7fr)]">
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge tone={incidentTone(incidentDetail.status)}>{incidentDetail.status}</Badge>
                <Badge tone={incidentTone(incidentDetail.severity)}>{incidentDetail.severity}</Badge>
                <Badge>{incidentDetail.category.replace(/_/g, ' ')}</Badge>
              </div>
              {incidentDetail.affected_area && <p className="text-xs text-text-3">Affected area: <span className="text-text-2">{incidentDetail.affected_area}</span></p>}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-2">{incidentDetail.description}</p>
              <div className="space-y-2 border-t border-rule pt-3">
                <p className="eyebrow">Complete case history</p>
                {(incidentDetail.events || []).map((event) => (
                  <div key={event.id} className="rounded border border-rule bg-panel-2/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-text">{event.kind.replace(/_/g, ' ')}</span>
                      {event.to_status && <Badge tone={incidentTone(event.to_status)}>{event.to_status}</Badge>}
                      {!event.visible_to_reporter && <Badge tone="redline">Operator only</Badge>}
                      <span className="fig ml-auto text-2xs text-text-3">{age(event.created_at)}</span>
                    </div>
                    {event.message && <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-2">{event.message}</p>}
                  </div>
                ))}
              </div>
            </div>
            <div className="min-w-0 space-y-4 lg:border-l lg:border-rule lg:pl-5">
              <Field label="Case status">
                <Select
                  value={incidentStatus}
                  onValueChange={setIncidentStatus}
                  options={INCIDENT_STATUS_OPTIONS.filter((option) =>
                    option.value === incidentDetail.status
                    || INCIDENT_TRANSITIONS[incidentDetail.status]?.includes(option.value)
                  )}
                />
              </Field>
              <Field label="Update or note" hint="2,000 characters">
                <Textarea
                  rows={8}
                  maxLength={2000}
                  value={incidentNote}
                  onChange={(event) => setIncidentNote(event.target.value)}
                  placeholder="Document triage, containment, reproduction, mitigation, or closure details."
                />
              </Field>
              <Field label="Note visibility">
                <Select
                  value={incidentVisibility}
                  onValueChange={setIncidentVisibility}
                  options={[
                    { value: 'reporter', label: 'Visible to reporter' },
                    { value: 'operator', label: 'Instance Operator only' },
                  ]}
                />
              </Field>
              <p className="text-xs leading-relaxed text-text-3">Reporter-visible updates create an in-app notification. Operator-only notes remain hidden from the reporter and unit leadership.</p>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
