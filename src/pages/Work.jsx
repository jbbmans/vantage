import React, { useMemo, useState } from 'react';
import { parseISO, isBefore, startOfDay } from 'date-fns';
import { Plus, Trash2, CheckCheck, Clock3, Layers, Circle, CircleDot, CircleCheck, PauseCircle, GripVertical } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProjects, useTasks, createRecord, updateRecord, deleteRecord, restoreDeleted, useCanLead, useOrg, useIdentity, unitOptions, refreshAll } from '@/store/useStore';
import VisibilityPicker, { UnitTargetPicker } from '@/components/VisibilityPicker';
import { WORK_STATUS, PRIORITIES } from '@/lib/constants';
import { formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/Dialog';
import {
  Panel, EmptyState, Button, Input, Textarea, Select, Field, Badge, Segmented, Tooltip,
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

const BOARD_COLUMNS = [
  { status: 'planned', title: 'Planned', description: 'Ready to start' },
  { status: 'active', title: 'In progress', description: 'Moving now' },
  { status: 'waiting', title: 'Waiting', description: 'Blocked or pending' },
  { status: 'completed', title: 'Complete', description: 'Closed work' },
];

/** A task is late only if it has a due date in the past and isn't finished. */
const isLate = (t) =>
  Boolean(t.due_date) && t.status !== 'completed' && isBefore(parseISO(t.due_date), startOfDay(new Date()));

function TaskCard({ task, project, onCycle, onEdit, onDelete, onDragStart, onDragEnd }) {
  const Icon = STATUS_ICON[task.status] || Circle;
  return (
    <article className="group animate-fade-up rounded-md border border-rule bg-panel p-3 transition-all duration-150 hover:-translate-y-0.5 hover:border-rule-strong hover:shadow-[0_10px_24px_-20px_rgb(0_0_0/0.65)]">
      <div className="flex items-start gap-2.5">
        <Tooltip content="Drag to another status">
          <button
            type="button"
            draggable
            onDragStart={(event) => onDragStart(event, task)}
            onDragEnd={onDragEnd}
            className="mt-0.5 hidden cursor-grab text-text-3 hover:text-text active:cursor-grabbing sm:block"
            aria-label={`Drag ${task.title} to another status`}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={`Mark ${NEXT_STATUS[task.status]}`}>
          <button type="button" onClick={() => onCycle(task)} className={cn('mt-0.5 shrink-0 transition-colors', STATUS_TONE[task.status])} aria-label={`Advance ${task.title}`}>
            <Icon className="h-4 w-4" />
          </button>
        </Tooltip>
        <button type="button" onClick={() => onEdit(task)} className="min-w-0 flex-1 text-left">
          <span className={cn('block text-sm font-medium leading-snug', task.status === 'completed' ? 'text-text-3 line-through' : 'text-text')}>
            {task.title}
          </span>
          {(project || task.notes) && <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-text-3">{[project?.name, task.notes].filter(Boolean).join(' · ')}</span>}
        </button>
        <button type="button" onClick={() => onDelete(task)} className="shrink-0 rounded-sm p-1 text-text-3 opacity-0 transition group-hover:opacity-100 hover:bg-redline/10 hover:text-redline focus-visible:opacity-100" aria-label={`Delete ${task.title}`}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-rule pt-2">
        <span className="flex items-center gap-1.5 text-xs capitalize text-text-3"><span className={cn('h-2 w-2 rounded-full', PRIORITY_TONE[task.priority])} />{task.priority || 'medium'}</span>
        {task.due_date && <span className={cn('fig text-xs', isLate(task) ? 'text-redline' : 'text-text-3')}><Clock3 className="mr-1 inline h-3 w-3" />{formatDTG(task.due_date)}</span>}
      </div>
    </article>
  );
}

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
  const [draggingTaskId, setDraggingTaskId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

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

  const dropTask = async (status) => {
    const task = tasks.find((item) => item.id === draggingTaskId);
    setDropTarget(null);
    setDraggingTaskId(null);
    if (!task || task.status === status) return;
    try {
      await updateRecord('tasks', task.id, { status });
      toast.success(`Moved to ${BOARD_COLUMNS.find((column) => column.status === status)?.title || status}.`);
    } catch (err) { toast.error(errorText(err)); }
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

  const boardColumns = filter === 'done'
    ? BOARD_COLUMNS.filter((column) => column.status === 'completed')
    : filter === 'all'
      ? BOARD_COLUMNS
      : BOARD_COLUMNS.filter((column) => column.status !== 'completed');

  return (
    <div className="page-canvas work-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Mission planner</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Work board</h2>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-3">
            <span><strong className="fig mr-1 text-text">{counts.open}</strong> open</span>
            <span><strong className={cn('fig mr-1', counts.overdue ? 'text-redline' : 'text-text')}>{counts.overdue}</strong> overdue</span>
            <span><strong className="fig mr-1 text-text">{counts.projects}</strong> active projects</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ value: 'tasks', label: 'Tasks' }, { value: 'projects', label: 'Projects' }]}
        />
        <Button variant="default" size="sm" asChild><Link to="/goals">Goals</Link></Button>
        <Button variant="primary" size="sm" onClick={() => (tab === 'tasks' ? setTaskDialog({}) : setProjectDialog({}))}>
          <Plus className="h-3.5 w-3.5" />
          New {tab === 'tasks' ? 'task' : 'project'}
        </Button>
        </div>
      </div>

      {tab === 'tasks' ? (
        <section className="mt-5" aria-label="Task board">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-text">Task flow</h3>
              <p className="mt-0.5 text-sm text-text-3">Advance work with the status control on each task.</p>
            </div>
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
          {visibleTasks.length === 0 ? (
            <Panel>
              <EmptyState
                icon={CheckCheck}
                title={filter === 'open' ? 'Queue is clear' : 'Nothing here'}
                description={filter === 'open' ? 'No open tasks right now.' : 'Switch the filter to see more.'}
                action={<Button size="sm" onClick={() => setTaskDialog({})}>Add a task</Button>}
              />
            </Panel>
          ) : (
            <div className={cn('grid grid-cols-1 gap-3 md:grid-cols-2', boardColumns.length >= 3 && 'xl:grid-cols-3', boardColumns.length === 4 && '2xl:grid-cols-4')}>
              {boardColumns.map((column) => {
                const columnTasks = visibleTasks.filter((task) => task.status === column.status);
                return (
                  <section
                    key={column.status}
                    className={cn(
                      'min-h-[260px] rounded-md border border-rule bg-panel-2/35 p-3 transition-colors duration-150',
                      dropTarget === column.status && 'border-signal bg-signal/[0.07]'
                    )}
                    aria-labelledby={`column-${column.status}`}
                    onDragOver={(event) => { event.preventDefault(); setDropTarget(column.status); }}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(null); }}
                    onDrop={(event) => { event.preventDefault(); dropTask(column.status); }}
                  >
                    <header className="mb-3 flex items-start justify-between border-b border-rule pb-3">
                      <div><h4 id={`column-${column.status}`} className="text-sm font-semibold text-text">{column.title}</h4><p className="mt-0.5 text-xs text-text-3">{column.description}</p></div>
                      <span className="fig rounded-full bg-panel px-2 py-0.5 text-xs text-text-3">{columnTasks.length}</span>
                    </header>
                    <div className="space-y-2.5">
                      {columnTasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          project={projects.find((project) => project.id === task.project_id)}
                          onCycle={cycle}
                          onEdit={setTaskDialog}
                          onDelete={(row) => setConfirming({ store: 'tasks', id: row.id, label: row.title })}
                          onDragStart={(event, row) => {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', row.id);
                            setDraggingTaskId(row.id);
                          }}
                          onDragEnd={() => { setDraggingTaskId(null); setDropTarget(null); }}
                        />
                      ))}
                      {columnTasks.length === 0 && <p className="px-1 py-8 text-center text-xs text-text-3">No tasks here</p>}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="mt-5 space-y-3" aria-label="Projects">
          {projects.length === 0 ? (
            <Panel>
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
                <article key={p.id} className="grid gap-4 border-b border-rule py-5 first:pt-0 lg:grid-cols-[minmax(0,1fr)_280px_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><h3 className="truncate text-lg font-semibold text-text">{p.name}</h3><Badge tone="neutral">{p.status}</Badge></div>
                    {p.description && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-3">{p.description}</p>}
                    <p className="mt-2 text-xs text-text-3">{[p.organization, p.target_date ? `Target ${formatDTG(p.target_date)}` : null].filter(Boolean).join(' · ') || 'No target date'}</p>
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between text-xs"><span className="text-text-3">{linked.length ? `${done}/${linked.length} tasks complete` : 'No linked tasks'}</span><span className="fig text-text">{pct}%</span></div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2"><div className="h-full rounded-full bg-signal transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
                  </div>
                  <div className="flex items-center gap-1 lg:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setProjectDialog(p)}>Edit</Button>
                      <button
                        type="button"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => setConfirming({ store: 'projects', id: p.id, label: p.name })}
                        className="text-text-3 hover:text-redline"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                  </div>
                </article>
              );
            })
          )}
        </section>
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
              {draft.visibility === 'unit' && (
                <UnitTargetPicker
                  value={draft.unit_id}
                  onChange={(v) => set('unit_id', v || null)}
                  units={canLead ? leadableUnits : []}
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
              {draft.visibility === 'unit' && (
                <UnitTargetPicker
                  value={draft.unit_id}
                  onChange={(v) => set('unit_id', v || null)}
                  units={canLead ? leadableUnits : []}
                />
              )}
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
