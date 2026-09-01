import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Clock3, Download, Eye, FileSpreadsheet, GraduationCap,
  MonitorCog, Server, ShieldCheck, X,
} from 'lucide-react';
import * as apiClient from '@/lib/api';
import {
  useIdentity, createMany, unitPath, useActivities, useOrg, hydrate,
  usePrefs, setPref, flushPrefs,
} from '@/store/useStore';
import { parseSpreadsheet, guessMapping, applyMapping, IMPORT_FIELDS, exportWorkbook } from '@/lib/sheets';
import { screenImport } from '@/lib/duplicates';
import { formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/Dialog';
import { Panel, Button, Select, Badge, EmptyState, Input, Field, Textarea } from '@/components/ui/primitives';
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
  const org = useOrg();

  const [importState, setImportState] = useState(null);
  const [audit, setAudit] = useState([]);
  const [serverVersion, setServerVersion] = useState('');
  const [sessions, setSessions] = useState([]);
  const [rankRequests, setRankRequests] = useState({ mine: [], review: [] });
  const [rankDialog, setRankDialog] = useState(false);
  const [operatorRankDialog, setOperatorRankDialog] = useState(false);
  const [operatorRankId, setOperatorRankId] = useState('');
  const [rankDraft, setRankDraft] = useState({ rank_id: '', reason: '' });
  const [rankReview, setRankReview] = useState(null);
  const [rankBusy, setRankBusy] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const sheetInput = useRef(null);

  useEffect(() => {
    let live = true;
    apiClient.health().then((h) => { if (live && h?.version) setServerVersion(h.version); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    apiClient.myAudit().then(setAudit).catch(() => setAudit([]));
  }, []);

  const loadRankRequests = () => apiClient.rankRequests()
    .then(setRankRequests)
    .catch(() => setRankRequests({ mine: [], review: [] }));
  useEffect(() => {
    loadRankRequests();
    const refresh = () => loadRankRequests();
    window.addEventListener('vantage:rank-requests-refresh', refresh);
    return () => window.removeEventListener('vantage:rank-requests-refresh', refresh);
  }, []);

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

  const saveOperatorRank = async () => {
    if (!operatorRankId) return;
    setRankBusy(true);
    try {
      await apiClient.updateMemberProfile(identity.user.id, { rank_id: operatorRankId });
      await hydrate();
      await loadRankRequests();
      setOperatorRankDialog(false);
      setOperatorRankId('');
      toast.success('Your rank was updated and audited.');
    } catch (err) {
      toast.error(apiClient.errorText(err));
    } finally {
      setRankBusy(false);
    }
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

  const submitRankRequest = async () => {
    setRankBusy(true);
    try {
      await apiClient.requestRankChange(rankDraft);
      setRankDialog(false);
      setRankDraft({ rank_id: '', reason: '' });
      await loadRankRequests();
      window.dispatchEvent(new CustomEvent('vantage:notifications-refresh'));
      toast.success('Rank update sent for review.');
    } catch (err) { toast.error(apiClient.errorText(err)); }
    finally { setRankBusy(false); }
  };

  const cancelRankRequest = async (id) => {
    try {
      await apiClient.cancelRankChange(id);
      await loadRankRequests();
      toast.success('Rank request cancelled.');
    } catch (err) { toast.error(apiClient.errorText(err)); }
  };

  const reviewRankRequest = async () => {
    if (!rankReview?.status) return;
    setRankBusy(true);
    try {
      await apiClient.reviewRankChange(rankReview.id, {
        status: rankReview.status,
        note: rankReview.note,
      });
      setRankReview(null);
      await Promise.all([loadRankRequests(), hydrate()]);
      window.dispatchEvent(new CustomEvent('vantage:notifications-refresh'));
      toast.success(`Rank request ${rankReview.status}.`);
    } catch (err) { toast.error(apiClient.errorText(err)); }
    finally { setRankBusy(false); }
  };

  return (
    <div className="page-canvas settings-page">
      <div className="border-b border-rule pb-5">
        <p className="eyebrow">Account controls</p>
        <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Settings console</h2>
        <p className="mt-1.5 max-w-2xl text-base text-text-3">Identity, rank, security, data, and interface preferences in one place.</p>
      </div>

      <div className="grid gap-7 pt-6 lg:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Settings sections">
          <p className="eyebrow mb-3">Sections</p>
          <nav className="space-y-1 border-l border-rule pl-3 text-sm">
            {[
              ['account', 'Account'],
              ['rank', 'Rank updates'],
              ['interface', 'Interface'],
              ['security', 'Password'],
              ['sessions', 'Sessions'],
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
          Authorized unit leaders manage grants, memberships, and role definitions directly from each team on the Team page.
        </p>
      </Panel>

      <Panel
        id="rank"
        title="Rank updates"
        subtitle="Request a correction or review updates for Marines you manage"
        action={(
          <div className="flex flex-wrap gap-2">
            {identity?.isOperator && (
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  setOperatorRankId(identity?.user?.rank_id || '');
                  setOperatorRankDialog(true);
                }}
              >
                Edit my rank
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setRankDraft({ rank_id: '', reason: '' });
                setRankDialog(true);
              }}
              disabled={rankRequests.mine.some((request) => request.status === 'pending')}
            >
              <GraduationCap className="h-3.5 w-3.5" />
              Request update
            </Button>
          </div>
        )}
      >
        <div className="grid gap-5 xl:grid-cols-2">
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="eyebrow">Your requests</p>
              <span className="text-xs text-text-3">Current: {identity?.user?.rank?.abbr || 'Unassigned'}</span>
            </div>
            <div className="space-y-2">
              {rankRequests.mine.length === 0 ? (
                <div className="rounded border border-dashed border-rule px-3 py-5 text-center text-sm text-text-3">
                  No rank updates requested.
                </div>
              ) : rankRequests.mine.slice(0, 5).map((request) => (
                <div key={request.id} className="rounded border border-rule bg-panel-2/45 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">
                      {request.current_rank_abbr || 'Unassigned'} → {request.requested_rank_abbr}
                    </span>
                    <Badge tone={request.status === 'approved' ? 'ledger' : request.status === 'denied' ? 'redline' : 'neutral'}>
                      {request.status}
                    </Badge>
                    <span className="ml-auto text-2xs text-text-3">{whenShort(request.created_at)}</span>
                  </div>
                  {request.reason && <p className="mt-1.5 text-xs leading-relaxed text-text-2">{request.reason}</p>}
                  {request.review_note && <p className="mt-1.5 border-t border-rule pt-1.5 text-xs text-text-3">Reviewer: {request.review_note}</p>}
                  {request.status === 'pending' && (
                    <div className="mt-2 flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => cancelRankRequest(request.id)}>Cancel request</Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="eyebrow">Awaiting your review</p>
              {rankRequests.review.length > 0 && <Badge>{rankRequests.review.length}</Badge>}
            </div>
            <div className="space-y-2">
              {rankRequests.review.length === 0 ? (
                <div className="rounded border border-dashed border-rule px-3 py-5 text-center text-sm text-text-3">
                  No rank requests need your review.
                </div>
              ) : rankRequests.review.map((request) => (
                <div key={request.id} className="rounded border border-rule bg-panel-2/45 p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text">{request.first_name} {request.last_name}</p>
                      <p className="text-xs text-text-3">
                        {request.current_rank_abbr || 'Unassigned'} → {request.requested_rank_abbr} · {whenShort(request.created_at)}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => setRankReview({ ...request, status: 'denied', note: '' })}>
                        <X className="h-3.5 w-3.5" /> Deny
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => setRankReview({ ...request, status: 'approved', note: '' })}>
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                    </div>
                  </div>
                  {request.reason && <p className="mt-2 text-xs leading-relaxed text-text-2">{request.reason}</p>}
                </div>
              ))}
            </div>
          </section>
        </div>
        <p className="mt-4 flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal" />
          Approvals are restricted to authorized leaders above the member in the same unit, unit owners, and instance operators. Every decision is audited.
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
              value={interfacePrefs.theme || 'system'}
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

      <Dialog
        open={operatorRankDialog}
        onOpenChange={setOperatorRankDialog}
        title="Edit your rank"
        description="Instance Operator override. This change is written to the audit log."
        size="sm"
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setOperatorRankDialog(false)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={rankBusy || !operatorRankId} onClick={saveOperatorRank}>
              {rankBusy ? 'Saving…' : 'Save rank'}
            </Button>
          </>
        )}
      >
        <Field label="Rank">
          <Select
            value={operatorRankId}
            onValueChange={setOperatorRankId}
            options={(org.ranks || []).map((rank) => ({ value: rank.id, label: `${rank.abbr} — ${rank.name}` }))}
          />
        </Field>
      </Dialog>

      <Dialog
        open={rankDialog}
        onOpenChange={setRankDialog}
        title="Request a rank update"
        description="An authorized leader will review the request."
        size="sm"
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setRankDialog(false)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={rankBusy || !rankDraft.rank_id} onClick={submitRankRequest}>
              {rankBusy ? 'Sending…' : 'Send request'}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Field label="Requested rank">
            <Select
              value={rankDraft.rank_id}
              onValueChange={(rank_id) => setRankDraft((current) => ({ ...current, rank_id }))}
              placeholder="Select rank"
              options={(org.ranks || [])
                .filter((rank) => rank.id !== identity?.user?.rank_id)
                .map((rank) => ({ value: rank.id, label: `${rank.abbr} — ${rank.name}` }))}
            />
          </Field>
          <Field label="Reason" hint="optional">
            <Textarea
              rows={4}
              maxLength={500}
              value={rankDraft.reason}
              onChange={(event) => setRankDraft((current) => ({ ...current, reason: event.target.value }))}
              placeholder="Promotion, correction, or effective-date context"
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(rankReview)}
        onOpenChange={(open) => !open && setRankReview(null)}
        title={`${rankReview?.status === 'approved' ? 'Approve' : 'Deny'} rank update`}
        description={rankReview ? `${rankReview.first_name} ${rankReview.last_name}: ${rankReview.current_rank_abbr || 'Unassigned'} → ${rankReview.requested_rank_abbr}` : ''}
        size="sm"
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setRankReview(null)}>Cancel</Button>
            <Button
              variant={rankReview?.status === 'approved' ? 'primary' : 'danger'}
              size="sm"
              disabled={rankBusy}
              onClick={reviewRankRequest}
            >
              {rankBusy ? 'Saving…' : rankReview?.status === 'approved' ? 'Approve update' : 'Deny request'}
            </Button>
          </>
        )}
      >
        <Field label="Review note" hint="optional">
          <Textarea
            rows={4}
            maxLength={500}
            value={rankReview?.note || ''}
            onChange={(event) => setRankReview((current) => ({ ...current, note: event.target.value }))}
            placeholder="Add context for the Marine"
          />
        </Field>
      </Dialog>

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
