import { useMemo, useState } from 'react';
import { Plus, CheckCircle2, Circle, Clock, FolderKanban, ListTodo } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, Tabs, EmptyState, Badge, Progress, Skeleton, NumberInput } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { DateText, StatusBadge, useParam, onText } from '@/components/common';
import { useDeleteRecord, useIdentity, useProjects, useTasks, useTeam, useUpdateRecord, usePrefs, useActivities } from '@/lib/queries';
import * as api from '@/lib/api';
import { WORK_STATUS, PRIORITIES } from '../../shared/constants';
import { PERMISSIONS } from '../../shared/permissions';
import { humanize, cn, todayIso } from '@/lib/utils';

interface TaskDraft { id?: string; version?: number; title: string; notes: string; status: string; priority: string; due_date: string; project_id: string | null; assignee_id: string | null; visibility: 'private' | 'unit'; unit_id: string | null }
interface ProjectDraft { id?: string; version?: number; name: string; description: string; status: string; priority: string; progress: number | string; start_date: string; target_date: string; organization: string; visibility: 'private' | 'unit'; unit_id: string | null }

export default function Work() {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const [tab, setTab] = useParam('tab', 'tasks');
  const { data: tasks, isPending } = useTasks();
  const { data: projects } = useProjects();
  const { data: activities } = useActivities();
  const { data: team } = useTeam(Boolean(identity?.canLead));
  const updateTask = useUpdateRecord('tasks');
  const deleteTask = useDeleteRecord('tasks');
  const deleteProject = useDeleteRecord('projects');
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [confirm, setConfirm] = useState<{ store: 'tasks' | 'projects'; row: any } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [projectFilter, setProjectFilter] = useState('all');
  const today = todayIso();
  const me = identity?.user.id;
  const roster: any[] = team?.roster || [];
  const nameOf = (id?: string | null) => { if (!id) return ''; if (id === me) return 'Me'; const p = roster.find((r) => r.id === id); return p ? `${p.rank_abbr || ''} ${p.last_name}`.trim() : 'Assigned'; };

  const visibleTasks = useMemo(() => (tasks || []).filter((t: any) => (showDone || t.status !== 'completed') && (projectFilter === 'all' || t.project_id === projectFilter)), [tasks, showDone, projectFilter]);
  const groups = useMemo(() => {
    const overdue = visibleTasks.filter((t: any) => t.status !== 'completed' && t.due_date && t.due_date < today);
    const week = visibleTasks.filter((t: any) => !overdue.includes(t) && t.status !== 'completed' && t.due_date && t.due_date <= addDays(today, 7));
    const later = visibleTasks.filter((t: any) => !overdue.includes(t) && !week.includes(t) && t.status !== 'completed');
    const done = visibleTasks.filter((t: any) => t.status === 'completed');
    return [['Overdue', overdue, 'bad'], ['Due this week', week, 'warn'], ['Later', later, 'neutral'], ['Completed', done, 'good']] as Array<[string, any[], string]>;
  }, [visibleTasks, today]);

  const toggle = async (t: any) => {
    try { await updateTask.mutateAsync({ id: t.id, patch: { status: t.status === 'completed' ? 'active' : 'completed', version: t.version } }); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const newTask = (extra: Partial<TaskDraft> = {}) => setTaskDraft({ title: '', notes: '', status: 'planned', priority: 'medium', due_date: '', project_id: projectFilter !== 'all' ? projectFilter : null, assignee_id: null, visibility: prefs.defaultVisibility || 'private', unit_id: identity?.primaryUnitId || null, ...extra });
  const newProject = () => setProjectDraft({ name: '', description: '', status: 'active', priority: 'medium', progress: 0, start_date: today, target_date: '', organization: '', visibility: prefs.defaultVisibility || 'private', unit_id: identity?.primaryUnitId || null });
  const canAssign = Boolean(identity && Object.values(identity.permissions).some((b) => b & ((1 << 12) | (1 << 4))));
  const canEditRow = (r: any) => r.user_id === me || Boolean(r.unit_id && identity && ((identity.permissions[r.unit_id] || 0) & ((1 << 12) | (1 << 3))));

  return (
    <div className="page">
      <PageHeader eyebrow="Work" title="Tasks and projects" lede="What is in flight, what is due, and what it rolls up to. Completed work becomes a logged activity in one click.">
        {tab === 'tasks' ? <Button variant="primary" onClick={() => newTask()}><Plus className="h-4 w-4" />New task</Button> : <Button variant="primary" onClick={newProject}><Plus className="h-4 w-4" />New project</Button>}
      </PageHeader>
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'tasks', label: 'Tasks', count: (tasks || []).filter((t: any) => t.status !== 'completed').length }, { value: 'projects', label: 'Projects', count: (projects || []).filter((p: any) => p.status !== 'completed').length }]} />

      {tab === 'tasks' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select aria-label="Project filter" className="w-52" value={projectFilter} onValueChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...(projects || []).map((p: any) => ({ value: p.id, label: p.name }))]} />
            <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />Show completed</label>
          </div>
          {isPending ? <Skeleton className="h-40" /> : visibleTasks.length === 0 ? <div className="card"><EmptyState icon={ListTodo} title="No open tasks" description="Tasks are the things you owe. When one is done, log it as an activity so it counts." action={<Button variant="primary" onClick={() => newTask()}>Add a task</Button>} /></div> : (
            <div className="space-y-4">
              {groups.filter(([, list]) => list.length).map(([label, list, tone]) => (
                <section key={label} className="card" style={{ overflow: 'hidden' }}>
                  <header className="flex items-center gap-2 border-b border-line px-4 py-2"><span className={cn('badge-dot', tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : tone === 'good' ? 'bg-good' : 'bg-line-strong')} /><h2 className="text-sm font-semibold text-ink">{label}</h2><span className="fig text-xs text-ink-3">{list.length}</span></header>
                  <ul>{list.map((t: any) => (
                    <li key={t.id} className="row flex items-start gap-3 px-4 py-2.5">
                      <button type="button" onClick={() => toggle(t)} disabled={!canEditRow(t)} className="mt-0.5 text-ink-3 hover:text-good disabled:opacity-40" aria-label={t.status === 'completed' ? 'Reopen task' : 'Complete task'}>{t.status === 'completed' ? <CheckCircle2 className="h-5 w-5 text-good" /> : <Circle className="h-5 w-5" />}</button>
                      <div className="min-w-0 flex-1">
                        <button type="button" className={cn('block truncate text-left text-sm font-medium text-ink hover:underline', t.status === 'completed' && 'line-through text-ink-3')} onClick={() => canEditRow(t) && setTaskDraft({ ...t, notes: t.notes || '', due_date: t.due_date || '' })}>{t.title}</button>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
                          {t.due_date && <span className={cn('flex items-center gap-1', t.status !== 'completed' && t.due_date < today && 'text-bad')}><Clock className="h-3 w-3" /><DateText value={t.due_date} /></span>}
                          {t.project_id && <span>{(projects || []).find((p: any) => p.id === t.project_id)?.name}</span>}
                          {t.assignee_id && t.assignee_id !== me && <span>→ {nameOf(t.assignee_id)}</span>}
                          {t.user_id !== me && <span>from {nameOf(t.user_id)}</span>}
                          {t.notes && <span className="truncate">{t.notes}</span>}
                        </p>
                      </div>
                      {t.priority !== 'medium' && <StatusBadge value={t.priority} />}
                      {t.status === 'completed' && <Button size="xs" variant="soft" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: t.title }))}>Log it</Button>}
                    </li>
                  ))}</ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'projects' && (
        (projects || []).length === 0 ? <div className="card"><EmptyState icon={FolderKanban} title="No projects" description="A project groups tasks and activities under one effort so the roll-up writes itself." action={<Button variant="primary" onClick={newProject}>Add a project</Button>} /></div> : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(projects || []).map((p: any) => {
              const pTasks = (tasks || []).filter((t: any) => t.project_id === p.id);
              const done = pTasks.filter((t: any) => t.status === 'completed').length;
              const acts = (activities || []).filter((a: any) => a.project_id === p.id).length;
              const pct = p.progress != null ? Number(p.progress) : pTasks.length ? Math.round((done / pTasks.length) * 100) : 0;
              return (
                <article key={p.id} className="card card-hover flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2"><h3 className="text-base font-semibold text-ink">{p.name}</h3><StatusBadge value={p.status} /></div>
                  {p.description && <p className="mt-1 line-clamp-3 text-sm text-ink-2">{p.description}</p>}
                  <div className="mt-3"><div className="flex justify-between text-xs text-ink-3"><span>{done}/{pTasks.length} tasks · {acts} activities</span><span className="fig">{pct}%</span></div><Progress value={pct} className="mt-1" tone={pct >= 100 ? 'good' : 'accent'} /></div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">{p.target_date && <Badge tone={p.status !== 'completed' && p.target_date < today ? 'bad' : 'neutral'}>Due <DateText value={p.target_date} /></Badge>}{p.priority !== 'medium' && <StatusBadge value={p.priority} />}{p.visibility === 'unit' && <Badge tone="info">Shared</Badge>}</div>
                  <div className="mt-auto flex justify-between gap-2 border-t border-line pt-3"><Button size="xs" variant="ghost" onClick={() => { setProjectFilter(p.id); setTab('tasks'); }}>Tasks</Button><span className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => newTask({ project_id: p.id })}>+ Task</Button>{canEditRow(p) && <><Button size="xs" variant="ghost" onClick={() => setProjectDraft({ ...p, description: p.description || '', start_date: p.start_date || '', target_date: p.target_date || '', organization: p.organization || '', progress: p.progress ?? 0 })}>Edit</Button><Button size="xs" variant="ghost" onClick={() => setConfirm({ store: 'projects', row: p })}>Delete</Button></>}</span></div>
                </article>
              );
            })}
          </div>
        )
      )}

      <RecordDialog<TaskDraft> store="tasks" open={Boolean(taskDraft)} onOpenChange={(o) => { if (!o) setTaskDraft(null); }} initial={taskDraft} title={taskDraft?.id ? 'Edit task' : 'New task'} noun="Task" validate={(d) => (!d.title.trim() ? 'A title is required.' : null)}
        fields={(d, set, errors) => (
          <>
            <Field label="Title" required error={errors.title}><Input autoFocus value={d.title} onChange={onText(set, 'title')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={WORK_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Priority"><Select value={d.priority} onValueChange={(v) => set('priority', v)} options={PRIORITIES.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Due" error={errors.due_date}><Input type="date" value={d.due_date} onChange={onText(set, 'due_date')} /></Field>
              <Field label="Project"><Select value={d.project_id || '__none'} onValueChange={(v) => set('project_id', v === '__none' ? null : v)} options={[{ value: '__none', label: 'None' }, ...(projects || []).map((p: any) => ({ value: p.id, label: p.name }))]} /></Field>
            </div>
            {canAssign && d.visibility === 'unit' && <Field label="Assign to" hint="members of the shared unit"><Select value={d.assignee_id || '__me'} onValueChange={(v) => set('assignee_id', v === '__me' ? null : v)} options={[{ value: '__me', label: 'Myself' }, ...roster.filter((r) => r.id !== me && r.memberships.some((m: any) => m.unit_id === d.unit_id)).map((r) => ({ value: r.id, label: `${r.rank_abbr || ''} ${r.last_name}, ${r.first_name}`.trim() }))]} /></Field>}
            <Field label="Notes"><Textarea rows={3} value={d.notes} onChange={onText(set, 'notes')} /></Field>
            <VisibilityPicker permission={PERMISSIONS.CREATE_SHARED_WORK} value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
            {d.id && <div className="flex justify-end"><Button size="xs" variant="danger" onClick={() => { setConfirm({ store: 'tasks', row: d }); setTaskDraft(null); }}>Delete task</Button></div>}
          </>
        )} />
      <RecordDialog<ProjectDraft> store="projects" open={Boolean(projectDraft)} onOpenChange={(o) => { if (!o) setProjectDraft(null); }} initial={projectDraft} title={projectDraft?.id ? 'Edit project' : 'New project'} noun="Project" validate={(d) => (!d.name.trim() ? 'A name is required.' : null)}
        fields={(d, set, errors) => (
          <>
            <Field label="Name" required error={errors.name}><Input autoFocus value={d.name} onChange={onText(set, 'name')} /></Field>
            <Field label="Description"><Textarea rows={3} value={d.description} onChange={onText(set, 'description')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={WORK_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Priority"><Select value={d.priority} onValueChange={(v) => set('priority', v)} options={PRIORITIES.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Start"><Input type="date" value={d.start_date} onChange={onText(set, 'start_date')} /></Field>
              <Field label="Target"><Input type="date" value={d.target_date} onChange={onText(set, 'target_date')} /></Field>
              <Field label="Progress %" error={errors.progress}><NumberInput value={d.progress} onChange={onText(set, 'progress')} /></Field>
              <Field label="Organization"><Input value={d.organization} onChange={onText(set, 'organization')} /></Field>
            </div>
            <VisibilityPicker permission={PERMISSIONS.CREATE_SHARED_WORK} value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
          </>
        )} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Delete this ${confirm?.store === 'tasks' ? 'task' : 'project'}?`} body="It moves to the recycle bin for 30 days." onConfirm={async () => { try { await (confirm!.store === 'tasks' ? deleteTask : deleteProject).mutateAsync(confirm!.row.id); toast.success('Deleted.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}

function addDays(iso: string, n: number) { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
