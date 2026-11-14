import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, History, PenLine, Send, Undo2, Stamp } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog, { type SaveAction } from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { recordDownloads, type DownloadChoice } from '@/components/DownloadMenu';
import { onText } from '@/components/common';
import { useCounselingRevisions, useCounselingStep } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp, humanize, isoDay, todayIso } from '@/lib/utils';
import { COUNSELING_TYPES } from '../../shared/constants';
import { formatDate } from '../../shared/metrics';
import {
  COUNSELING_CONTENT, COUNSELING_FIELD_LABELS, COUNSELING_LIMITS, amendmentLine, counselingTypeLabel, counselorWritten, documentBand,
  personLine, signatureNotes, worksheetHead, type CounselingDocument, type CounselingField, type CounselingOptions,
} from '../../shared/counseling';
import type { Counseling } from '../../shared/types';

/**
 * A counseling's workflow on the page (Task 20, ADR-0027): a counselor drafts it, may share it with its Marine for review,
 * and finalizes it; a final counseling changes only by amendment, which keeps what it said before; its Marine acknowledges
 * the text they read. What a reader may do comes with each row from the server (`workflow`), so the page offers only that.
 */

export interface CounselingDraft { id?: string; version?: number; user_id?: string; summary: string; date: string; type: string; counselor_name: string; strengths: string; improvements: string; goals_set: string; follow_up_date: string; visibility: 'private' | 'unit'; unit_id: string | null }

export const emptyCounseling = (v: 'private' | 'unit', unit: string | null): CounselingDraft => ({ summary: '', date: todayIso(), type: 'monthly', counselor_name: '', strengths: '', improvements: '', goals_set: '', follow_up_date: '', visibility: v, unit_id: unit });

/** A counseling as its form edits it: the words, and where it is shared. */
export const counselingDraft = (c: Counseling): CounselingDraft => ({
  id: c.id, version: c.version, user_id: c.user_id, summary: c.summary, date: c.date || '', type: c.type, counselor_name: c.counselor_name || '', strengths: c.strengths || '',
  improvements: c.improvements || '', goals_set: c.goals_set || '', follow_up_date: c.follow_up_date || '', visibility: c.visibility as 'private' | 'unit', unit_id: c.unit_id,
});

export function CounselingFields({ d, set, errors, leader }: { d: CounselingDraft; set: (k: any, v: unknown) => void; errors: Record<string, string>; leader?: boolean }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" error={errors.date} hint={leader ? 'needed to finalize' : undefined}><Input type="date" value={d.date} onChange={onText(set, 'date')} /></Field>
        <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={COUNSELING_TYPES.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
        {!leader && <Field label="Counselor" className="col-span-2"><Input value={d.counselor_name} onChange={onText(set, 'counselor_name')} placeholder="SSgt Rivera" /></Field>}
      </div>
      <Field label="Summary" required error={errors.summary}><Textarea autoFocus rows={3} value={d.summary} onChange={onText(set, 'summary')} placeholder="What was discussed and decided." /></Field>
      <Field label="Strengths" error={errors.strengths}><Textarea rows={2} value={d.strengths} onChange={onText(set, 'strengths')} /></Field>
      <Field label="Areas to improve" error={errors.improvements}><Textarea rows={2} value={d.improvements} onChange={onText(set, 'improvements')} /></Field>
      <Field label="Goals set" error={errors.goals_set}><Textarea rows={2} value={d.goals_set} onChange={onText(set, 'goals_set')} /></Field>
      <Field label="Follow-up" error={errors.follow_up_date}><Input type="date" value={d.follow_up_date} onChange={onText(set, 'follow_up_date')} /></Field>
      {!leader && <VisibilityPicker value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />}
    </>
  );
}

const needsSummary = (d: CounselingDraft) => (!d.summary.trim() ? 'A summary is required.' : null);
const needsDate = (d: CounselingDraft) => (!d.date ? { message: 'Give the date of the counseling session before finalizing it.', fieldErrors: { date: 'Required to finalize.' } } : null);

