import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, History, PenLine, Send, Undo2, Stamp } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog, { missing, type SaveAction } from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { recordDownloads, type DownloadChoice } from '@/components/DownloadMenu';
import { onText } from '@/components/common';
import { useCounselingRevisions, useCounselingStep } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp, humanize, isoDay, todayIso } from '@/lib/utils';
import { COUNSELING_TYPES } from '../../shared/constants';
import { formatDate } from '../../shared/metrics';
import {
  COUNSELING_CONTENT, COUNSELING_FIELD_LABELS, COUNSELING_LIMITS, WORKSHEET_COLUMNS, amendmentLine, counselingTypeLabel, counselorWritten, dayOf, documentBand,
  signatureNotes, type CounselingDocument, type CounselingField, type CounselingOptions, type WorksheetBox,
} from '../../shared/counseling';
import { EdipiForm } from '@/components/EdipiOnFile';
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

const needsSummary = (d: CounselingDraft) => (!d.summary.trim() ? missing('summary', 'A summary is required.') : null);
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

/**
 * What one counseling downloads as: its COUNSELING WORKSHEET as a PDF, then the record itself. `before` runs ahead of the
 * worksheet (the EDIPI gate, which asks for one's own EDIPI when it is not on one's profile).
 */
export const counselingDownloads = (row: Pick<Counseling, 'id' | 'revision'>, revision?: number | null, before?: () => Promise<boolean>): DownloadChoice[] => [
  { label: 'As a worksheet (PDF)', url: api.counselingPdfUrl(row.id, revision), fallback: `vantage-counseling-${row.id.slice(0, 8)}-r${revision || row.revision}.pdf`, hint: 'COUNSELING WORKSHEET, fillable', before },
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
      {w.share && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={() => run('share', 'Shared with the Marine for review.')} disabled={busy} data-tutorial="counseling-share"><Send className="h-4 w-4" aria-hidden />Share with Marine</Button>}
      {w.withdraw && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={() => run('withdraw', 'Taken back. It is a draft only you can see.')} disabled={busy}><Undo2 className="h-4 w-4" aria-hidden />Take back</Button>}
      {w.amend && onAmend && <Button size={size} variant={size === 'xs' ? 'ghost' : 'default'} onClick={onAmend} disabled={busy}><PenLine className="h-4 w-4" aria-hidden />Amend…</Button>}
      {w.finalize && <Button size={size} variant={size === 'xs' ? 'soft' : 'primary'} onClick={() => (row.date ? setAsking(true) : toast.error('Give the date of the counseling session before finalizing it. Edit the draft to add it.'))} disabled={busy}><Stamp className="h-4 w-4" aria-hidden />Finalize</Button>}
      {w.acknowledge && <Button size={size} variant={size === 'xs' ? 'soft' : 'primary'} onClick={() => run('acknowledge', 'Acknowledged.')} loading={busy} data-tutorial="counseling-acknowledge"><CheckCircle2 className="h-4 w-4" aria-hidden />Acknowledge</Button>}
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

const COLS = WORKSHEET_COLUMNS.map((c) => `${c}fr`).join(' ');
const span = (b: WorksheetBox) => ({ gridColumn: `${b.cols[0] + 1} / ${b.cols[1] + 1}` });

/**
 * The COUNSELING WORKSHEET itself, box for box as the form Marines use (ADR-0033), drawn from the document the server
 * builds: the preview in a dialog (`screen`) and the page laid out for paper (`print`) are this, and the PDF draws the
 * same document. A box Vantage leaves blank says so on screen and is blank on paper. On screen the EDIPI boxes show
 * only the last four digits; the print page and the PDF print them whole. `onAddEdipi` offers the reader's own empty
 * EDIPI box a way to fill it from their profile.
 */
export function CounselingWorksheet({ doc, variant = 'screen', onAddEdipi }: { doc: CounselingDocument; variant?: 'screen' | 'print'; onAddEdipi?: () => void }) {
  const band = documentBand(doc);
  const notes = signatureNotes(doc);
  const w = doc.worksheet;
  const H1 = variant === 'print' ? 'h1' : 'h3';
  const H2 = variant === 'print' ? 'h2' : 'h4';
  const uid = `cw-${doc.id.slice(0, 8)}-${variant}`;
  const yours = doc.edipi.yours ? `${doc.edipi.yours}_edipi` : null;
  // A box Vantage has nothing for stays empty, as on the paper form; a screen reader hears that it is blank. The
  // reader's own empty EDIPI box offers to add it ("If not there, make them type").
  const blank = (b: WorksheetBox) => (variant === 'print' ? null
    : b.key === yours && onAddEdipi ? <button type="button" className="cw-add" onClick={onAddEdipi}>Add yours</button>
      : <span className="sr-only">{b.key.endsWith('_edipi') ? 'Blank, not on their profile' : 'Blank'}</span>);
  const row = (boxes: WorksheetBox[], short = false) => (
    <div className={`cw-grid${short ? ' is-short' : ''}`} style={{ '--cw-cols': COLS } as React.CSSProperties}>
      {boxes.map((b) => (
        <span key={`l-${b.key}`} className="cw-lab" style={span(b)} id={`${uid}-${b.key}`}>{b.label.map((l) => <span key={l}>{l}</span>)}</span>
      ))}
      {boxes.map((b) => (
        <span key={`v-${b.key}`} className="cw-val" style={span(b)} aria-labelledby={`${uid}-${b.key}`} role="group">{b.value || blank(b)}</span>
      ))}
    </div>
  );
  const annex = Boolean(band || doc.amendments.length || doc.own_notes || (doc.particulars_as_of === 'now' && doc.stage === 'final'));
  const form = (
    <div className="cw-form">
      <H1 className="cw-title">{w.title}</H1>
      {band && variant === 'screen' && <p className="cw-band">{band}</p>}
      <p className="cw-refs">{w.references}</p>
      <section aria-labelledby={`${uid}-a`}>
        <H2 id={`${uid}-a`} className="cw-bar">{w.admin.heading}</H2>
        {row(w.admin.rows[0])}
        {row(w.admin.rows[1], true)}
        {row(w.admin.rows[2])}
      </section>
      <section aria-labelledby={`${uid}-b`}>
        <H2 id={`${uid}-b`} className="cw-bar">{w.billet.heading} <small>{w.billet.note}</small></H2>
        <p className="cw-line">{w.billet.box.value || blank(w.billet.box)}</p>
      </section>
      {w.sections.map((sec) => (
        <section key={sec.key} className="cw-section" aria-labelledby={`${uid}-${sec.key}`}>
          <H2 id={`${uid}-${sec.key}`} className="cw-bar">{sec.heading}</H2>
          <div className="cw-narrative" data-key={sec.key}>
            {sec.parts.length ? sec.parts.map((p, i) => <p key={i}>{p.label ? `${p.label.toUpperCase()}:\n` : ''}{p.text}</p>) : variant === 'screen' ? <span className="cw-hint">Nothing recorded in Vantage.</span> : null}
          </div>
        </section>
      ))}
      <section aria-labelledby={`${uid}-g`}>
        <H2 id={`${uid}-g`} className="cw-bar">{w.certification.heading}</H2>
        {w.certification.rows.map((r) => (
          <div key={r.key} className="cw-sign" style={{ '--cw-cols': COLS } as React.CSSProperties}>
            <span style={{ gridColumn: '1 / 6' }}>{r.label}</span>
            <span style={{ gridColumn: '6 / 9' }}>{r.date.label[0]}</span>
            <div style={{ gridColumn: '1 / 6' }} aria-label={`${r.label}: blank, to sign`} role="group" />
            <div style={{ gridColumn: '6 / 9' }} aria-label={`${r.date.label[0]}: blank, to fill in`} role="group" />
          </div>
        ))}
      </section>
    </div>
  );
  // What Vantage knows that the form has no box for. On paper it prints on a page of its own, only when there is
  // something to say; on screen it always shows, with what the reader needs to know about the blank boxes.
  const about = (
    <section className="cw-about" data-annex={String(annex)} aria-labelledby={`${uid}-about`}>
      <H2 id={`${uid}-about`}>About this worksheet</H2>
      <p className="cw-status">Marine reported on: {notes.subject}<br />Marine performing counseling: {notes.counselor}</p>
      {doc.amendments.length > 0 && <>
        <h4>Amendment history ({doc.amendments_total})</h4>
        <ol className="cw-amendments">{doc.amendments.map((a) => <li key={a.revision}><p><strong>{amendmentLine(a, doc.generated.zone)}</strong></p><p>Why: {a.reason}</p></li>)}</ol>
        {doc.amendments_total > doc.amendments.length && <p>{doc.amendments_total - doc.amendments.length} earlier amendments are in the record’s history.</p>}
      </>}
      <ul>{[...doc.notices, doc.source].map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
  const status = [doc.finalized.at ? `finalized ${dayOf(doc.finalized.at, doc.generated.zone)}${doc.finalized.by ? ` by ${doc.finalized.by}` : ''}` : null, doc.acknowledgement.at ? `acknowledged ${dayOf(doc.acknowledgement.at, doc.generated.zone)}` : null].filter(Boolean).join(' · ');
  const foot = `Vantage record ${doc.id.slice(0, 8)} · revision ${doc.revision}${status ? ` · ${status}` : ''} · generated ${doc.generated.on} by ${doc.generated.by}`;
  // Keeps the form's proportions: on a phone it scrolls sideways inside itself, not the page. On paper it is the page's width.
  const scroller = <div className="cw-scroll" tabIndex={0} role="region" aria-label="The worksheet form; scrolls sideways on a narrow screen">{form}</div>;
  if (variant === 'screen') {
    return (
      <article className="report-doc cw report-screen" aria-label="Counseling worksheet">
        <p className="report-marking">{doc.marking}</p>
        {scroller}
        <p className="report-marking report-marking-foot">{doc.marking}</p>
        {about}
      </article>
    );
  }
  // On paper, the handling line heads and foots every page, as the PDF's does: a table's header and footer repeat on each
  // printed page it reaches (the report print frame, ADR-0020). It lays the page out and holds no data.
  return (
    <article className="report-doc cw report-print" aria-label="Counseling worksheet">
      <table className="report-frame" role="presentation">
        <thead><tr><td><p className="report-running"><span>{doc.marking}</span>{band && <span>{band}</span>}</p></td></tr></thead>
        <tfoot><tr><td><p className="report-running report-running-foot"><span>{doc.marking}</span><span>{foot}</span></p></td></tr></tfoot>
        <tbody><tr><td>{scroller}{about}</td></tr></tbody>
      </table>
    </article>
  );
}

/** The worksheet of one counseling as a preview inside its dialog, read from the server when it is shown. */
export function CounselingPreview({ row }: { row: Counseling }) {
  const { data, error, isPending } = useWorksheet(row.id, row.version);
  const [adding, setAdding] = useState(false);
  if (isPending) return <div aria-busy="true"><Skeleton className="h-64" /></div>;
  if (error || !data) return <EmptyState title="Could not prepare the worksheet" description={api.errorText(error)} />;
  // The reader's own EDIPI box is empty: they type it here, and it saves to their profile (ADR-0033).
  const missing = data.edipi.yours !== null && !data.edipi[data.edipi.yours];
  return (
    <div className="space-y-3">
      {missing && (adding
        ? <div className="rounded-md border border-line bg-surface-2 p-3"><EdipiForm autoFocus onSaved={() => setAdding(false)} /></div>
        : <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">Your EDIPI is not on your profile, so your EDIPI box is blank. <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>Add it</Button></p>)}
      <CounselingWorksheet doc={data} onAddEdipi={missing ? () => setAdding(true) : undefined} />
    </div>
  );
}

/** The worksheet for one version of a counseling: a new version draws a new worksheet. */
function useWorksheet(id: string, version: number) {
  return useQuery({ queryKey: ['counseling-worksheet', id, version], queryFn: () => api.counselingWorksheet(id), staleTime: 30_000 });
}
