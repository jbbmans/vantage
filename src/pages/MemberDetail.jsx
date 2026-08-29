import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, FileText, Award, GraduationCap, Target, ShieldAlert, UserX, UserCheck, KeyRound, LogOut, UserMinus } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { unitPath, displayName, refreshAll, useIdentity, can, PERMISSIONS } from '@/store/useStore';
import { aggregateMetrics, activitiesInRange, rangeForPeriod, formatDollarsExact, formatNumber, formatDTG } from '@/lib/metrics';
import { composeNarrative } from '@/lib/narrative';
import { narrativeConfig, trackMeta, trackForPerson } from '@/lib/evaluation';
import { buildPackage, packageToText, strength, weaknesses } from '@/lib/bullets';
import { copyToClipboard } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Panel, PageHeader, EmptyState, Button, Badge, Segmented, Tooltip, Input, Field } from '@/components/ui/primitives';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Figure, FigureRow } from '@/components/Figure';
import { cn } from '@/lib/utils';

const PERIODS = [
  { value: 'fiscalQuarter', label: 'FQ', ariaLabel: 'Fiscal quarter' },
  { value: 'fiscalYear', label: 'FY', ariaLabel: 'Fiscal year' },
  { value: 'all', label: 'ALL', ariaLabel: 'All time' },
];

/**
 * One Marine's record, as their leader sees it.
 *
 * This exists so a fire team leader writing a JEPES input isn't reconstructing
 * a year from memory the night before it's due. Every read of this page is
 * logged against the Marine, and they can see that log on their own account.
 */