/**
 * The counseling form. A Marine's own notes save as they always have. A counselor's counseling saves as a draft, is
 * shared with its Marine for review, or is finalized, from the form; once final it is amended instead (AmendDialog).
 */
export function CounselingDialog({ open, onOpenChange, initial, row, leader, title, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial: CounselingDraft | null;
  /** The counseling being edited, as the server sent it: its stage decides the buttons. */
  row?: Counseling | null;
  /** Written by a counselor about another Marine: the workflow applies. */
  leader?: boolean; title: string; onSaved?: (saved: Counseling) => void;
}) {
  const stage = row?.stage ?? 'draft';
  // The step after the save goes through the same cache as the workflow buttons, so the list shows where it now stands.
  const step = useCounselingStep();
  const then = (to: api.CounselingStep) => (saved: Counseling) => step.mutateAsync({ id: saved.id, step: to, version: saved.version });
  // Only the steps the server says this reader may take on it: a counselor who no longer counsels the Marine still edits
  // their draft, but neither shares nor finalizes it.
  const may = (k: 'share' | 'finalize') => !row?.workflow || row.workflow[k];
  // A new one is created at the stage asked for; a draft is saved, then moved on.
  const actions: Array<SaveAction<CounselingDraft>> | undefined = !leader ? undefined : !initial?.id
    ? [
      { label: 'Save draft', done: 'Draft saved. Only you can see it.', patch: { stage: 'draft' } as Partial<CounselingDraft> },
      { label: 'Share with Marine', done: 'Shared with the Marine for review.', patch: { stage: 'review' } as Partial<CounselingDraft> },
      { label: 'Finalize', done: 'Finalized. The Marine is asked to acknowledge it.', variant: 'primary', check: needsDate, patch: { stage: 'final' } as Partial<CounselingDraft> },
    ]
    : stage === 'draft'
      ? [
        { label: 'Save draft', done: 'Draft saved.' },
        ...(may('share') ? [{ label: 'Share with Marine', done: 'Shared with the Marine for review.', then: then('share') }] : []),
        ...(may('finalize') ? [{ label: 'Finalize', done: 'Finalized. The Marine is asked to acknowledge it.', variant: 'primary' as const, check: needsDate, then: then('finalize') }] : []),
      ]
      : [
        { label: 'Save changes', done: 'Saved. The Marine sees the change.' },
        ...(may('finalize') ? [{ label: 'Finalize', done: 'Finalized. The Marine is asked to acknowledge it.', variant: 'primary' as const, check: needsDate, then: then('finalize') }] : []),
      ];
  const note = !leader ? undefined : stage === 'review' ? 'The Marine is reading this draft.' : 'Only you see a draft. Once final it changes only by amendment.';
  return (
    <RecordDialog<CounselingDraft> store="counselings" open={open} onOpenChange={onOpenChange} initial={initial} title={title} noun="Counseling" size="lg" validate={needsSummary}
      actions={actions} note={note} onSaved={onSaved} fields={(d, set, errors) => <CounselingFields d={d} set={set} errors={errors} leader={leader} />} />
  );
}

/** Where a counseling stands, as a badge or two: its stage, whether its Marine acknowledged it, and whether it was amended. */
export function CounselingStatus({ row, me }: { row: Counseling; me?: string }) {
  if (!counselorWritten(row)) return <Badge>Self-recorded</Badge>;
  if (row.stage === 'draft') return <Badge>Draft</Badge>;
  if (row.stage === 'review') return <Badge tone="info">Shared for review</Badge>;
  const amended = row.revision > 1 ? <Badge className="ml-1">Amended</Badge> : null;
  if (row.acknowledged_at) return <><Badge tone="good">Acknowledged</Badge>{amended}</>;
  return <><Badge tone="warn">{row.user_id === me ? 'To acknowledge' : 'Awaiting acknowledgement'}</Badge>{amended}</>;
}

