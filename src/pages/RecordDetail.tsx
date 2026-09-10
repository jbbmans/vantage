import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Paperclip, Trash2, RotateCcw, ExternalLink, Lock, Users, Pencil, Sparkles } from 'lucide-react';
import { Button, Badge, Panel, EmptyState, Skeleton, Segmented, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import { ActivityFields, toActivityDraft, type ActivityDraft } from '@/components/ActivityForm';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DescriptionList, DateText, StatusBadge, CategoryDot } from '@/components/common';
import { keys, useDeleteRecord, useIdentity, useRestoreRecord, useTrack, unitName, useOrg, useMetrics } from '@/lib/queries';
import * as api from '@/lib/api';
import { composeBullet, strength, weaknesses, expandAcronyms, type BulletStyle } from '../../shared/bullets';
import { formatDollars, formatNumber } from '../../shared/metrics';
import { valueType } from '../../shared/constants';
import { mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import { copyToClipboard, cn } from '@/lib/utils';

export default function RecordDetail() {
  const cfg = useMetrics();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const track = useTrack();
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const { data: a, isPending, error } = useQuery({ queryKey: keys.record('activities', id), queryFn: () => api.getRecord('activities', id), retry: false });
  const { data: files, refetch: refetchFiles } = useQuery({ queryKey: ['attachments', 'activities', id], queryFn: () => api.attachments('activities', id), enabled: Boolean(a) && Boolean(identity?.instance.attachmentsEnabled) });
  const remove = useDeleteRecord('activities');
  const restore = useRestoreRecord('activities');
  const [style, setStyle] = useState<BulletStyle>(track === 'fitrep' ? 'fitrep' : 'jepes');
  const [editing, setEditing] = useState<ActivityDraft | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [aiOut, setAiOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setStyle(track === 'fitrep' ? 'fitrep' : 'jepes'); }, [track]);
  useEffect(() => { if (a?.title) document.title = `${a.title} · Vantage`; }, [a?.title]);

  const bullet = useMemo(() => (a ? composeBullet(a, { style, includeDate: style !== 'resume' }) : ''), [a, style]);
  const gaps = useMemo(() => (a ? weaknesses(a) : []), [a]);
  const score = a ? strength(a) : 0;
  const mine = a?.user_id === identity?.user.id;
  const canEdit = a ? (mine ? !a.frozen_at : Boolean(a.unit_id && identity && ((identity.permissions[a.unit_id] || 0) & ((1 << 12) | (1 << 3))))) : false;

  if (isPending) return <div className="page space-y-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (error || !a) return <div className="page"><div className="card"><EmptyState title="That entry is not available" description={api.errorText(error) || 'It may have been deleted, or it is private to another Marine.'} action={<Button onClick={() => navigate('/records')}>Back to records</Button>} /></div></div>;

  const upload = async (file: File) => {
    setUploading(true);
    try { await api.uploadAttachment('activities', id, file); toast.success(`Attached ${file.name}.`); refetchFiles(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const copy = async () => { if (await copyToClipboard(bullet)) toast.success('Bullet copied.'); else toast.error('Could not copy.'); };
  const dollarType = valueType(a.dollar_type, cfg);

  return (
    <div className="page max-w-5xl">
      <Link to="/records" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />All records</Link>
      {a.deleted_at && <div className="mb-4 flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink"><span className="flex-1">This entry is in the recycle bin. It is excluded from reports and will be purged after 30 days.</span><Button size="sm" onClick={() => restore.mutateAsync(id).then(() => toast.success('Restored.')).catch((e) => toast.error(api.errorText(e)))}><RotateCcw className="h-4 w-4" />Restore</Button></div>}
      {a.frozen_at && <div className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">This entry was frozen when the unit membership ended. It stays on your record but cannot be edited.</div>}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-3"><span className="flex items-center gap-1.5"><CategoryDot category={a.category} />{a.category || 'Uncategorized'}</span><span>·</span><DateText value={a.date} /><span>·</span><span className="flex items-center gap-1">{a.visibility === 'unit' ? <Users className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{a.visibility === 'unit' ? `Shared with ${unitName(identity, a.unit_id, org)}` : 'Only you'}</span>{!mine && a.owner_name && <><span>·</span><span>{a.owner_name}</span></>}</p>
          <h1 className="page-title text-xl sm:text-2xl">{a.title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && !a.deleted_at && <Button onClick={() => setEditing(toActivityDraft(a))}><Pencil className="h-4 w-4" />Edit</Button>}
          {canEdit && !a.deleted_at && <Button variant="danger" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete</Button>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="As a bullet" subtitle="how this reads in a package" action={<><Segmented size="sm" label="Bullet style" value={style} onChange={setStyle} options={[{ value: 'jepes', label: 'JEPES' }, { value: 'fitrep', label: 'FITREP' }, { value: 'resume', label: 'Résumé' }]} /><Button size="sm" variant="ghost" onClick={copy}><Copy className="h-3.5 w-3.5" />Copy</Button></>}>
            <p className="rounded-md border border-line bg-surface-2 px-3 py-2.5 font-mono text-sm leading-relaxed text-ink">{bullet}</p>
            {style === 'fitrep' && expandAcronyms(bullet) !== bullet && <p className="mt-2 text-xs text-ink-3">Expanded: {expandAcronyms(bullet)}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tooltip content="Strength counts date, quantity, value, result, area, and organization"><span className={cn('fig rounded-full border px-2 py-0.5 text-xs font-semibold', score >= 4 ? 'border-good/40 text-good' : score >= 2 ? 'border-line text-ink-2' : 'border-warn/40 text-warn')}>Strength {score}/5</span></Tooltip>
              {gaps.map((g) => <Badge key={g} tone="warn">{g}</Badge>)}
              {gaps.length === 0 && <span className="text-xs text-good">Complete. This one survives the cut.</span>}
            </div>
          </Panel>

          <Panel title="Details">
            <DescriptionList items={[
              ['Result', a.result], ['Quantity', a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}` : null],
              ['Transaction value', a.dollar_amount != null ? `${formatDollars(a.dollar_amount)}${dollarType ? ` · ${dollarType.label}` : ''}` : null],
              [trackMeta(track).areaLabel, mapAreaToTrack(a.eval_area, track)], ['Organization', a.organization], ['System', a.system], ['Status', <StatusBadge value={a.status} />],
              ['Project', a.project_name ? <Link className="link" to="/work?tab=projects">{a.project_name}</Link> : null],
              ['Notes', a.notes ? <span className="whitespace-pre-wrap">{a.notes}</span> : null],
            ]} />
            {(a.evidence_links || []).length > 0 && <div className="mt-4"><p className="eyebrow mb-1.5">Evidence</p><ul className="space-y-1">{a.evidence_links.map((l: any, i: number) => <li key={i} className="text-sm">{l.url ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">{l.label || l.url}<ExternalLink className="h-3 w-3" /></a> : <span className="text-ink-2">{l.label}</span>}</li>)}</ul></div>}
            <p className="mt-4 text-2xs text-ink-3">Created {new Date(a.created_at).toLocaleString()} · updated {new Date(a.updated_at).toLocaleString()} · version {a.version}</p>
          </Panel>

          {identity?.instance.aiEnabled && mine && (
            <Panel title="Improve the wording" subtitle="AI drafts a stronger bullet from your facts; nothing is saved automatically" action={<AiAction workflow="writing" input={{ kind: 'evaluation_bullet', source: `Title: ${a.title}\nDate: ${a.date}\nQuantity: ${a.quantity ?? ''} ${a.unit_label || ''}\nValue: ${a.dollar_amount ?? ''} ${a.dollar_type || ''}\nResult: ${a.result || ''}\nOrganization: ${a.organization || ''}\nSystem: ${a.system || ''}\nNotes: ${a.notes || ''}`, limit: 400 }} label="Draft with AI" onResult={(output, meta) => setAiOut({ output, meta })} />}>
              {aiOut ? <AiResult output={aiOut.output} meta={aiOut.meta} /> : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />Uses only the fields on this page.</p>}
            </Panel>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="Attachments" subtitle={identity?.instance.attachmentsEnabled ? 'PDFs and images, kept on this server' : 'disabled on this deployment'} action={canEdit && identity?.instance.attachmentsEnabled && !a.deleted_at ? <Button size="sm" loading={uploading} onClick={() => fileInput.current?.click()}><Paperclip className="h-3.5 w-3.5" />Add</Button> : undefined}>
            <input ref={fileInput} type="file" className="sr-only" accept={(files?.allowedTypes || []).join(',')} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            {!identity?.instance.attachmentsEnabled ? <p className="text-sm text-ink-3">Use evidence links instead.</p> : !files?.attachments?.length ? <p className="text-sm text-ink-3">No files yet. Attach the LOA, the screenshot, or the signed sheet. Max {Math.round((files?.maxBytes || 0) / 1_048_576) || 8} MB each.</p> : (
              <ul className="space-y-1.5">{files.attachments.map((f: any) => (
                <li key={f.id} className="flex items-center gap-2 text-sm"><a href={api.attachmentUrl('activities', id, f.id)} className="link min-w-0 flex-1 truncate">{f.original_name}</a><span className="fig text-2xs text-ink-3">{Math.max(1, Math.round(f.size_bytes / 1024))} KB</span>{canEdit && <button type="button" className="text-ink-3 hover:text-bad" aria-label={`Remove ${f.original_name}`} onClick={async () => { try { await api.deleteAttachment('activities', id, f.id); refetchFiles(); } catch (e) { toast.error(api.errorText(e)); } }}>×</button>}</li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="Where it counts">
            <ul className="space-y-1.5 text-sm text-ink-2">
              <li>Included in <Link to="/reports" className="link">{trackMeta(track).inputName}</Link> for {a.date ? a.date.slice(0, 4) : 'its'} period.</li>
              {a.dollar_amount != null && <li>{dollarType?.summable === false ? 'Reviewed dollars are tracked separately from headline totals.' : 'Counts toward headline dollar totals.'}</li>}
              {a.visibility === 'unit' ? <li>Visible on the unit dashboard for {unitName(identity, a.unit_id, org)}.</li> : <li>Never visible to leaders or the unit.</li>}
            </ul>
          </Panel>
        </div>
      </div>

      <RecordDialog<ActivityDraft> store="activities" open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} initial={editing} title="Edit activity" noun="Activity" size="lg" fields={(draft, set, errors) => <ActivityFields draft={draft} set={set} errors={errors} />} validate={(d) => (!d.title.trim() ? 'A title is required.' : null)} onSaved={() => qc.invalidateQueries({ queryKey: keys.record('activities', id) })} />
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this entry?" body="It moves to the recycle bin for 30 days and can be restored from this page." onConfirm={async () => { try { await remove.mutateAsync(id); toast.success('Entry deleted.'); navigate('/records'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}