export default function MemberDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const identity = useIdentity();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('fiscalYear');
  // The access review is also the authority check. Only the Instance Operator
  // receives it; unit leaders manage membership without gaining control of a
  // multi-unit account's password or sessions.
  const [review, setReview] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [pwDialog, setPwDialog] = useState(false);
  const [removeMembership, setRemoveMembership] = useState(null);
  const [ownershipMembership, setOwnershipMembership] = useState(null);
  const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState(false);

  const loadMember = useCallback(() => {
    apiClient.member(id).then((d) => { setData(d); setError(''); }).catch((err) => setError(err.message));
  }, [id]);
  const loadReview = useCallback(() => {
    apiClient.accessReview(id).then(setReview).catch(() => setReview(null));
  }, [id]);

  useEffect(() => { loadMember(); loadReview(); }, [loadMember, loadReview]);

  const act = async (fn, done) => {
    setBusy(true);
    try { const r = await fn(); done?.(r); }
    catch (err) { toast.error(apiClient.errorText(err)); }
    finally { setBusy(false); }
  };
  const deactivate = () => act(() => apiClient.deactivateMember(id), (r) => {
    setConfirmOff(false);
    toast.success(`Account deactivated. ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'} signed out.`);
    refreshAll(); loadMember(); loadReview();
  });
  const reactivate = () => act(() => apiClient.reactivateMember(id), () => {
    toast.success('Account reactivated.');
    refreshAll(); loadMember(); loadReview();
  });
  const resetPw = () => act(() => apiClient.resetMemberPassword(id, newPw), () => {
    setPwDialog(false); setNewPw('');
    toast.success('Temporary password issued. Every session was signed out; the Marine must replace it at next sign-in.');
    loadReview();
  });
  const forceOut = () => act(() => apiClient.forceLogoutMember(id), (r) => {
    const n = r.sessionsRevoked ?? 0;
    toast.success(n ? `${n} session${n === 1 ? '' : 's'} signed out.` : 'No live sessions to sign out.');
    loadReview();
  });
  const removeFromUnit = () => act(
    () => apiClient.removeUnitMember(removeMembership.unit_id, id),
    (r) => {
      setRemoveMembership(null);
      toast.success(`Removed from the unit. ${r.recordsFrozen || 0} shared record${r.recordsFrozen === 1 ? '' : 's'} frozen as history.`);
      refreshAll();
      navigate('/team');
    }
  );
  const transferOwnership = () => act(
    () => apiClient.transferUnitOwnership(ownershipMembership.unit_id, id),
    () => {
      toast.success('Unit ownership transferred. Former-owner administrator grants were revoked.');
      setOwnershipMembership(null);
      refreshAll();
      loadMember();
    }
  );
  const whenShort = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : 'never');

  const range = useMemo(() => rangeForPeriod(period), [period]);
  const scoped = useMemo(
    () => activitiesInRange(data?.activities || [], range),
    [data, range]
  );
  const metrics = useMemo(() => aggregateMetrics(scoped), [scoped]);
  // The member's rank decides the framing: a Sgt in the roster gets a FITREP
  // input, not a JEPES one, whoever is looking at them.
  const memberTrack = trackForPerson(data?.person || {});
  const narrative = useMemo(() => {
    const cfg = narrativeConfig(memberTrack);
    return composeNarrative(scoped, { ...cfg, periodLabel: range.label || period });
  }, [scoped, range, period, memberTrack]);

  // A deactivated Marine drops off every normal surface — which is the point —
  // so the one leader-facing view of them is this management card.
  if (error && review && review.user?.active === false) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Link to="/team" className="flex items-center gap-1.5 text-xs text-text-3 hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" />
          Roster
        </Link>
        <Panel title={`${review.user.last_name}, ${review.user.first_name}`} subtitle="Deactivated account">
          <p className="text-sm leading-relaxed text-text-2">
            This Marine cannot sign in and no longer appears on the roster. Their historical
            performance records are retained and stay attributed to them.
          </p>
          {review.findings?.length > 0 && (
            <ul className="mt-2.5 space-y-1 border-t border-rule pt-2.5">
              {review.findings.map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs leading-relaxed text-signal">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-end border-t border-rule pt-3">
            <Button size="sm" disabled={busy} onClick={reactivate}>
              <UserCheck className="h-3.5 w-3.5" />
              Reactivate account
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl">
        <Panel>
          <EmptyState
            title="That record isn't available to you"
            description={error}
            action={<Button size="sm" asChild><Link to="/team">Back to the roster</Link></Button>}
          />
        </Panel>
      </div>
    );
  }

  if (!data) return <p className="text-sm text-text-3">Loading record…</p>;

  const { person } = data;
  const gapped = (data.activities || []).filter((a) => strength(a) <= 1);

  return (
    <div className="mx-auto max-w-[1200px] space-y-3">
      <Link to="/team" className="flex items-center gap-1.5 text-xs text-text-3 hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" />
        Roster
      </Link>

      <PageHeader
        title={`${person.last_name}, ${person.first_name} ${person.middle_initial || ''}`.trim()}
        subtitle={[
          person.rank_name,
          person.billet_title,
          person.mos && `MOS ${person.mos}`,
          unitPath(person.unit_id).map((u) => u.short_name || u.name).join(' › '),
        ].filter(Boolean).join(' · ')}
      >
        <Segmented value={period} onChange={setPeriod} options={PERIODS} />
      </PageHeader>

      <FigureRow>
        <Figure label="Entries" raw={scoped.length} formatFn={(n) => formatNumber(Math.round(n))} sub={`${data.activities.length} all time`} />
        <Figure label="Dollar impact" raw={metrics.totalDollars} formatFn={(n) => formatDollarsExact(n)} tone="ledger" sub="excludes reviewed" />
        <Figure label="Units processed" raw={metrics.totalQuantity} formatFn={(n) => formatNumber(Math.round(n))} sub="all quantities" />
        <Figure
          label="With outcome"
          value={`${scoped.length ? Math.round((scoped.filter((a) => a.result).length / scoped.length) * 100) : 0}%`}
          sub={`${gapped.length} entries thin`}
          tone={gapped.length ? 'redline' : 'default'}
        />
      </FigureRow>

      {/* The reason a leader opens this page at all */}
      <Panel
        title={trackMeta(memberTrack).inputName}
        subtitle={`Ready to paste · ${narrative.length}/${narrative.limit} characters`}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const ok = await copyToClipboard(narrative.text);
              ok ? toast.success('Narrative copied.') : toast.error('Could not reach the clipboard.');
            }}
          >
            <Copy className="h-3 w-3" />
            Copy
          </Button>
        }
      >
        {narrative.text ? (
          <>
            <p className="text-base leading-relaxed text-text">{narrative.text}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule pt-2.5">
              {narrative.areas.map((a) => (
                <span key={a.label} className="fig text-2xs text-text-3">
                  {a.label} <span className="text-text-2">{a.count}</span>
                </span>
              ))}
              {narrative.omitted > 0 && (
                <span className="fig text-2xs text-signal">{narrative.omitted} entries did not fit</span>
              )}
            </div>
          </>
        ) : (
          <EmptyState icon={FileText} title="Nothing logged in this window" description="Widen the period, or this Marine hasn't logged yet." />
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Recent entries" bodyClassName="p-0">
          {scoped.length === 0 ? (
            <EmptyState title="Nothing in this window" />
          ) : (
            scoped.slice(0, 12).map((a) => (
              <div key={a.id} className="row flex items-center gap-2.5 px-3 py-2">
                <span className="fig w-16 shrink-0 text-2xs text-text-3">{formatDTG(a.date)}</span>
                <span className="min-w-0 flex-1 truncate text-base text-text">{a.title}</span>
                {a.dollar_amount ? (
                  <span className="fig shrink-0 text-xs text-ledger">{formatDollarsExact(a.dollar_amount)}</span>
                ) : null}
                <span className="hidden shrink-0 items-center gap-0.5 md:flex">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className={cn('h-1 w-2 rounded-sm', i < strength(a) ? 'bg-signal/70' : 'bg-rule')} />
                  ))}
                </span>
              </div>
            ))
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="Needs strengthening" subtitle="Coach these before the package is due" bodyClassName="p-0">
            {gapped.length === 0 ? (
              <EmptyState title="No activity in this period" description="Adjust the reporting window or add an authorized record." />
            ) : (
              gapped.slice(0, 6).map((a) => (
                <div key={a.id} className="row px-3 py-2">
                  <p className="truncate text-sm text-text">{a.title}</p>
                  <p className="truncate text-2xs text-text-3">{weaknesses(a).slice(0, 2).join(' · ')}</p>
                </div>
              ))
            )}
          </Panel>

          <Panel title="Recognition and development" bodyClassName="p-0">
            {[...(data.recognitions || []).map((r) => ({ ...r, kind: 'recognition' })),
              ...(data.trainings || []).map((t) => ({ ...t, kind: 'training' }))]
              .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
              .slice(0, 8)
              .map((r) => (
                <div key={r.id} className="row flex items-center gap-2.5 px-3 py-1.5">
                  {r.kind === 'recognition'
                    ? <Award className="h-3 w-3 shrink-0 text-signal" />
                    : <GraduationCap className="h-3 w-3 shrink-0 text-text-3" />}
                  <span className="min-w-0 flex-1 truncate text-sm text-text-2">{r.title}</span>
                  <span className="fig shrink-0 text-2xs text-text-3">{formatDTG(r.date)}</span>
                </div>
              ))}
            {!(data.recognitions?.length || data.trainings?.length) && (
              <EmptyState title="Nothing recorded yet" />
            )}
          </Panel>
        </div>
      </div>

      {(data.memberships || []).some((m) => m.kind !== 'owner' && can(PERMISSIONS.MANAGE_MEMBERS, m.unit_id)) && (
        <Panel title="Unit memberships" subtitle="Unit access can be removed without taking over or disabling the account" bodyClassName="p-0">
          {(data.memberships || [])
            .filter((m) => m.kind !== 'owner' && can(PERMISSIONS.MANAGE_MEMBERS, m.unit_id))
            .map((membership) => (
              <div key={membership.unit_id} className="row flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text">{membership.unit_short || membership.unit_name}</p>
                  <p className="fig text-2xs text-text-3">{membership.kind}{membership.expires_at ? ` · expires ${membership.expires_at.slice(0, 10)}` : ''}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemoveMembership(membership)}>
                  <UserMinus className="h-3.5 w-3.5" />
                  Remove from unit
                </Button>
              </div>
            ))}
        </Panel>
      )}

      {(data.memberships || []).some((m) => m.kind !== 'owner' && identity?.ownedUnitIds?.includes(m.unit_id)) && (
        <Panel title="Ownership succession" subtitle="Transfer the unit before removing or deactivating its current owner" bodyClassName="p-0">
          {(data.memberships || [])
            .filter((m) => m.kind !== 'owner' && identity?.ownedUnitIds?.includes(m.unit_id))
            .map((membership) => (
              <div key={membership.unit_id} className="row flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text">{membership.unit_short || membership.unit_name}</p>
                  <p className="text-2xs text-text-3">Successor must already be an active member of this exact unit.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setOwnershipMembership(membership)}>
                  <UserCheck className="h-3.5 w-3.5" />
                  Make Unit Owner
                </Button>
              </div>
            ))}
        </Panel>
      )}

      {review && (
        <Panel
          title="Account and access"
          subtitle={`Last sign-in ${whenShort(review.lastLogin)} · ${review.sessions.length} active session${review.sessions.length === 1 ? '' : 's'}`}
          action={review.user.is_operator ? <Badge tone="signal">Instance Operator</Badge> : null}
        >
          {review.findings?.length > 0 && (
            <ul className="mb-3 space-y-1 border-b border-rule pb-3">
              {review.findings.map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs leading-relaxed text-signal">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="eyebrow">Roles held</p>
              <div className="mt-1 space-y-1">
                {review.roles.map((r) => (
                  <div key={r.grant_id} className="flex items-center gap-2 text-sm text-text-2">
                    <span className="min-w-0 truncate">{r.name}</span>
                    <span className="fig text-2xs text-text-3">{r.unit_id}</span>
                    {r.orphaned && <Badge tone="redline">no assignment there</Badge>}
                  </div>
                ))}
                {review.roles.length === 0 && <p className="text-sm text-text-3">None.</p>}
              </div>
            </div>
            <div>
              <p className="eyebrow">Sessions</p>
              <div className="mt-1 space-y-1">
                {review.sessions.map((sess) => (
                  <div key={sess.id} className="flex items-center gap-2 text-sm text-text-2">
                    <span className="fig text-2xs text-text-3">{sess.id}</span>
                    <span className="min-w-0 flex-1 truncate text-2xs text-text-3">{sess.ip || ''}</span>
                    <span className="fig text-2xs text-text-3">last used {whenShort(sess.last_used_at)}</span>
                  </div>
                ))}
                {review.sessions.length === 0 && <p className="text-sm text-text-3">Not signed in anywhere.</p>}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-3">
            <Button variant="ghost" size="sm" disabled={busy || review.sessions.length === 0} onClick={forceOut}>
              <LogOut className="h-3.5 w-3.5" />
              Force sign-out
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPwDialog(true)}>
              <KeyRound className="h-3.5 w-3.5" />
              Reset password
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmOff(true)}>
              <UserX className="h-3.5 w-3.5" />
              Deactivate
            </Button>
          </div>
        </Panel>
      )}

      {confirmOff && (
        <Dialog
          open
          onOpenChange={(v) => !v && setConfirmOff(false)}
          title="Deactivate this account?"
          description="Sign-in stops immediately, every live session ends, and the Marine leaves the roster. Records are retained. This is reversible from this page."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(false)}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={deactivate}>Deactivate account</Button>
            </>
          }
        />
      )}

      {pwDialog && (
        <Dialog
          open
          onOpenChange={(v) => { if (!v) { setPwDialog(false); setNewPw(''); } }}
          title="Reset this Marine's password"
          description="Every session will be signed out. Deliver the temporary password through an approved channel; Vantage requires the Marine to replace it at next sign-in."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => { setPwDialog(false); setNewPw(''); }}>Cancel</Button>
              <Button size="sm" disabled={busy || newPw.length < 15} onClick={resetPw}>Reset password</Button>
            </>
          }
        >
          <Field label="New password" hint="At least 15 characters">
            <Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </Field>
        </Dialog>
      )}

      <ConfirmDialog
        open={Boolean(removeMembership)}
        onOpenChange={(open) => !open && setRemoveMembership(null)}
        title={`Remove from ${removeMembership?.unit_short || removeMembership?.unit_name || 'this unit'}?`}
        body="This ends live assignments and role grants in this unit. Unit-shared records are frozen as the originating unit's history. Other-unit sessions remain active because every request rechecks current membership."
        confirmLabel="Remove membership"
        onConfirm={removeFromUnit}
      />
      <ConfirmDialog
        open={Boolean(ownershipMembership)}
        onOpenChange={(open) => !open && setOwnershipMembership(null)}
        title={`Make ${data?.person?.rank_abbr || ''} ${data?.person?.last_name || 'this Marine'} the Unit Owner?`}
        body="The current owner loses owner authority and any administrator-bit grants in this unit. The successor receives owner authority through the unit record. This action is audited."
        confirmLabel="Transfer ownership"
        onConfirm={transferOwnership}
      />
    </div>
  );
}