/** One sentence on where a counseling stands, and what happens next, for whoever reads it. */
export function counselingStanding(row: Counseling, me?: string): string {
  const subject = row.user_id === me;
  if (!counselorWritten(row)) return subject ? 'Your own notes of a counseling. They are always final, and yours to edit.' : 'The Marine’s own notes of a counseling.';
  const counselor = row.counselor_id === me ? 'you' : row.counselor_display || row.counselor_name || 'their counselor';
  if (row.stage === 'draft') return 'A draft. Only you can see it until you share it with the Marine or finalize it.';
  if (row.stage === 'review') {
    return subject ? `A draft ${counselor} shared with you for review. Comment on it below; you acknowledge it once it is final.`
      : `Shared with ${row.subject_name || 'the Marine'} for review. They can read it and comment, and acknowledge it once you finalize it.`;
  }
  // The reader's own calendar day, as the worksheet beside it gives it: the UTC day is already tomorrow every US evening.
  const final = `Final${row.finalized_at ? ` since ${formatDate(isoDay(new Date(row.finalized_at)), 'd MMM yyyy')}` : ''}${row.revision > 1 ? `, amended (revision ${row.revision})` : ''}.`;
  const ack = row.acknowledged_at ? `${subject ? 'You' : 'The Marine'} acknowledged ${row.revision > 1 ? 'this revision' : 'it'} on ${formatStamp(row.acknowledged_at)}.`
    : subject ? 'Acknowledge it to confirm you read it. It does not mean you agree.' : 'Awaiting the Marine’s acknowledgement.';
  return `${final} ${ack} It changes only by amendment, which keeps what it said before.`;
}

/** What one counseling downloads as: its worksheet as a PDF, then the record itself. */
export const counselingDownloads = (row: Pick<Counseling, 'id' | 'revision'>, revision?: number | null): DownloadChoice[] => [
  { label: 'As a worksheet (PDF)', url: api.counselingPdfUrl(row.id, revision), fallback: `vantage-counseling-${row.id.slice(0, 8)}-r${revision || row.revision}.pdf`, hint: 'NAVMC 2795 layout' },
  ...recordDownloads('counselings', row.id, false),
];

/** Opens the worksheet laid out for paper in its own tab: the preview, with Print. */
export const openCounselingPrint = (id: string, opts: { revision?: number | null; autoprint?: boolean } = {}) => { window.open(api.counselingPrintUrl(id, opts), '_blank', 'noopener'); };

/**
 * The workflow buttons a reader has on one counseling, as the server says they stand. Finalizing asks first, since a final
 * counseling changes only by amendment. `primary` marks the one step this reader is most likely here for.
 */
