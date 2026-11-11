import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { Panel, Button, Field, Input, Select, Badge, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import {
  ATTACHMENT_EXTENSIONS, ATTACHMENT_LIMITS, ATTACHMENT_TYPE_NAMES, EVIDENCE_KINDS, EVIDENCE_KIND_LABELS, formatFileSize, takesEvidenceKind,
  type AttachmentDetails, type AttachmentRow, type AttachmentsResponse, type EvidenceKind,
} from '../../shared/attachments';

const KIND_OPTIONS = EVIDENCE_KINDS.map((k) => ({ value: k, label: EVIDENCE_KIND_LABELS[k] }));
const FILE_INPUT = 'block w-full min-w-0 text-sm text-ink-2 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink';

/** "PDF, JPEG, PNG, TXT or CSV": the file types this service takes, as a sentence reads them. */
function typeList(allowed: string[]): string {
  const names = allowed.map((t) => ATTACHMENT_TYPE_NAMES[t]).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] || '';
}
/** What a file chooser offers: each allowed type and its extensions, since a browser does not always know a CSV's type. */
const acceptFor = (allowed: string[]) => allowed.flatMap((t) => [t, ...(ATTACHMENT_EXTENSIONS[t] || []).map((e) => `.${e}`)]).join(',');

interface AddDraft { kind: EvidenceKind | ''; description: string; file: File | null }
interface EditDraft { id: string; kind: EvidenceKind | ''; description: string }
type FieldErrors = { kind?: string; description?: string; file?: string };

/**
 * The files on a record. On a training they are its evidence (ADR-0025): each says what it is (a certificate, a
 * transcript, a completion or qualification document, a roster) and, in a line, what it shows, beside its name, its
 * type, who added it and when. Whoever may read the record opens them; whoever may edit it adds, describes and removes
 * them. The server decides all of it again: this only offers what it will accept.
 */
export function Attachments(props: { table: api.Store; id: string; canEdit: boolean }) {
  // One panel per record: a form or a confirmation left open never carries over to the next record shown in its place.
  return <AttachmentsPanel key={`${props.table}:${props.id}`} {...props} />;
}

