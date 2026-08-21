import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash2, ShieldCheck, FileSpreadsheet, Eye, Server, AlertTriangle } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useIdentity, useOrg, createMany, refreshAll, unitPath, useActivities } from '@/store/useStore';
import { parseSpreadsheet, guessMapping, applyMapping, IMPORT_FIELDS, exportWorkbook } from '@/lib/sheets';
import { screenImport } from '@/lib/duplicates';
import { formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/Dialog';
import { Panel, PageHeader, Button, Select, Badge, EmptyState, Input, Field } from '@/components/ui/primitives';
import {
  useProjects, useTasks, useGoals, useRecognitions, useTrainings,
} from '@/store/useStore';

export default function Settings() {
  const toast = useToast();
  const identity = useIdentity();
  const org = useOrg();
  const activities = useActivities();
  const projects = useProjects();
  const tasks = useTasks();
  const goals = useGoals();
  const recognitions = useRecognitions();
  const trainings = useTrainings();

  const [importState, setImportState] = useState(null);
  const [audit, setAudit] = useState([]);
  const [serverVersion, setServerVersion] = useState('');
  const [sessions, setSessions] = useState([]);
  const [dbInfo, setDbInfo] = useState(null);
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

  useEffect(() => {
    if (identity?.user?.is_admin) apiClient.adminDb().then(setDbInfo).catch(() => setDbInfo(null));
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

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader title="Settings" subtitle="Your account, your unit, and how records move" />

      <Panel title="Account">
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
            <p className="eyebrow">Chain</p>
            <p className="mt-0.5 text-base text-text-2">
              {unitPath(assignment?.unit_id).map((u) => u.short_name || u.name).join(' › ') || '—'}
            </p>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-ledger" />
          Your access level is set by your assignment, not your rank. To change it, your section lead reassigns you on
          the Team page.
        </p>
      </Panel>

      {/* Findings 16 and 28: the shared-workstation controls, on the page a
          Marine actually visits. The server enforces all of it; this is the
          visibility. */}
      <Panel title="Change your password" subtitle="Changing it signs out every other session">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password" hint="At least 10 characters">
            <Input type="password" autoComplete="new-password" value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={pw.confirm}
              onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </Field>
        </div>
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" disabled={pwBusy || !pw.current || pw.next.length < 10 || !pw.confirm} onClick={changePassword}>
            Change password
          </Button>
        </div>
      </Panel>

      <Panel
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

      {/* A Marine can always see who has been reading their record. */}
      <Panel
        title="Who has viewed your record"
        subtitle="Every read by someone in your chain is logged"
        bodyClassName="p-0"
      >
        {audit.length === 0 ? (
          <EmptyState icon={Eye} title="Nobody has opened your record" description="Only Marines in your chain of command can, and it would show here." />
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

      <Panel title="Import and export">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="default"
            size="lg"
            className="justify-start"
            onClick={async () => {
              try {
                await exportWorkbook(
                  { activities, projects, tasks, goals, recognitions, trainings, contacts: [] },
                  `vantage-${new Date().toISOString().slice(0, 10)}.xlsx`
                );
                toast.success('Workbook exported.');
              } catch (err) { toast.error(err.message); }
            }}
          >
            <Download className="h-4 w-4 text-text-3" />
            <span className="text-left">
              <span className="block text-base text-text">Export a workbook</span>
              <span className="block text-2xs text-text-3">Everything you can see, as XLSX</span>
            </span>
          </Button>

          <Button variant="default" size="lg" className="justify-start" onClick={() => sheetInput.current?.click()}>
            <FileSpreadsheet className="h-4 w-4 text-text-3" />
            <span className="text-left">
              <span className="block text-base text-text">Import a spreadsheet</span>
              <span className="block text-2xs text-text-3">CSV or XLSX — duplicates are detected and skipped</span>
            </span>
          </Button>
        </div>

        <input
          ref={sheetInput}
          type="file"
          accept=".csv,.xlsx,.xls,.tsv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && openSheet(e.target.files[0])}
        />
      </Panel>

      <Panel title="Where your data lives">
        <p className="flex items-start gap-2 text-sm leading-relaxed text-text-2">
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
          <span>
            Records are stored on the server this page was served from — no third-party service, no analytics, no
            vendor backend. Your chain of command sees what you share; nothing else leaves the server.
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
        NO SUBSCRIPTIONS · NO TELEMETRY · NO THIRD-PARTY SERVICES
      </p>

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