export function CounselingActions({ row, onEdit, onAmend, size = 'md', onMoved, only }: { row: Counseling; onEdit?: () => void; onAmend?: () => void; size?: 'xs' | 'sm' | 'md'; onMoved?: (row: Counseling) => void; only?: Array<keyof CounselingOptions> }) {
  const toast = useToast();
  const step = useCounselingStep();
  const [asking, setAsking] = useState(false);
  const given = row.workflow;
  if (!given) return null;
  const w = only ? Object.fromEntries(Object.entries(given).map(([k, v]) => [k, v && only.includes(k as keyof CounselingOptions)])) as unknown as CounselingOptions : given;
  const run = async (s: api.CounselingStep, done: string) => {
    try { const saved = await step.mutateAsync({ id: row.id, step: s, version: row.version }); toast.success(done); onMoved?.(saved); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const busy = step.isPending;
  return (
    <>
      {w.edit && onEdit && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={onEdit} disabled={busy}><PenLine className="h-4 w-4" aria-hidden />Edit</Button>}
      {w.share && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={() => run('share', 'Shared with the Marine for review.')} disabled={busy}><Send className="h-4 w-4" aria-hidden />Share with Marine</Button>}
      {w.withdraw && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={() => run('withdraw', 'Taken back. It is a draft only you can see.')} disabled={busy}><Undo2 className="h-4 w-4" aria-hidden />Take back</Button>}
      {w.amend && onAmend && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={onAmend} disabled={busy}><PenLine className="h-4 w-4" aria-hidden />Amend…</Button>}
      {w.finalize && <Button size={size} variant={size === 'xs' ? 'soft' : 'primary'} onClick={() => (row.date ? setAsking(true) : toast.error('Give the date of the counseling session before finalizing it. Edit the draft to add it.'))} disabled={busy}><Stamp className="h-4 w-4" aria-hidden />Finalize</Button>}
      {w.acknowledge && <Button size={size} variant={size === 'xs' ? 'soft' : 'primary'} onClick={() => run('acknowledge', 'Acknowledged.')} loading={busy}><CheckCircle2 className="h-4 w-4" aria-hidden />Acknowledge</Button>}
      <ConfirmDialog open={asking} onOpenChange={setAsking} title="Finalize this counseling?" danger={false} confirmLabel="Finalize" loading={busy}
        body={<p className="text-sm leading-relaxed text-ink-2">The Marine is asked to acknowledge it. Once final its words change only by amendment, which keeps what it said before, and it is shared as you placed it.</p>}
        onConfirm={async () => { await run('finalize', 'Finalized. The Marine is asked to acknowledge it.'); setAsking(false); }} />
    </>
  );
}

/**
 * Amending a final counseling: its counselor, who still counsels its Marine, or a records manager of the unit it is shared
 * with, changes what needs correcting and says why. What it said before is kept, and its Marine acknowledges it again.
 */
export function AmendDialog({ row, open, onOpenChange, onAmended }: { row: Counseling | null; open: boolean; onOpenChange: (o: boolean) => void; onAmended?: (row: Counseling) => void }) {
  const toast = useToast();
  const step = useCounselingStep();
  const [draft, setDraft] = useState<CounselingDraft | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { if (open && row) { setDraft(counselingDraft(row)); setReason(''); setErrors({}); setProblem(null); } }, [open, row]);
  if (!row || !draft) return null;
  const set = (k: keyof CounselingDraft, v: unknown) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; }); };
  const was = counselingDraft(row);
  const changed = COUNSELING_CONTENT.filter((f) => f !== 'counselor_name' && (draft[f] || '') !== (was[f] || ''));
  const submit = async () => {
    if (sending.current) return;
    // A field's own error says what is wrong with it; the line below the form says what is wrong with the whole.
    setProblem(null);
    if (!changed.length) { setErrors({}); setProblem('Nothing in the counseling changed. Change what needs amending, then say why.'); return; }
    if (!draft.summary.trim()) { setErrors({ summary: 'A summary is required.' }); return; }
    if (!reason.trim()) { setErrors({ reason: 'Say why the counseling is amended.' }); return; }
    const body = Object.fromEntries(changed.map((f) => [f, draft[f] || null])) as Partial<Record<CounselingField, string | null>>;
    sending.current = true;
    try {
      const saved = await step.mutateAsync({ id: row.id, step: 'amend', body: { ...body, version: row.version, reason: reason.trim() } });
      toast.success(`Amended. Revision ${saved.revision} is the counseling now, and the Marine is asked to acknowledge it.`);
      onAmended?.(saved);
      onOpenChange(false);
    } catch (e: any) {
      const fields = e?.fieldErrors || {};
      setErrors(fields);
      setProblem(e?.status === 409 && e?.code === 'stale' ? 'This counseling changed since you opened it. Close this, open it again and amend the newest text.' : Object.keys(fields).length ? null : api.errorText(e));
    } finally { sending.current = false; }
  };
  const left = COUNSELING_LIMITS.reason - reason.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Amend counseling" description={`${counselingTypeLabel(row.type)}${row.date ? ` of ${formatDate(row.date, 'd MMMM yyyy')}` : ''}, revision ${row.revision}`} size="lg"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={step.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={step.isPending}>Amend</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-xs leading-relaxed text-ink-3">What it says now is kept as revision {row.revision}, and stays readable in its history. The Marine is told, and acknowledges the amended text again.</p>
        <CounselingFields d={draft} set={set} errors={errors} leader />
        <Field label="Why it is amended" required error={errors.reason} hint={left < 100 ? `${left} characters left` : 'the Marine reads this'}>
          <Textarea rows={2} maxLength={COUNSELING_LIMITS.reason} value={reason} onChange={(e) => { setReason(e.target.value); setErrors((x) => ({ ...x, reason: '' })); }} placeholder="The follow-up date was wrong; corrected after the session." />
        </Field>
        {changed.length > 0 && <p className="text-xs text-ink-3">Changes: {changed.map((f) => COUNSELING_FIELD_LABELS[f]).join(', ')}.</p>}
        {problem && <p role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{problem}</p>}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Dialog>
  );
}

