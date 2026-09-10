/**
 * Usage and reliability reporting for the Owner Console.
 *
 * This answers "is the product working" — is anyone using it, does capture succeed, do imports
 * finish, are requests failing. It deliberately cannot answer "how productive is this Marine".
 *
 * Two rules shape every figure here:
 *
 *  1. Aggregate only. Figures are counts and distributions across people, never a person's row.
 *     The Owner role grants no privilege over privacy: an owner reading this sees the same shape
 *     anyone would, and no breakdown is emitted where too few people contributed to it, because a
 *     cohort of one is a name.
 *  2. Three times, never added. Time a form was open, an estimate of active editing, and the
 *     duration a person confirmed the work took are reported side by side and separately labelled.
 *     Adding them would invent a number nobody measured.
 */

import type { AppContext } from '../context.ts';
import { EVENTS } from './telemetry.ts';

/** A breakdown with fewer contributors than this is withheld rather than shown. */
export const MIN_COHORT = 3;

export interface Bucket { key: string; events: number; people: number }
export interface Distribution { count: number; median: number | null; p90: number | null; total: number }

const percentile = (sorted: number[], fraction: number): number | null => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
};

function distribution(values: number[]): Distribution {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    total: sorted.reduce((n, v) => n + v, 0),
  };
}

/** Hides a breakdown row that too few people produced, so a small cohort is not a name. */
const withheld = (buckets: Bucket[]): { shown: Bucket[]; withheld: number } => ({
  shown: buckets.filter((b) => b.people >= MIN_COHORT),
  withheld: buckets.filter((b) => b.people < MIN_COHORT).length,
});

interface EventRow {
  name: string; user_id: string | null; properties: string;
  form_ms: number | null; active_editor_ms: number | null; confirmed_work_minutes: number | null;
  occurred_at: string;
}

interface Loaded extends Omit<EventRow, 'properties'> { props: Record<string, unknown> }

function load(ctx: AppContext, from: string, to: string): Loaded[] {
  const rows = ctx.db.prepare(
    'SELECT name, user_id, properties, form_ms, active_editor_ms, confirmed_work_minutes, occurred_at FROM product_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at'
  ).all(from, `${to}T23:59:59.999Z`) as EventRow[];
  return rows.map((r) => {
    let props: Record<string, unknown> = {};
    try { props = JSON.parse(r.properties || '{}'); } catch { props = {}; }
    return { ...r, props };
  });
}

const byName = (rows: Loaded[], name: string) => rows.filter((r) => r.name === name);

function bucketBy(rows: Loaded[], key: string): Bucket[] {
  const map = new Map<string, { events: number; people: Set<string> }>();
  for (const row of rows) {
    const value = row.props[key];
    if (value === undefined || value === null) continue;
    const k = String(value);
    const entry = map.get(k) || { events: 0, people: new Set<string>() };
    entry.events += 1;
    if (row.user_id) entry.people.add(row.user_id);
    map.set(k, entry);
  }
  return [...map.entries()]
    .map(([key2, v]) => ({ key: key2, events: v.events, people: v.people.size }))
    .sort((a, b) => b.events - a.events);
}

const distinctPeople = (rows: Loaded[]) => new Set(rows.map((r) => r.user_id).filter(Boolean) as string[]).size;
const sumProp = (rows: Loaded[], key: string) => rows.reduce((n, r) => n + (Number(r.props[key]) || 0), 0);
const countWhere = (rows: Loaded[], key: string, value: unknown) => rows.filter((r) => r.props[key] === value).length;

export interface UsageReport {
  period: { from: string; to: string };
  events: number;
  /** Which event names arrived, so a family showing nothing can be told apart from one not wired up. */
  coverage: Array<{ name: string; family: string; events: number; instrumented: boolean }>;
  adoption: { people: number; sessions: number; returning: number; activeDays: Array<{ day: string; people: number }>; surfaces: Bucket[]; surfacesWithheld: number };
  capture: {
    opened: number; completed: number; abandoned: number; completionRate: number | null;
    abandonmentStates: Bucket[]; abandonmentWithheld: number;
    withMeasure: number; withOutcome: number; aiAssisted: number;
    /** Three separate times. Never summed, never presented as one number. */
    times: { formOpen: Distribution; activeEditorEstimate: Distribution; confirmedWorkMinutes: Distribution };
  };
  work: { claimed: number; released: number; actions: number; draftedRecords: number; resolved: number; confirmedWorkMinutes: Distribution };
  imports: { uploaded: number; previewed: number; committed: number; abandoned: number; conversion: number | null; scanVerdicts: Bucket[]; abandonmentStates: Bucket[]; abandonmentWithheld: number; rowsInserted: number; rowsUnchanged: number; rowsRejected: number; damagedIdentifiers: number; reimports: number };
  editor: { sessions: number; saved: number; activeEditorEstimate: Distribution; formOpen: Distribution; characters: number };
  correspondence: { threads: number; imported: number; duplicates: number; blockedRemoteImages: number; blockedActiveContent: number; linked: number; states: Bucket[]; statesWithheld: number; daysToResponse: Distribution };
  goalsAndReports: { goalsCreated: number; typedGoals: number; automaticGoals: number; goalInspections: number; revisions: number; staleRejections: number; exports: number; sourcesPerRevision: Distribution };
  ai: { requested: number; answered: number; accepted: number; edited: number; failed: number; acceptanceRate: number | null; tokens: number; workflows: Bucket[]; workflowsWithheld: number; failureReasons: Bucket[]; latencyMs: Distribution };
  reliability: { failedRequests: number; byRoute: Bucket[]; clientErrors: number; recovered: number; offlineQueued: number; offlineReplayed: number; offlineFailed: number };
  security: { stepUps: number; stepUpsGranted: number; authorizationDenied: number; deniedByRoute: Bucket[] };
  quality: { missingMeasures: Bucket[]; duplicatesSuspected: number };
}

