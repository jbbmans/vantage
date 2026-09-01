import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Trash2, Save, Copy, Plus, X, ExternalLink, Paperclip, Download, Upload } from 'lucide-react';
import { useActivities, useProjects, useIdentity, updateRecord, deleteRecord, restoreDeleted, refreshAll } from '@/store/useStore';
import {
  activityAttachments, activityAttachmentUrl, deleteActivityAttachment, errorText, uploadActivityAttachment,
  trackExperience,
} from '@/lib/api';
import { CATEGORIES, CATEGORY_COLORS, JEPES_AREAS, DOLLAR_TYPES, DOLLAR_TYPE_DEFINITIONS, UNIT_SUGGESTIONS, ACTIVITY_STATUS } from '@/lib/constants';
import { composeBullet, strength, weaknesses } from '@/lib/bullets';
import { formatDollarsExact, formatDTG } from '@/lib/metrics';
import { copyToClipboard } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import {
  Panel, Button, Input, NumberInput, Textarea, Select, Field, Badge, Dot, EmptyState,
} from '@/components/ui/primitives';
import VisibilityPicker, { DEFAULT_VISIBILITY } from '@/components/VisibilityPicker';
import { areaOptions, mapAreaToTrack, trackMeta } from '@/lib/evaluation';
import { useEvalTrack } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { draftKey as userDraftKey } from '@/lib/drafts';

