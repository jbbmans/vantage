import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, FilePen, Lock, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, useReturnFocus } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { useParam } from '@/components/common';
import * as api from '@/lib/api';
import { invalidateDomains, keys, useDrafts, useFormDraft } from '@/lib/queries';
import { cn, timeAgo } from '@/lib/utils';
import { formatDate } from '../../shared/metrics';
import { DRAFT_WARN_DAYS, type DraftItem, type FormDraft, type FormDraftKind } from '../../shared/drafts';

/**
 * Drafts in context (ADR-0030): a page with a form people may save to finish later lists its own drafts above its list,
 * and opens one from `?draft=<id>`, which is where the Drafts page and Today send them.
 */

/** How long a saved form is kept, in words, and whether that is soon. */
export function keptWords(iso: string | null | undefined): { text: string; soon: boolean } | null {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days <= DRAFT_WARN_DAYS
    ? { text: `Removed ${formatDate(iso)} unless you save it again`, soon: true }
    : { text: `Kept until ${formatDate(iso)}`, soon: false };
}

/** "Saved 3 hours ago · Kept until 12 Feb 27", with the removal date in words, not colour alone, when it is near. */
export function DraftMeta({ d, className }: { d: Pick<DraftItem, 'updated_at' | 'kept_until' | 'blocked'>; className?: string }) {
  const kept = keptWords(d.kept_until);
  return (
    <span className={cn('block text-xs text-ink-3', className)}>
      Saved {timeAgo(d.updated_at)}
      {kept && <> · <span className={cn(kept.soon && 'font-medium text-warn')}>{kept.soon && <AlertTriangle className="-mt-0.5 mr-0.5 inline h-3 w-3" aria-hidden />}{kept.text}</span></>}
      {d.blocked && <span className="mt-0.5 block text-warn">{d.blocked}</span>}
    </span>
  );
}

/**
 * The saved form named in the address, once it is read, if it is this page's kind (and about this Marine, where it is
 * about one): `open` is called with it once. `done` forgets it and takes it out of the address.
 */
export function useResumeDraft(kind: FormDraftKind, open: (d: FormDraft, done: () => void) => void, opts: { subjectId?: string | null; enabled?: boolean; quiet?: boolean } = {}) {
  const [id, setId] = useParam('draft');
  const toast = useToast();
  const query = useFormDraft(opts.enabled === false ? null : id || null);
  const [saved, setSaved] = useState<FormDraft | null>(null);
  const opened = useRef<string | null>(null);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  const subject = opts.subjectId ?? null;
  const done = useCallback(() => { opened.current = null; setSaved(null); if (id) setId(''); }, [id, setId]);
  useEffect(() => {
    const d = query.data;
    if (!d || d.id !== id || opened.current === d.id) return;
    if (d.kind !== kind || (d.subject_id ?? null) !== subject) return;
    opened.current = d.id;
    setSaved(d);
    openRef.current(d, done);
  }, [query.data, id, kind, subject, done]);
  const quiet = Boolean(opts.quiet);
  const warned = useRef<unknown>(null);
  useEffect(() => {
    // Said once for each failed read, however often the address changes after it.
    if (!query.error || !id || warned.current === query.error) return;
    warned.current = query.error;
    // Only a draft that is gone is let go of. Offline, or a server error, the link stays, to be tried again.
    if (lostFrom(query.error)?.why !== 'gone') { if (!quiet) toast.error(api.errorText(query.error)); return; }
    // Where two kinds open on one page, one of them says it.
    if (quiet) return;
    // Someone else's draft reads the same as one that is gone, so this says nothing about whose it was.
    toast.info('That draft is no longer here. It was sent or discarded.');
    setId('');
  }, [query.error, id, setId, toast, quiet]);
  const { data, refetch } = query;
  return {
    saved,
    /** Forget the draft that was open, and take it out of the address. */
    done,
    /** Open one of this page's drafts; the one already named is read again (its last read may have failed). */
    open: (draftId: string) => {
      if (draftId !== id) { opened.current = null; setId(draftId); return; }
      const d = data;
      if (d && d.id === draftId && d.kind === kind && (d.subject_id ?? null) === subject) { opened.current = d.id; setSaved(d); openRef.current(d, done); return; }
      opened.current = null;
      void refetch();
    },
  };
}

