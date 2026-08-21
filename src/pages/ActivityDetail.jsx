import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Trash2, Save, Copy, Plus, X, ExternalLink } from 'lucide-react';
import { useActivities, useProjects, updateRecord, deleteRecord, restoreDeleted, refreshAll } from '@/store/useStore';
import { errorText } from '@/lib/api';
import { CATEGORIES, CATEGORY_COLORS, JEPES_AREAS, DOLLAR_TYPES, DOLLAR_TYPE_DEFINITIONS, UNIT_SUGGESTIONS, ACTIVITY_STATUS } from '@/lib/constants';
import { composeBullet, strength, weaknesses } from '@/lib/bullets';
import { formatDollarsExact, formatDTG } from '@/lib/metrics';
import { copyToClipboard } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import {
  Panel, Button, Input, NumberInput, Textarea, Select, Field, Badge, Dot, EmptyState,
} from '@/components/ui/primitives';
import VisibilityPicker from '@/components/VisibilityPicker';
import { areaOptions, mapAreaToTrack, trackMeta } from '@/lib/evaluation';
import { useEvalTrack } from '@/store/useStore';
import { cn } from '@/lib/utils';

export default function ActivityDetail() {
  const track = useEvalTrack();
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const activities = useActivities();
  const projects = useProjects();

  const original = useMemo(() => activities.find((a) => a.id === id), [activities, id]);
  const [draft, setDraft] = useState(null);
  // Finding 35: a failed save must not cost the work. Edits mirror into
  // localStorage keyed by record id + the version they were made against; a
  // fresh mount offers the draft back only when the server copy hasn't moved.
  const draftKey = `vantage.draft.activity.${id}`;
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  // 409 stale (finding 36): the server refused to overwrite a newer copy and
  // sent it along. The dialog gives the real choice — reload or overwrite —
  // instead of pretending the save just failed.
  const [conflict, setConflict] = useState(null);
  // Finding 34: server refusals name their fields; those names land under the
  // exact inputs. Typing in a field clears its own error, nothing else.
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (!original) return;
    const clean = { ...original, evidence_links: original.evidence_links || [], people: original.people || [] };
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch { /* corrupt */ }
    if (stored && stored.version === original.version
        && JSON.stringify(stored.draft) !== JSON.stringify(clean)) {
      setDraft({ ...clean, ...stored.draft });
      setRestoredDraft(true);
    } else {
      if (stored && stored.version !== original.version) {
        try { localStorage.removeItem(draftKey); } catch { /* fine */ }
      }
      setDraft(clean);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);

  // Mirror every unsaved change; drop the mirror the moment draft == server.
  useEffect(() => {
    if (!draft || !original) return;
    const clean = { ...original, evidence_links: original.evidence_links || [], people: original.people || [] };
    try {
      if (JSON.stringify(draft) === JSON.stringify(clean)) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify({ version: original.version, draft }));
    } catch { /* storage full or blocked — the in-memory draft still stands */ }
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
    try { localStorage.removeItem(draftKey); } catch { /* fine */ }
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
      try { localStorage.removeItem(draftKey); } catch { /* fine */ }
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
    try { localStorage.removeItem(draftKey); } catch { /* fine */ }
    await refreshAll();
    toast.success('Loaded the newest copy. Your unsaved edits were set aside.');
  };

  const destroy = async () => {
    const undo = await deleteRecord('activities', id);
    // The server keeps the row, so undo is a single call rather than a re-insert.
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

      {/* bullet preview leads — it is the output this record exists to produce */}
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
            <Field error={fieldErrors.quantity} label="Quantity">
              <NumberInput value={draft.quantity ?? ''} onChange={setEvent('quantity')} placeholder="—" />
            </Field>
            <Field label="Unit">
              <Input list="units" value={draft.unit || ''} onChange={setEvent('unit')} placeholder="ULOs" />
              <datalist id="units">
                {UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
              </datalist>
            </Field>
            <Field error={fieldErrors.dollar_amount} label="Dollar amount">
              <NumberInput value={draft.dollar_amount ?? ''} onChange={setEvent('dollar_amount')} placeholder="—" />
            </Field>
            <Field error={fieldErrors.dollar_type} label="Dollar type">
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

          <VisibilityPicker value={draft.visibility || 'chain'} onChange={set('visibility')} unitId={draft.unit_id} />
        </div>
      </Panel>

      <Panel
        title="Evidence"
        subtitle="Links to the artifact that proves this happened"
        action={
          <Button variant="ghost" size="sm" onClick={addLink}>
            <Plus className="h-3 w-3" />
            Add link
          </Button>
        }
      >
        {!draft.evidence_links?.length ? (
          <p className="py-2 text-xs text-text-3">
            No evidence attached. A bullet with a source behind it is the one that survives scrutiny.
          </p>
        ) : (
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
                  <a href={link.url} target="_blank" rel="noreferrer" className="text-text-3 hover:text-signal">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button onClick={() => removeLink(i)} className="text-text-3 hover:text-redline">
                  <X className="h-3.5 w-3.5" />
                </button>
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
