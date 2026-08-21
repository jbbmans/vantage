import React, { useMemo, useState } from 'react';
import { parseISO, isBefore, startOfDay } from 'date-fns';
import { Plus, Trash2, CheckCheck, Clock3, Layers, Circle, CircleDot, CircleCheck, PauseCircle } from 'lucide-react';
import { useProjects, useTasks, createRecord, updateRecord, deleteRecord, restoreDeleted, useCanLead, useOrg, useIdentity, unitOptions, refreshAll } from '@/store/useStore';
import VisibilityPicker, { UnitTargetPicker } from '@/components/VisibilityPicker';
import { WORK_STATUS, PRIORITIES } from '@/lib/constants';
import { formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/Dialog';
import {
  Panel, PageHeader, EmptyState, Button, Input, Textarea, Select, Field, Badge, Segmented, Tooltip,
} from '@/components/ui/primitives';
import RecordDialog from '@/components/RecordDialog';
import { cn } from '@/lib/utils';
import ConflictDialog from '@/components/ConflictDialog';
import { errorText } from '@/lib/api';

const STATUS_ICON = { planned: Circle, active: CircleDot, waiting: PauseCircle, completed: CircleCheck };
const STATUS_TONE = {
  planned: 'text-text-3',
  active: 'text-signal',
  waiting: 'text-info',
  completed: 'text-ledger',
};
const PRIORITY_TONE = {
  low: 'bg-text-3',
  medium: 'bg-text-2',
  high: 'bg-signal',
  critical: 'bg-redline',
};

const NEXT_STATUS = { planned: 'active', active: 'completed', waiting: 'active', completed: 'planned' };

/** A task is late only if it has a due date in the past and isn't finished. */
const isLate = (t) =>
  Boolean(t.due_date) && t.status !== 'completed' && isBefore(parseISO(t.due_date), startOfDay(new Date()));

export default function Work() {
  const projects = useProjects();
  const tasks = useTasks();
  const toast = useToast();
  const canLead = useCanLead();
  const org = useOrg();
  const identity = useIdentity();
  // Only offer units this Marine's billet actually reaches.
  const leadableUnits = useMemo(
    () => unitOptions(org.units).filter((u) => (identity?.scopeUnitIds || []).includes(u.id)),
    [org.units, identity]
  );
  const [tab, setTab] = useState('tasks');
  const [taskDialog, setTaskDialog] = useState(null);
  const [projectDialog, setProjectDialog] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [filter, setFilter] = useState('open');

  const visibleTasks = useMemo(() => {
    const rows = filter === 'open' ? tasks.filter((t) => t.status !== 'completed') : filter === 'done' ? tasks.filter((t) => t.status === 'completed') : tasks;
    return [...rows].sort((a, b) => {
      if (isLate(a) !== isLate(b)) return isLate(a) ? -1 : 1;
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      const p = (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
      if (p !== 0) return p;
      return (a.due_date || '9999').localeCompare(b.due_date || '9999');
    });
  }, [tasks, filter]);

  const cycle = async (task) => {
    await updateRecord('tasks', task.id, { status: NEXT_STATUS[task.status] || 'active' });
  };

  const [conflict, setConflict] = useState(null);
  const [workErrors, setWorkErrors] = useState({});

  const staleAware = async (fn, noun, table, draft, closeDialog) => {
    try {
      await fn();
      setWorkErrors({});
      closeDialog();
    } catch (err) {
      // Finding 36: reload-or-overwrite, same choice every record gets.
      if (err.status === 409 && err.code === 'stale' && err.current) {
        setConflict({ noun, table, draft, current: err.current });
      } else {
        setWorkErrors(err.fieldErrors || {});
        toast.error(errorText(err));
      }
    }
  };

  const saveTask = (draft) => {
    if (!draft.title?.trim()) return toast.error('A task needs a title.');
    return staleAware(async () => {
      if (draft.id) await updateRecord('tasks', draft.id, draft);
      else await createRecord('tasks', { status: 'planned', priority: 'medium', ...draft });
      toast.success(draft.id ? 'Task updated.' : 'Task added.');
    }, 'task', 'tasks', draft, () => setTaskDialog(null));
  };

  const saveProject = (draft) => {
    if (!draft.name?.trim()) return toast.error('A project needs a name.');
    return staleAware(async () => {
      if (draft.id) await updateRecord('projects', draft.id, draft);
      else await createRecord('projects', { status: 'active', priority: 'medium', progress: 0, ...draft });
      toast.success(draft.id ? 'Project updated.' : 'Project added.');
    }, 'project', 'projects', draft, () => setProjectDialog(null));
  };

  const counts = {
    open: tasks.filter((t) => t.status !== 'completed').length,
    overdue: tasks.filter(isLate).length,
    projects: projects.filter((p) => p.status === 'active').length,
  };

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Work" subtitle={`${counts.open} open · ${counts.overdue} overdue · ${counts.projects} active projects`}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ value: 'tasks', label: 'Tasks' }, { value: 'projects', label: 'Projects' }]}
        />
        <Button variant="primary" size="sm" onClick={() => (tab === 'tasks' ? setTaskDialog({}) : setProjectDialog({}))}>
          <Plus className="h-3.5 w-3.5" />
          New {tab === 'tasks' ? 'task' : 'project'}
        </Button>
      </PageHeader>

      {tab === 'tasks' ? (
        <>
          <div className="mb-2">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'done', label: 'Done' },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
          <Panel bodyClassName="p-0">
            {visibleTasks.length === 0 ? (
              <EmptyState
                icon={CheckCheck}
                title={filter === 'open' ? 'Queue is clear' : 'Nothing here'}
                description={filter === 'open' ? 'No open tasks right now.' : 'Switch the filter to see more.'}
                action={<Button size="sm" onClick={() => setTaskDialog({})}>Add a task</Button>}
              />
            ) : (
              visibleTasks.map((t) => {
                const Icon = STATUS_ICON[t.status] || Circle;
                const project = projects.find((p) => p.id === t.project_id);
                return (
                  <div key={t.id} className="row flex items-center gap-2.5 px-3 py-2">
                    <Tooltip content={`Mark ${NEXT_STATUS[t.status]}`}>
                      <button onClick={() => cycle(t)} className={cn('shrink-0 transition-colors', STATUS_TONE[t.status])}>
                        <Icon className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    <span className={cn('h-3 w-0.5 shrink-0 rounded-sm', PRIORITY_TONE[t.priority])} />
                    <button
                      onClick={() => setTaskDialog(t)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className={cn('block truncate text-base', t.status === 'completed' ? 'text-text-3 line-through' : 'text-text')}>
                        {t.title}
                      </span>
                      {(project || t.notes) && (
                        <span className="block truncate text-2xs text-text-3">
                          {[project?.name, t.notes].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </button>
                    <Badge tone="neutral" className="hidden sm:inline-flex">{t.status}</Badge>
                    {t.due_date && (
                      <span className={cn('fig shrink-0 text-2xs', isLate(t) ? 'text-redline' : 'text-text-3')}>
                        <Clock3 className="mr-0.5 inline h-2.5 w-2.5" />
                        {formatDTG(t.due_date)}
                      </span>
                    )}
                    <button
                      onClick={() => setConfirming({ store: 'tasks', id: t.id, label: t.title })}
                      className="shrink-0 text-text-3 hover:text-redline"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </Panel>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {projects.length === 0 ? (
            <Panel className="md:col-span-2">
              <EmptyState
                icon={Layers}
                title="No projects yet"
                description="Group related tasks and activities under a project to track them together."
                action={<Button size="sm" onClick={() => setProjectDialog({})}>Add a project</Button>}
              />
            </Panel>
          ) : (
            projects.map((p) => {
              const linked = tasks.filter((t) => t.project_id === p.id);
              const done = linked.filter((t) => t.status === 'completed').length;
              const pct = linked.length ? Math.round((done / linked.length) * 100) : p.progress || 0;
              return (
                <Panel
                  key={p.id}
                  title={p.name}
                  subtitle={[p.organization, p.status].filter(Boolean).join(' · ')}
                  action={
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setProjectDialog(p)}>Edit</Button>
                      <button
                        onClick={() => setConfirming({ store: 'projects', id: p.id, label: p.name })}
                        className="text-text-3 hover:text-redline"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  }
                >
                  {p.description && <p className="mb-3 text-sm leading-relaxed text-text-2">{p.description}</p>}
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-text-3">
                      {linked.length ? `${done}/${linked.length} tasks complete` : 'No linked tasks'}
                    </span>
                    <span className="fig text-text">{pct}%</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-rule/60">
                    <div className="h-full bg-signal/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  {p.target_date && (
                    <p className="fig mt-2 text-2xs text-text-3">Target {formatDTG(p.target_date)}</p>
                  )}
                </Panel>
              );
            })
          )}
        </div>
      )}

      <ConflictDialog
        noun={conflict?.noun || 'record'}
        current={conflict?.current}
        onDismiss={() => setConflict(null)}
        onLoadNewest={async () => {
          const { noun, current } = conflict;
          setConflict(null);
          await refreshAll();
          if (noun === 'task') setTaskDialog((d) => (d ? { ...d, ...current } : d));
          else setProjectDialog((d) => (d ? { ...d, ...current } : d));
          toast.success('Loaded the newest copy into the form.');
        }}
        onOverwrite={async () => {
          const { table, draft, current, noun } = conflict;
          setConflict(null);
          try {
            await updateRecord(table, draft.id, { ...draft, version: current.version });
            toast.success(`${noun === 'task' ? 'Task' : 'Project'} updated — your copy won.`);
            if (noun === 'task') setTaskDialog(null); else setProjectDialog(null);
            setWorkErrors({});
          } catch (err) { toast.error(errorText(err)); }
        }}
      />

      {taskDialog && (
        <RecordDialog
          title={taskDialog.id ? 'Edit task' : 'New task'}
          initial={taskDialog}
          onCancel={() => setTaskDialog(null)}
          onSave={saveTask}
          fields={(draft, set) => (
            <>
              <Field error={workErrors.title} label="Title">
                <Input autoFocus value={draft.title || ''} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status">
                  <Select value={draft.status || 'planned'} onValueChange={(v) => set('status', v)} options={WORK_STATUS} />
                </Field>
                <Field label="Priority">
                  <Select value={draft.priority || 'medium'} onValueChange={(v) => set('priority', v)} options={PRIORITIES} />
                </Field>
                <Field error={workErrors.due_date} label="Due date">
                  <Input type="date" value={draft.due_date || ''} onChange={(e) => set('due_date', e.target.value)} />
                </Field>
                <Field label="Project">
                  <Select
                    value={draft.project_id || ''}
                    onValueChange={(v) => set('project_id', v || null)}
                    placeholder="None"
                    options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                  />
                </Field>
              </div>
              <Field label="Notes">
                <Textarea rows={2} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} />
              </Field>
              <VisibilityPicker
                value={draft.visibility || 'private'}
                onChange={(v) => set('visibility', v)}
                unitId={draft.unit_id}
                label="Who sees this task"
              />
              {canLead && draft.visibility && draft.visibility !== 'private' && (
                <UnitTargetPicker
                  value={draft.unit_id}
                  onChange={(v) => set('unit_id', v || null)}
                  units={leadableUnits}
                />
              )}
            </>
          )}
        />
      )}

      {projectDialog && (
        <RecordDialog
          title={projectDialog.id ? 'Edit project' : 'New project'}
          initial={projectDialog}
          onCancel={() => setProjectDialog(null)}
          onSave={saveProject}
          fields={(draft, set) => (
            <>
              <Field error={workErrors.name} label="Name">
                <Input autoFocus value={draft.name || ''} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Description">
                <Textarea rows={2} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status">
                  <Select value={draft.status || 'active'} onValueChange={(v) => set('status', v)} options={WORK_STATUS} />
                </Field>
                <Field label="Priority">
                  <Select value={draft.priority || 'medium'} onValueChange={(v) => set('priority', v)} options={PRIORITIES} />
                </Field>
                <Field label="Start date">
                  <Input type="date" value={draft.start_date || ''} onChange={(e) => set('start_date', e.target.value)} />
                </Field>
                <Field label="Target date">
                  <Input type="date" value={draft.target_date || ''} onChange={(e) => set('target_date', e.target.value)} />
                </Field>
              </div>
              <Field label="Organization">
                <Input value={draft.organization || ''} onChange={(e) => set('organization', e.target.value)} />
              </Field>
              <VisibilityPicker
                value={draft.visibility || 'private'}
                onChange={(v) => set('visibility', v)}
                unitId={draft.unit_id}
                label="Who sees this project"
              />
            </>
          )}
        />
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(v) => !v && setConfirming(null)}
        title={`Delete "${confirming?.label}"?`}
        body="This removes the record permanently. Linked items are kept but unlinked."
        onConfirm={async () => {
          const undo = await deleteRecord(confirming.store, confirming.id);
          toast.success('Deleted.', {
            label: 'Undo',
            run: async () => {
              try {
                await restoreDeleted(undo);
                toast.success('Restored.');
              } catch (err) {
                toast.error(errorText(err));
              }
            },
          });
        }}
      />
    </div>
  );
}