/** Saved forms of a kind: those this page opens (about this Marine, or about nobody), or every one, newest first. */
export function useDraftsOf(kind: FormDraftKind, subjectId: string | null = null, everyone = false) {
  const { data } = useDrafts();
  return (data?.items || []).filter((d) => d.source === 'form' && d.kind === kind && (everyone || (subjectId ? d.subject_id === subjectId : !d.subject_id)));
}

const SHOWN = 3;

/**
 * "Your drafts" on a page: its saved forms of this kind, newest first, the first three and a way to all of them. A draft
 * this page opens is continued here; one about a Marine opens on their page. Nothing when there are none. Only their
 * author ever sees them.
 */
export function DraftStrip({ kind, subjectId = null, everyone = false, onContinue, className }: {
  kind: FormDraftKind; subjectId?: string | null; everyone?: boolean; onContinue: (id: string) => void; className?: string;
}) {
  const mine = useDraftsOf(kind, subjectId, everyone);
  const qc = useQueryClient();
  const toast = useToast();
  const [discarding, setDiscarding] = useState<DraftItem | null>(null);
  if (!mine.length) return null;
  const here = (d: DraftItem) => (subjectId ? d.subject_id === subjectId : !d.subject_id);
  const discard = async () => {
    if (!discarding) return;
    try { await api.discardFormDraft(discarding.id); toast.success('Draft discarded.'); }
    catch (e) { if (lostFrom(e)?.why !== 'gone') { toast.error(api.errorText(e)); return; } }
    invalidateDomains(qc, 'draft');
    qc.removeQueries({ queryKey: keys.formDraft(discarding.id) });
  };
  return (
    <section className={className ?? 'card mb-4 overflow-hidden border border-dashed border-line-strong p-0'} aria-labelledby={`drafts-${kind}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <h2 id={`drafts-${kind}`} className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Lock className="h-3.5 w-3.5 text-ink-3" aria-hidden />Your drafts <span className="fig font-normal text-ink-3">({mine.length})</span></h2>
        <span className="text-xs text-ink-3">Only you can see these until you add them.</span>
      </div>
      <ul className="divide-y divide-line">
        {mine.slice(0, SHOWN).map((d) => (
          <li key={d.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">{d.title}{d.about && <span className="font-normal text-ink-3"> · for {d.about}</span>}</span>
              <DraftMeta d={d} />
            </span>
            <span className="flex shrink-0 gap-1.5">
              {/* One its author may no longer send is read in Drafts, which needs no access to its Marine. */}
              {!d.can_submit
                ? <Button size="sm" asChild><Link to={`/record/drafts?read=${d.id}`} aria-label={`Read ${d.title} in Drafts`}><FilePen className="h-3.5 w-3.5" aria-hidden />Read</Link></Button>
                : here(d)
                  ? <Button size="sm" onClick={() => onContinue(d.id)} aria-label={`Continue ${d.title}`}><FilePen className="h-3.5 w-3.5" aria-hidden />Continue</Button>
                  : <Button size="sm" asChild><Link to={d.href} aria-label={`Continue ${d.title} on their page`}><FilePen className="h-3.5 w-3.5" aria-hidden />Continue</Link></Button>}
              <Button size="sm" variant="ghost" onClick={() => setDiscarding(d)} aria-label={`Discard ${d.title}`}><Trash2 className="h-3.5 w-3.5" aria-hidden />Discard</Button>
            </span>
          </li>
        ))}
      </ul>
      {mine.length > SHOWN && <Link to="/record/drafts" className="flex items-center gap-1 border-t border-line px-4 py-2 text-xs font-medium text-accent hover:underline">All {mine.length} in Drafts<ArrowRight className="h-3 w-3" aria-hidden /></Link>}
      <ConfirmDialog open={Boolean(discarding)} onOpenChange={(o) => { if (!o) setDiscarding(null); }} title="Discard this draft?" confirmLabel="Discard"
        body={discarding ? `“${discarding.title}” is removed and cannot be brought back. Nothing was sent, so nobody else is affected.` : ''} onConfirm={discard} />
    </section>
  );
}

/** Why a submit or save against a saved draft was refused, when it is because the draft is not as the form read it. */
export type Lost = { why: 'gone' } | { why: 'changed'; current: FormDraft | null };
export function lostFrom(err: unknown): Lost | null {
  if (!(err instanceof api.ApiError)) return null;
  if (err.code === 'draft_gone') return { why: 'gone' };
  if (err.code === 'draft_changed' || err.code === 'stale') return { why: 'changed', current: (err.extra.current as FormDraft | undefined) ?? null };
  return null;
}

/** Above a form opened from a saved draft: it is the author's alone, and, if they may no longer send it, why. */
export function ResumedNote({ blocked }: { blocked?: string | null }) {
  return blocked
    ? <p role="note" className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2 text-xs text-ink-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden /><span>{blocked} You can read it and discard it.</span></p>
    : <p className="mb-3 flex items-start gap-2 rounded-md border border-dashed border-line-strong bg-surface-2 px-3 py-2 text-xs text-ink-2"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />Draft · only you. Opened from your drafts.</p>;
}

/** The saved draft is not as this form read it. What was typed stays; the person chooses what becomes of it. */
export function LostDraft({ lost, busy, addLabel, onAddNew, onSaveNew, onLoadNewer, onKeepMine }: {
  lost: Lost; busy: boolean; addLabel: string; onAddNew: () => void; onSaveNew: () => void; onLoadNewer: (d: FormDraft) => void; onKeepMine: (d: FormDraft | null) => void;
}) {
  return (
    <div role="alert" className="mb-3 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2.5 text-sm text-ink-2">
      <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        {lost.why === 'gone'
          ? 'This draft was already sent or discarded, perhaps in another window. What you typed here is still here.'
          : 'This draft was saved again in another window since you opened it.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {lost.why === 'gone' ? <>
          <Button size="sm" onClick={onAddNew} disabled={busy}>{addLabel}</Button>
          <Button size="sm" variant="ghost" onClick={onSaveNew} disabled={busy}>Save it as a new draft</Button>
        </> : <>
          {lost.current && <Button size="sm" onClick={() => onLoadNewer(lost.current!)} disabled={busy}>Load the newer version</Button>}
          <Button size="sm" variant="ghost" onClick={() => onKeepMine(lost.current)} disabled={busy}>Keep mine</Button>
        </>}
      </div>
    </div>
  );
}

/**
 * Closing a form with changes nobody saved asks first: keep editing, let them go, or save them as a draft. A draft its
 * author may no longer send cannot be saved again, so it is not offered. Keep editing goes back to where they were typing.
 */
export function LeaveDialog({ open, resumed, noun, saving, canSave = true, onStay, onLeave, onSave }: { open: boolean; resumed: boolean; noun: string; saving: boolean; canSave?: boolean; onStay: () => void; onLeave: () => void; onSave: () => void }) {
  useReturnFocus(open);
  // While its save is on its way, nothing else is chosen: the form closes when it is saved.
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onStay(); }} title="Keep what you wrote?" size="sm" footer={<>
      <Button variant="ghost" onClick={onStay} disabled={saving}>Keep editing</Button>
      <Button variant="danger" onClick={onLeave} disabled={saving}>Discard changes</Button>
      {canSave && <Button variant="primary" onClick={onSave} loading={saving}>Save draft</Button>}
    </>}>
      <p className="text-sm leading-relaxed text-ink-2">
        {resumed ? 'Your changes since you last saved this draft are not saved.' : `This ${noun} is not saved anywhere yet.`}
        {canSave ? ' Save it as a draft to finish later. Only you can see it.' : ' This draft can no longer be saved again, so they will be lost.'}
      </p>
    </Dialog>
  );
}