function AttachmentsPanel({ table, id, canEdit }: { table: api.Store; id: string; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const on = Boolean(identity?.instance.attachmentsEnabled);
  const evidence = takesEvidenceKind(table);
  const me = identity?.user.id;
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const quickInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [removing, setRemoving] = useState<string | null>(null);

  // What is already attached stays readable when attachments are turned off, so the list is read either way.
  const { data: files, error, isPending } = useQuery({ queryKey: ['attachments', table, id], queryFn: () => api.attachments(table, id), enabled: Boolean(id), retry: false });

  const rows = files?.attachments ?? [];
  const allowed = files?.allowedTypes ?? [];
  const maxMb = Math.round((files?.maxBytes || 0) / 1_048_576) || 8;
  // Vantage can withhold attachments from one Unit Instance (ADR-0014): what is attached stays readable, nothing new is added.
  const withheld = on && files?.enabled === false;
  const full = Boolean(files) && rows.length >= (files?.maxPerRecord ?? Infinity);
  const adding = canEdit && on && Boolean(files) && !withheld && !full;
  const noun = evidence ? 'evidence' : 'files';

  /** After the panel changes under the keyboard, put focus where the person will act next. */
  const focusOn = (find: () => HTMLElement | null | undefined) => requestAnimationFrame(() => find()?.focus());
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['attachments', table, id] });
    // The lists that count a training's evidence.
    if (evidence) { void qc.invalidateQueries({ queryKey: ['records', table] }); void qc.invalidateQueries({ queryKey: ['member'] }); }
  };
  const tooLarge = (file: File) => (files && file.size > files.maxBytes ? `Files are limited to ${maxMb} MB.` : null);
  const fromServer = (e: unknown, fallback: keyof FieldErrors): FieldErrors => (e instanceof api.ApiError && e.fieldErrors && Object.keys(e.fieldErrors).length ? e.fieldErrors as FieldErrors : { [fallback]: api.errorText(e) });

  // Any other record type: choose a file and it is attached.
  const quickAdd = async (file: File) => {
    const refused = tooLarge(file);
    if (refused) { toast.error(refused); if (quickInput.current) quickInput.current.value = ''; return; }
    setBusy('add');
    try { await api.uploadAttachment(table, id, file); toast.success(`Attached ${file.name}.`); changed(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(null); if (quickInput.current) quickInput.current.value = ''; }
  };

  // A training's evidence says what it is before it is kept.
  const openForm = () => { setDraft({ kind: '', description: '', file: null }); setErrors({}); focusOn(() => root.current?.querySelector<HTMLElement>('[data-add-form] button, [data-add-form] input')); };
  const closeForm = () => { setDraft(null); setErrors({}); focusOn(() => addButton.current); };
  const submit = async () => {
    if (!draft) return;
    const found: FieldErrors = {};
    if (!draft.kind) found.kind = 'Choose what this file is.';
    if (!draft.file) found.file = 'Choose a file.';
    else { const refused = tooLarge(draft.file); if (refused) found.file = refused; }
    setErrors(found);
    if (Object.keys(found).length || !draft.file || !draft.kind) return;
    setBusy('add');
    try {
      await api.uploadAttachment(table, id, draft.file, { kind: draft.kind, description: draft.description.trim() || null });
      toast.success(`Attached ${draft.file.name}.`);
      changed();
      closeForm();
    } catch (e) { setErrors(fromServer(e, 'file')); }
    finally { setBusy(null); }
  };

  const startEdit = (f: AttachmentRow) => { setRemoving(null); setEditErrors({}); setEditing({ id: f.id, kind: f.kind ?? '', description: f.description ?? '' }); focusOn(() => root.current?.querySelector<HTMLElement>('[data-edit-form] button, [data-edit-form] input')); };
  const closeEdit = (fileId: string) => { setEditing(null); setEditErrors({}); focusOn(() => root.current?.querySelector<HTMLElement>(`[data-edit="${CSS.escape(fileId)}"]`)); };
  const saveEdit = async () => {
    if (!editing) return;
    // A type is sent only once one is chosen: a file that arrived without one keeps its description correctable.
    const details: AttachmentDetails = { description: editing.description.trim() || null, ...(evidence && editing.kind ? { kind: editing.kind } : {}) };
    setBusy(editing.id);
    try {
      const saved = await api.updateAttachment(table, id, editing.id, details);
      // What was saved shows at once, not when the list has been read again.
      qc.setQueryData<AttachmentsResponse>(['attachments', table, id], (d) => (d ? { ...d, attachments: d.attachments.map((a) => (a.id === saved.id ? { ...a, ...saved } : a)) } : d));
      toast.success('Details saved.'); changed(); closeEdit(editing.id);
    } catch (e) { setEditErrors(fromServer(e, 'description')); }
    finally { setBusy(null); }
  };

  // Removing asks first. Keep takes the place Remove had and takes focus, so a second click or a stray Enter keeps the file.
  const askRemove = (fileId: string) => { setEditing(null); setRemoving(fileId); focusOn(() => root.current?.querySelector<HTMLElement>('[data-keep]')); };
  const keep = (fileId: string) => { setRemoving(null); focusOn(() => root.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(fileId)}"]`)); };
  const remove = async (f: AttachmentRow) => {
    setBusy(f.id);
    try {
      await api.deleteAttachment(table, id, f.id);
      toast.success(`Removed ${f.original_name}.`);
      setRemoving(null);
      qc.setQueryData<AttachmentsResponse>(['attachments', table, id], (d) => (d ? { ...d, attachments: d.attachments.filter((a) => a.id !== f.id) } : d));
      changed();
      focusOn(() => addButton.current);
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(null); }
  };

  const subtitle = withheld ? 'turned off for this Unit Instance' : !on ? 'turned off on Vantage'
    : evidence ? 'Certificates, transcripts, completion and qualification documents, and rosters' : 'Kept in Vantage, never sent anywhere else';
  const empty = !on ? (evidence ? 'No evidence on file. Attachments are turned off on Vantage.' : 'Use evidence links instead.')
    : withheld ? `No ${noun}. Vantage has turned attachments off for this Unit Instance${evidence ? '.' : '; use evidence links instead.'}`
      : evidence ? (canEdit ? `No evidence yet. Add the certificate, the transcript, the completion or qualification document, or the roster. ${typeList(allowed)}, up to ${maxMb} MB each.` : 'No evidence on file.')
        : `No files yet. Attach the sheet, the signed copy, or the screenshot. Up to ${maxMb} MB each.`;

  return (
    <Panel
      title={evidence ? 'Evidence' : 'Files'}
      subtitle={subtitle}
      action={adding && !draft
        ? evidence
          ? <Button ref={addButton} size="sm" onClick={openForm}><Paperclip className="h-3.5 w-3.5" />Add evidence</Button>
          : <Button ref={addButton} size="sm" loading={busy === 'add'} onClick={() => quickInput.current?.click()}><Paperclip className="h-3.5 w-3.5" />Add</Button>
        : undefined}
    >
      <div ref={root}>
        {!evidence && <input ref={quickInput} type="file" className="sr-only" aria-hidden="true" tabIndex={-1} accept={acceptFor(allowed) || undefined}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void quickAdd(f); }} />}

        {draft && (
          <div data-add-form role="group" aria-label="Add evidence" className="mb-4 rounded-md border border-line bg-surface-2 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="What it is" required error={errors.kind}>
                <Select value={draft.kind} onValueChange={(v) => { setDraft({ ...draft, kind: v as EvidenceKind }); setErrors({ ...errors, kind: undefined }); }} options={KIND_OPTIONS} placeholder="Choose a type" />
              </Field>
              <Field label="File" required hint={`${typeList(allowed)}, up to ${maxMb} MB`} error={errors.file}>
                <input type="file" className={FILE_INPUT} accept={acceptFor(allowed) || undefined}
                  onChange={(e) => { setDraft({ ...draft, file: e.target.files?.[0] ?? null }); setErrors({ ...errors, file: undefined }); }} />
              </Field>
              <Field label="Description" hint="optional: what it shows, in a line" error={errors.description} className="sm:col-span-2">
                <Input value={draft.description} maxLength={ATTACHMENT_LIMITS.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} placeholder="Signed by the course director, class 3-26" />
              </Field>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeForm}>Cancel</Button>
              <Button variant="primary" loading={busy === 'add'} onClick={() => void submit()}>Attach</Button>
            </div>
          </div>
        )}

        {error ? <p className="text-sm text-ink-3" role="alert">{api.errorText(error)}</p>
          : isPending ? <Skeleton className="h-10" />
            : !rows.length ? (draft ? null : <p className="text-sm text-ink-3">{empty}</p>)
              : (
                <ul className="divide-y divide-line">
                  {rows.map((f) => {
                    const mine = f.uploaded_by === me;
                    const facts = [ATTACHMENT_TYPE_NAMES[f.mime_type] || f.mime_type, formatFileSize(f.size_bytes), `added${mine ? ' by you' : f.uploader_name ? ` by ${f.uploader_name}` : ''} ${formatStamp(f.created_at)}`];
                    const confirming = removing === f.id;
                    return (
                      <li key={f.id} className="py-2.5 first:pt-0 last:pb-0">
                        {editing?.id === f.id ? (
                          <div data-edit-form role="group" aria-label={`Details of ${f.original_name}`} className="rounded-md border border-line bg-surface-2 p-3">
                            <p className="mb-2 truncate text-sm font-medium text-ink">{f.original_name}</p>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              {evidence && <Field label="What it is" error={editErrors.kind}>
                                <Select value={editing.kind} onValueChange={(v) => setEditing({ ...editing, kind: v as EvidenceKind })} options={KIND_OPTIONS} placeholder="Choose a type" />
                              </Field>}
                              <Field label="Description" hint="optional: what it shows, in a line" error={editErrors.description} className={evidence ? undefined : 'sm:col-span-2'}>
                                <Input value={editing.description} maxLength={ATTACHMENT_LIMITS.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveEdit(); } }} />
                              </Field>
                            </div>
                            <div className="mt-3 flex justify-end gap-2">
                              <Button size="sm" variant="ghost" onClick={() => closeEdit(f.id)}>Cancel</Button>
                              <Button size="sm" variant="primary" loading={busy === f.id} onClick={() => void saveEdit()}>Save details</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                            <div className="min-w-0 flex-1 basis-56">
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                {evidence && (f.kind ? <Badge tone="accent">{EVIDENCE_KIND_LABELS[f.kind]}</Badge> : <Badge tone="warn">Type not set</Badge>)}
                                <a href={api.attachmentUrl(table, id, f.id)} className="link min-w-0 text-sm [overflow-wrap:anywhere]">{f.original_name}</a>
                              </div>
                              {f.description && <p className="mt-1 text-sm text-ink-2 [overflow-wrap:anywhere]">{f.description}</p>}
                              <p className="mt-1 text-2xs text-ink-3">{facts.filter(Boolean).join(' · ')}</p>
                            </div>
                            {canEdit && (confirming ? (
                              <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`Remove ${f.original_name}?`}>
                                <span className="text-xs text-ink-2">Remove this file?</span>
                                <Button size="xs" variant="danger" loading={busy === f.id} aria-label={`Yes, remove ${f.original_name}`} onClick={() => void remove(f)}>Yes, remove</Button>
                                <Button size="xs" variant="ghost" data-keep aria-label={`Keep ${f.original_name}`} onClick={() => keep(f.id)}>Keep</Button>
                              </div>
                            ) : (
                              <div className="flex shrink-0 items-center gap-1">
                                <Button size="xs" variant="ghost" data-edit={f.id} aria-label={`Edit details of ${f.original_name}`} onClick={() => startEdit(f)}>Edit details</Button>
                                <Button size="xs" variant="ghost" data-remove={f.id} aria-label={`Remove ${f.original_name}`} onClick={() => askRemove(f.id)}>Remove</Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

        {canEdit && on && !withheld && full && <p className="mt-3 text-2xs text-ink-3">This record holds the most files it can ({files?.maxPerRecord}). Remove one to add another.</p>}
        {rows.length > 0 && !on && <p className="mt-3 text-2xs text-ink-3">Attachments are turned off on Vantage. What is here stays readable.</p>}
        {rows.length > 0 && withheld && <p className="mt-3 text-2xs text-ink-3">Vantage has turned attachments off for this Unit Instance. What is here stays readable.</p>}
      </div>
    </Panel>
  );
}