export default function ActivityDetail() {
  const track = useEvalTrack();
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const activities = useActivities();
  const projects = useProjects();
  const identity = useIdentity();

  const original = useMemo(() => activities.find((a) => a.id === id), [activities, id]);
  const [draft, setDraft] = useState(null);

  const draftKey = userDraftKey(identity?.user?.id, 'activity', id);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const [conflict, setConflict] = useState(null);

  const [fieldErrors, setFieldErrors] = useState({});
  const [attachments, setAttachments] = useState([]);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);

  const loadAttachments = async () => {
    try {
      const result = await activityAttachments(id);
      setAttachments(result.attachments || []);
      setAttachmentsEnabled(Boolean(result.enabled));
    } catch {
      setAttachments([]);
    }
  };

  useEffect(() => { loadAttachments(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!original) return;
    const clean = { ...original, evidence_links: original.evidence_links || [], people: original.people || [] };
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch {}
    if (stored && stored.version === original.version
        && JSON.stringify(stored.draft) !== JSON.stringify(clean)) {
      setDraft({ ...clean, ...stored.draft });
      setRestoredDraft(true);
    } else {
      if (stored && stored.version !== original.version) {
        try { sessionStorage.removeItem(draftKey); } catch {}
      }
      setDraft(clean);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);

  useEffect(() => {
    if (!draft || !original) return;
    const clean = { ...original, evidence_links: original.evidence_links || [], people: original.people || [] };
    try {
      if (JSON.stringify(draft) === JSON.stringify(clean)) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ version: original.version, draft }));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (!activities.length) return null;

  if (!original) {
    return (
      <div className="mx-auto max-w-2xl">
        <Panel>
          <EmptyState
            title="That entry no longer exists"
            description="It may have been deleted, or the link is stale."
            action={<Button size="sm" onClick={() => navigate('/activities')}>Back to the log</Button>}
          />
        </Panel>
      </div>
    );
  }

  if (!draft) return null;

  const discardDraft = () => {
    try { sessionStorage.removeItem(draftKey); } catch {}
    setDraft({ ...original, evidence_links: original.evidence_links || [], people: original.people || [] });
    setRestoredDraft(false);
  };

  const set = (key) => (value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setFieldErrors((f) => {
      if (!f[key]) return f;
      const next = { ...f };
      delete next[key];
      return next;
    });
  };
  const setEvent = (key) => (e) => set(key)(e.target.value);
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...original, evidence_links: original.evidence_links || [], people: original.people || [] });

  const save = async (versionOverride) => {
    const version = Number.isInteger(versionOverride) ? versionOverride : draft.version;
    setSaving(true);
    try {
      await updateRecord('activities', id, {
        ...draft,
        version,
        quantity: draft.quantity === '' || draft.quantity == null ? null : Number(draft.quantity),
        dollar_amount:
          draft.dollar_amount === '' || draft.dollar_amount == null
            ? null
            : Number(String(draft.dollar_amount).replace(/[$,]/g, '')),
      });
      setConflict(null);
      setFieldErrors({});
      setRestoredDraft(false);
      try { sessionStorage.removeItem(draftKey); } catch {}
      toast.success('Entry saved.');
    } catch (err) {
      if (err.status === 409 && err.code === 'stale' && err.current) {
        setConflict(err.current);
      } else {
        setFieldErrors(err.fieldErrors || {});
        toast.error(errorText(err) || 'Could not save.');
      }
    } finally {
      setSaving(false);
    }
  };

  const loadNewest = async () => {
    setConflict(null);
    try { sessionStorage.removeItem(draftKey); } catch {}
    await refreshAll();
    toast.success('Loaded the newest copy. Your unsaved edits were set aside.');
  };

  const destroy = async () => {
    const undo = await deleteRecord('activities', id);

    toast.success('Entry deleted.', {
      label: 'Undo',
      run: async () => {
        try {
          await restoreDeleted(undo);
          toast.success('Entry restored.');
        } catch (err) {
          toast.error(err.message);
        }
      },
    });
    navigate('/activities');
  };

  const copyBullet = async () => {
    const ok = await copyToClipboard(composeBullet(draft));
    ok ? toast.success('Bullet copied.') : toast.error('Could not reach the clipboard.');
  };

  const addLink = () => set('evidence_links')([...(draft.evidence_links || []), { label: '', url: '' }]);
  const updateLink = (i, patch) =>
    set('evidence_links')(draft.evidence_links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLink = (i) => set('evidence_links')(draft.evidence_links.filter((_, idx) => idx !== i));

  const uploadFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      await uploadActivityAttachment(id, file);
      await loadAttachments();
      trackExperience('attachment_uploaded');
      toast.success('Supporting file attached.');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeAttachment = async (attachmentId) => {
    try {
      await deleteActivityAttachment(id, attachmentId);
      await loadAttachments();
      toast.success('Attachment removed from the active record.');
    } catch (err) { toast.error(errorText(err)); }
  };

  const formatBytes = (bytes) => bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  const s = strength(draft);
  const gaps = weaknesses(draft);

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      {restoredDraft && (
        <div className="mb-3 flex items-center gap-2.5 rounded border border-signal/40 bg-signal/[0.08] px-3 py-2">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-2">
            Unsaved edits from this device were restored — they were never saved to the server. Save them, or discard
            to go back to the server copy.
          </p>
          <Button variant="ghost" size="sm" onClick={discardDraft}>Discard draft</Button>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <Link to="/activities" className="flex items-center gap-1.5 text-xs text-text-3 hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" />
          Activity log
        </Link>
        <div className="flex items-center gap-1.5">
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </div>

      <Panel
        title="Bullet"
        subtitle="What this entry becomes on a board package"
        action={
          <Button variant="ghost" size="sm" onClick={copyBullet}>
            <Copy className="h-3 w-3" />
            Copy
          </Button>
        }
      >
        <p className="flex items-start gap-2 text-md leading-relaxed text-text">
          <Dot color={CATEGORY_COLORS[draft.category]} className="mt-2" />
          <span>{composeBullet(draft)}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-rule pt-2.5">
          <span className="flex items-center gap-1">
            <span className="eyebrow mr-1">Strength</span>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={cn('h-1 w-5 rounded-sm', i < s ? 'bg-signal' : 'bg-rule')} />
            ))}
            <span className="fig ml-1 text-2xs text-text-3">{s}/4</span>
          </span>
          {gaps.length > 0 && <span className="text-xs text-text-3">Missing: {gaps.join(' · ')}</span>}
        </div>
      </Panel>

      <Panel title="Record">
        <div className="space-y-3">
          <Field error={fieldErrors.title} label="Title">
            <Input value={draft.title || ''} onChange={setEvent('title')} className="text-md" />
          </Field>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field error={fieldErrors.date} label="Date">
              <Input type="date" value={draft.date || ''} onChange={setEvent('date')} />
            </Field>
            <Field error={fieldErrors.status} label="Status">
              <Select value={draft.status || 'completed'} onValueChange={set('status')} options={ACTIVITY_STATUS} />
            </Field>
            <Field error={fieldErrors.category} label="Category" className="col-span-2">
              <Select value={draft.category} onValueChange={set('category')} options={CATEGORIES} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field error={fieldErrors.quantity} label="Action amount" hint="how many items or actions you completed">
              <NumberInput value={draft.quantity ?? ''} onChange={setEvent('quantity')} placeholder="—" />
            </Field>
            <Field label="Action unit">
              <Input list="units" value={draft.unit || ''} onChange={setEvent('unit')} placeholder="ULOs" />
              <datalist id="units">
                {UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
              </datalist>
            </Field>
            <Field error={fieldErrors.dollar_amount} label="Transaction value" hint="financial value tied to this action">
              <NumberInput value={draft.dollar_amount ?? ''} onChange={setEvent('dollar_amount')} placeholder="—" />
            </Field>
            <Field error={fieldErrors.dollar_type} label="Dollar type" hint="how Vantage classifies the transaction value">
              <Select
                value={draft.dollar_type || 'impact'}
                onValueChange={set('dollar_type')}
                options={DOLLAR_TYPES.map((d) => ({ value: d.key, label: d.label }))}
              />
            </Field>
          </div>

          {draft.dollar_type && (
            <p className="-mt-1 text-xs leading-relaxed text-text-3">
              {DOLLAR_TYPE_DEFINITIONS[draft.dollar_type]}
              {draft.dollar_amount ? (
                <span className="fig ml-1 text-text-2">
                  Stored as {formatDollarsExact(Number(String(draft.dollar_amount).replace(/[$,]/g, '')) || 0)}.
                </span>
              ) : null}
            </p>
          )}

          <Field error={fieldErrors.result} label="Result" hint="the outcome — what changed because you did this">
            <Input value={draft.result || ''} onChange={setEvent('result')} placeholder="cleared the section's aged ULO backlog" />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field error={fieldErrors.jepes_area} label={trackMeta(track).areaLabel}>
              <Select
                value={mapAreaToTrack(draft.jepes_area, track) || 'Unassigned'}
                onValueChange={set('jepes_area')}
                options={areaOptions(track)}
              />
            </Field>
            <Field error={fieldErrors.organization} label="Organization">
              <Input value={draft.organization || ''} onChange={setEvent('organization')} placeholder="G-8" />
            </Field>
            <Field error={fieldErrors.system} label="System">
              <Input value={draft.system || ''} onChange={setEvent('system')} placeholder="DAI" />
            </Field>
          </div>

          <Field label="Project">
            <Select
              value={draft.project_id || ''}
              onValueChange={(v) => set('project_id')(v || null)}
              placeholder="Not linked to a project"
              options={[{ value: '', label: 'Not linked' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>

          <Field error={fieldErrors.notes} label="Notes">
            <Textarea rows={3} value={draft.notes || ''} onChange={setEvent('notes')} />
          </Field>

          <VisibilityPicker value={draft.visibility || DEFAULT_VISIBILITY} onChange={set('visibility')} unitId={draft.unit_id} />
        </div>
      </Panel>

      <Panel
        title="Supporting material"
        subtitle="Optional references or files — never required to log useful work"
        action={
          <Button variant="ghost" size="sm" onClick={addLink}>
            <Plus className="h-3 w-3" />
            Add reference
          </Button>
        }
      >
        {draft.evidence_links?.length > 0 && (
          <div className="space-y-2">
            {draft.evidence_links.map((link, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={link.label || ''}
                  onChange={(e) => updateLink(i, { label: e.target.value })}
                  placeholder="Label"
                  className="w-40 shrink-0"
                />
                <Input
                  value={link.url || ''}
                  onChange={(e) => updateLink(i, { url: e.target.value })}
                  placeholder="https:// or file path"
                  className="min-w-0 flex-1"
                />
                {link.url?.startsWith('http') && (
                  <a href={link.url} target="_blank" rel="noreferrer" aria-label={`Open ${link.label || 'reference'}`} className="text-text-3 hover:text-signal">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button type="button" aria-label={`Remove ${link.label || `reference ${i + 1}`}`} onClick={() => removeLink(i)} className="text-text-3 hover:text-redline">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={cn('flex flex-wrap items-center gap-2', draft.evidence_links?.length ? 'mt-4 border-t border-rule pt-4' : '')}>
          {attachmentsEnabled && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.txt,.csv"
                className="hidden"
                onChange={(event) => uploadFile(event.target.files?.[0])}
              />
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                <Upload className="h-3.5 w-3.5" /> {uploading ? 'Attaching…' : 'Attach file'}
              </Button>
            </>
          )}
          <p className="text-xs leading-relaxed text-text-3">
            {attachmentsEnabled
              ? 'PDF, PNG, JPEG, TXT, or CSV · 10 MB maximum · stored inside the encrypted-at-rest deployment database when the host provides disk encryption.'
              : 'File attachments are disabled by the deployment operator.'}
          </p>
        </div>

        {attachments.length > 0 && (
          <div className="mt-3 divide-y divide-rule overflow-hidden rounded-lg border border-rule">
            {attachments.map((file) => (
              <div key={file.id} className="flex items-center gap-3 bg-panel px-3 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-panel-2 text-signal">
                  <Paperclip className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{file.original_name}</p>
                  <p className="fig text-2xs text-text-3">{formatBytes(file.size_bytes)} · {file.mime_type}</p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <a href={activityAttachmentUrl(id, file.id)} download>
                    <Download className="h-3.5 w-3.5" /> <span className="sr-only">Download {file.original_name}</span>
                  </a>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => removeAttachment(file.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> <span className="sr-only">Remove {file.original_name}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="fig flex flex-wrap gap-x-4 gap-y-1 px-1 text-2xs text-text-3">
        <span>Created {formatDTG(original.created_at)}</span>
        <span>Updated {formatDTG(original.updated_at)}</span>
        <span className="truncate">ID {original.id}</span>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this entry?"
        body="The record and its figures come out of every rollup. You can undo this straight afterwards."
        onConfirm={destroy}
      />

      {conflict && (
        <Dialog
          open
          onOpenChange={(v) => !v && setConflict(null)}
          title="This entry changed while you were editing"
          description="Someone saved a newer copy after you opened this page. Nothing was overwritten."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={loadNewest}>Load the newest copy</Button>
              <Button size="sm" disabled={saving} onClick={() => save(conflict.version)}>Overwrite with mine</Button>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-text-2">
            Newest copy: <span className="text-text">&ldquo;{conflict.title}&rdquo;</span>
            <span className="fig ml-1.5 text-2xs text-text-3">version {conflict.version}</span>
          </p>
        </Dialog>
      )}
    </div>
  );
}