export function usageReport(ctx: AppContext, period: { from: string; to: string }): UsageReport {
  const rows = load(ctx, period.from, period.to);

  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.name, (seen.get(row.name) || 0) + 1);
  const coverage = Object.entries(EVENTS).map(([name, spec]) => ({
    name, family: spec.family, events: seen.get(name) || 0, instrumented: (seen.get(name) || 0) > 0,
  }));

  // Adoption ----------------------------------------------------------
  const sessions = byName(rows, 'session.started');
  const dayMap = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.user_id) continue;
    const day = row.occurred_at.slice(0, 10);
    const set = dayMap.get(day) || new Set<string>();
    set.add(row.user_id);
    dayMap.set(day, set);
  }
  const surfaces = withheld(bucketBy(byName(rows, 'surface.viewed'), 'surface'));

  // Capture -----------------------------------------------------------
  const opened = byName(rows, 'capture.opened');
  const completed = byName(rows, 'capture.completed');
  const abandoned = byName(rows, 'capture.abandoned');
  const abandonment = withheld(bucketBy(abandoned, 'state'));

  // Work ---------------------------------------------------------------
  const claimed = byName(rows, 'work.claimed');
  const actions = byName(rows, 'work.action_recorded');

  // Import ---------------------------------------------------------------
  const uploaded = byName(rows, 'import.uploaded');
  const previewed = byName(rows, 'import.previewed');
  const committed = byName(rows, 'import.committed');
  const importAbandoned = byName(rows, 'import.abandoned');
  const importAbandonment = withheld(bucketBy(importAbandoned, 'state'));

  // Editor ----------------------------------------------------------------
  const editorSessions = byName(rows, 'editor.session');

  // Correspondence ----------------------------------------------------------
  const threads = byName(rows, 'correspondence.thread_created');
  const messages = byName(rows, 'correspondence.message_imported');
  const stateChanges = byName(rows, 'correspondence.state_changed');
  const states = withheld(bucketBy(stateChanges, 'to'));

  // Goals and reports ---------------------------------------------------------
  const goals = byName(rows, 'goal.created');
  const revisions = byName(rows, 'report.revision_saved');

  // AI ---------------------------------------------------------------------------
  const aiRequested = byName(rows, 'ai.requested');
  const aiAnswered = byName(rows, 'ai.answered');
  const aiAccepted = byName(rows, 'ai.accepted');
  const aiWorkflows = withheld(bucketBy(aiRequested, 'workflow'));

  // Reliability ------------------------------------------------------------------
  const failed = byName(rows, 'reliability.request_failed');
  const clientErrors = byName(rows, 'reliability.client_error');
  const offline = byName(rows, 'reliability.offline_queue');

  // Security ---------------------------------------------------------------------
  const stepUps = byName(rows, 'security.step_up');
  const denied = byName(rows, 'security.authorization_denied');

  const rate = (numerator: number, denominator: number) => (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null);

  return {
    period,
    events: rows.length,
    coverage,
    adoption: {
      people: distinctPeople(rows),
      sessions: sessions.length,
      returning: countWhere(sessions, 'returning', true),
      activeDays: [...dayMap.entries()].map(([day, set]) => ({ day, people: set.size })).sort((a, b) => a.day.localeCompare(b.day)),
      surfaces: surfaces.shown,
      surfacesWithheld: surfaces.withheld,
    },
    capture: {
      opened: opened.length,
      completed: completed.length,
      abandoned: abandoned.length,
      completionRate: rate(completed.length, opened.length),
      abandonmentStates: abandonment.shown,
      abandonmentWithheld: abandonment.withheld,
      withMeasure: countWhere(completed, 'had_measure', true),
      withOutcome: countWhere(completed, 'had_outcome', true),
      aiAssisted: countWhere(completed, 'ai_assisted', true),
      times: {
        formOpen: distribution([...completed, ...abandoned].map((r) => r.form_ms).filter((v): v is number => v != null)),
        activeEditorEstimate: distribution(editorSessions.map((r) => r.active_editor_ms).filter((v): v is number => v != null)),
        confirmedWorkMinutes: distribution([...completed, ...actions].map((r) => r.confirmed_work_minutes).filter((v): v is number => v != null)),
      },
    },
    work: {
      claimed: claimed.length,
      released: byName(rows, 'work.released').length,
      actions: actions.length,
      draftedRecords: countWhere(actions, 'drafted_record', true),
      resolved: countWhere(actions, 'resolved', true),
      confirmedWorkMinutes: distribution(actions.map((r) => r.confirmed_work_minutes).filter((v): v is number => v != null)),
    },
    imports: {
      uploaded: uploaded.length,
      previewed: previewed.length,
      committed: committed.length,
      abandoned: importAbandoned.length,
      conversion: rate(committed.length, uploaded.length),
      scanVerdicts: bucketBy(uploaded, 'scan'),
      // Where people gave up is behaviour, so a cohort of one is withheld. Scan verdicts are not:
      // an owner needs to see one infected upload, and "infected" names a file, not a person.
      abandonmentStates: importAbandonment.shown,
      abandonmentWithheld: importAbandonment.withheld,
      rowsInserted: sumProp(committed, 'inserted'),
      rowsUnchanged: sumProp(committed, 'unchanged'),
      rowsRejected: sumProp(committed, 'rejected'),
      damagedIdentifiers: sumProp(previewed, 'damaged_identifiers'),
      reimports: countWhere(committed, 'reimport', true),
    },
    editor: {
      sessions: editorSessions.length,
      saved: countWhere(editorSessions, 'saved', true),
      activeEditorEstimate: distribution(editorSessions.map((r) => r.active_editor_ms).filter((v): v is number => v != null)),
      formOpen: distribution(editorSessions.map((r) => r.form_ms).filter((v): v is number => v != null)),
      characters: sumProp(editorSessions, 'characters'),
    },
    correspondence: {
      threads: threads.length,
      imported: messages.length,
      duplicates: countWhere(messages, 'duplicate', true),
      blockedRemoteImages: countWhere(messages, 'blocked_remote_images', true),
      blockedActiveContent: countWhere(messages, 'blocked_active_content', true),
      linked: sumProp(byName(rows, 'correspondence.linked'), 'items'),
      states: states.shown,
      statesWithheld: states.withheld,
      daysToResponse: distribution(
        stateChanges.filter((r) => r.props.to === 'response_received').map((r) => Number(r.props.days_since_sent)).filter((v) => Number.isFinite(v))
      ),
    },
    goalsAndReports: {
      goalsCreated: goals.length,
      typedGoals: countWhere(goals, 'typed', true),
      automaticGoals: countWhere(goals, 'automatic', true),
      goalInspections: byName(rows, 'goal.inspected').length,
      revisions: revisions.length,
      staleRejections: byName(rows, 'report.stale_source_rejected').length,
      exports: byName(rows, 'report.exported').length,
      sourcesPerRevision: distribution(revisions.map((r) => Number(r.props.sources)).filter((v) => Number.isFinite(v))),
    },
    ai: {
      requested: aiRequested.length,
      answered: aiAnswered.length,
      accepted: aiAccepted.length,
      edited: countWhere(aiAccepted, 'edited', true),
      failed: countWhere(aiAnswered, 'failed', true),
      acceptanceRate: rate(aiAccepted.length, aiAnswered.length),
      tokens: sumProp(aiAnswered, 'tokens'),
      workflows: aiWorkflows.shown,
      workflowsWithheld: aiWorkflows.withheld,
      failureReasons: bucketBy(aiAnswered.filter((r) => r.props.failed === true), 'reason'),
      latencyMs: distribution(aiAnswered.map((r) => Number(r.props.ms)).filter((v) => Number.isFinite(v))),
    },
    reliability: {
      failedRequests: failed.length,
      byRoute: bucketBy(failed, 'route'),
      clientErrors: clientErrors.length,
      recovered: countWhere(clientErrors, 'recovered', true),
      offlineQueued: sumProp(offline, 'queued'),
      offlineReplayed: sumProp(offline, 'replayed'),
      offlineFailed: sumProp(offline, 'failed'),
    },
    security: {
      stepUps: stepUps.length,
      stepUpsGranted: countWhere(stepUps, 'granted', true),
      authorizationDenied: denied.length,
      deniedByRoute: bucketBy(denied, 'route'),
    },
    quality: {
      missingMeasures: bucketBy(byName(rows, 'quality.record_missing_measure'), 'missing'),
      duplicatesSuspected: sumProp(byName(rows, 'quality.duplicate_suspected'), 'candidates'),
    },
  };
}

/** Trims events older than the retention window. Analytics are for steering a product, not a memory. */
export function pruneEvents(ctx: AppContext, olderThanDays = 400): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = ctx.db.prepare('DELETE FROM product_events WHERE received_at < ?').run(cutoff);
  return Number(result.changes || 0);
}