/** A final counseling's amendments, newest first: who changed what, when and why, and each earlier text to read or print. */
export function CounselingHistory({ row, className }: { row: Counseling; className?: string }) {
  const amended = row.stage === 'final' && row.revision > 1;
  const { data, isPending, error } = useCounselingRevisions(row.id, amended);
  if (!amended) return null;
  return (
    <section aria-labelledby={`history-${row.id}`} className={className}>
      <h3 id={`history-${row.id}`} className="eyebrow mb-1.5 flex items-center gap-1.5"><History className="h-3.5 w-3.5" aria-hidden />Amendment history</h3>
      {isPending ? <Skeleton className="h-12" /> : error || !data ? <p className="text-xs text-ink-3">{api.errorText(error)}</p> : (
        <ol className="divide-y divide-line rounded-md border border-line">
          <li className="px-3 py-2 text-xs text-ink-2">Revision {data.revision} is what it says now.</li>
          {data.revisions.map((r) => (
            <li key={r.revision} className="px-3 py-2 text-sm">
              <p className="text-xs font-semibold text-ink-2">Revision {r.revision} replaced on {formatStamp(r.amended_at)}{r.amended_by_name ? ` by ${r.amended_by_name}` : ''}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-ink">Why: {r.reason}</p>
              <p className="mt-0.5 text-xs text-ink-3">Changed {r.changed.map((f) => COUNSELING_FIELD_LABELS[f] ?? f).join(', ') || 'nothing'}{r.acknowledged_at ? `; the Marine had acknowledged revision ${r.revision} on ${formatStamp(r.acknowledged_at)}` : ''}.</p>
              <Button size="xs" variant="ghost" className="mt-1 -ml-2" onClick={() => openCounselingPrint(row.id, { revision: r.revision })}><ExternalLink className="h-3.5 w-3.5" aria-hidden />Read revision {r.revision}</Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The worksheet itself, in the layout of NAVMC 2795 Appendix A, drawn from the document the server builds: the preview in
 * a dialog (`screen`) and the page laid out for paper (`print`) are this, and the PDF draws the same document.
 */
export function CounselingWorksheet({ doc, variant = 'screen' }: { doc: CounselingDocument; variant?: 'screen' | 'print' }) {
  const band = documentBand(doc);
  const notes = signatureNotes(doc);
  const H1 = variant === 'print' ? 'h1' : 'h3';
  const H2 = variant === 'print' ? 'h2' : 'h4';
  const cells = (rows: ReturnType<typeof worksheetHead>) => rows.map((r, i) => (
    <div key={i} className="cw-row" style={{ '--cw-cols': r.map((c) => `${c.span}fr`).join(' ') } as React.CSSProperties}>
      {r.map((c) => <div key={c.label} className="cw-cell"><span className="cw-label">{c.label}</span><span className="cw-value">{c.value || ' '}</span></div>)}
    </div>
  ));
  const body = (
    <>
      <header className="cw-head">
        <p className="cw-eyebrow">Vantage · User’s Guide to Counseling (NAVMC 2795)</p>
        <H1 className="cw-title">{doc.worksheet.caption}</H1>
        <p className="cw-sub">{doc.worksheet.figure} layout. Not an official form.</p>
      </header>
      {band && <p className="cw-band">{band}</p>}
      <div className="cw-grid">{cells(worksheetHead(doc))}</div>
      <p className="cw-aside">The SSN block on the worksheet is left out: Vantage does not record or print an SSN.</p>
      {doc.blocks.map((b) => (
        <section key={b.key} className="cw-block" aria-labelledby={`cw-${doc.id}-${b.key}`}>
          <H2 id={`cw-${doc.id}-${b.key}`} className="cw-block-head">{b.label}</H2>
          {!b.parts.length ? <p className="cw-empty">Nothing recorded.</p> : b.parts.map((p, i) => (
            <div key={i}>{p.label && <p className="cw-part">{p.label}</p>}<p className="cw-text">{p.text}</p></div>
          ))}
        </section>
      ))}
      <div className="cw-signs">
        <div className="cw-sign"><strong>Marine Counseled</strong><span>{personLine({ name: doc.particulars.subject.name, rank: doc.particulars.subject.rank }) || ' '}</span><small>{notes.subject}</small></div>
        <div className="cw-sign"><strong>Marine Performing Counseling</strong><span>{personLine(doc.particulars.counselor) || ' '}</span><small>{notes.counselor}</small></div>
      </div>
      <div className="cw-grid">{cells([[{ label: 'Target Date for Next Session', value: doc.follow_up_date ?? '', span: 1 }]])}</div>
      {doc.amendments.length > 0 && (
        <section className="cw-block" aria-labelledby={`cw-${doc.id}-amendments`}>
          <H2 id={`cw-${doc.id}-amendments`} className="cw-block-head">Amendment history ({doc.amendments_total})</H2>
          <ol className="cw-amendments">{doc.amendments.map((a) => <li key={a.revision}><p className="cw-part">{amendmentLine(a, doc.generated.zone)}</p><p className="cw-text">Why: {a.reason}</p></li>)}</ol>
          {doc.amendments_total > doc.amendments.length && <p className="cw-empty">{doc.amendments_total - doc.amendments.length} earlier amendments are in the record’s history.</p>}
        </section>
      )}
      <ul className="cw-notes">{[...doc.notices, doc.source].map((n) => <li key={n}>{n}</li>)}</ul>
    </>
  );
  const foot = `${doc.worksheet.figure} · record ${doc.id.slice(0, 8)} · revision ${doc.revision}${band ? ` · ${band}` : ''} · Generated ${doc.generated.on} by ${doc.generated.by} in Vantage, from the structured counseling record.`;
  if (variant === 'screen') {
    return (
      <article className="report-doc cw report-screen" aria-label="Counseling worksheet">
        <p className="report-marking">{doc.marking}</p>
        {body}
        <p className="report-marking report-marking-foot">{doc.marking}</p>
        <p className="cw-foot">{foot}</p>
      </article>
    );
  }
  // On paper, the handling line heads and foots every page, as the PDF's does: a table's header and footer repeat on each
  // printed page it reaches (the report print frame, ADR-0020). It lays the page out and holds no data.
  return (
    <article className="report-doc cw report-print" aria-label="Counseling worksheet">
      <table className="report-frame" role="presentation">
        <thead><tr><td><p className="report-running"><span>{doc.marking}</span><span>{doc.worksheet.figure}{band ? ` · ${band}` : ''}</span></p></td></tr></thead>
        <tfoot><tr><td><p className="report-running report-running-foot"><span>{doc.marking}</span><span>{foot}</span></p></td></tr></tfoot>
        <tbody><tr><td>{body}</td></tr></tbody>
      </table>
    </article>
  );
}

/** The worksheet of one counseling as a preview inside its dialog, read from the server when it is shown. */
export function CounselingPreview({ row }: { row: Counseling }) {
  const { data, error, isPending } = useWorksheet(row.id, row.version);
  if (isPending) return <div aria-busy="true"><Skeleton className="h-64" /></div>;
  if (error || !data) return <EmptyState title="Could not prepare the worksheet" description={api.errorText(error)} />;
  return <CounselingWorksheet doc={data} />;
}

/** The worksheet for one version of a counseling: a new version draws a new worksheet. */
function useWorksheet(id: string, version: number) {
  return useQuery({ queryKey: ['counseling-worksheet', id, version], queryFn: () => api.counselingWorksheet(id), staleTime: 30_000 });
}
