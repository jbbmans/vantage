/**
 * The product-event pipeline.
 *
 * Vantage measures its own use so the people who run it can see whether it is helping. That is only
 * defensible if the measurement cannot become surveillance, so the pipeline is closed rather than
 * open: every event name and every property is declared here, and anything undeclared is dropped
 * with a reason rather than stored "just in case".
 *
 * Three rules hold the line:
 *
 *  1. No content. A property may be a number, a boolean, or one of a fixed set of words. There is no
 *     free-text property, so a draft, a workbook cell, an email body, or a keystroke has nowhere to
 *     go even if a caller tries.
 *  2. Three separate times. How long a form was open, how long the editor judged someone to be
 *     actively working, and how long the person said the work took are three different facts. They
 *     live in three columns, are reported separately, and are never added together.
 *  3. Counting use is not counting worth. Nothing here feeds a person's record, their goals, or any
 *     figure a leader sees about them. It answers "is the product working", not "is this Marine".
 */

import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';

export type PropertyKind = 'number' | 'boolean' | 'enum';

export interface PropertySpec {
  kind: PropertyKind;
  /** For 'enum': the complete set of words this property may take. Anything else is dropped. */
  values?: readonly string[];
}

export interface EventSpec {
  /** Which of the reported families this event belongs to. */
  family: 'adoption' | 'capture' | 'work' | 'import' | 'editor' | 'correspondence' | 'goal' | 'report' | 'ai' | 'reliability' | 'security' | 'quality';
  properties: Record<string, PropertySpec>;
  /** Events the server raises itself. A client claiming one of these is refused. */
  serverOnly?: boolean;
  /** Which of the three durations this event may carry. Anything else is dropped. */
  times?: Array<'form_ms' | 'active_editor_ms' | 'confirmed_work_minutes'>;
}

const bool: PropertySpec = { kind: 'boolean' };
const num: PropertySpec = { kind: 'number' };
const oneOf = (...values: string[]): PropertySpec => ({ kind: 'enum', values });

/**
 * The catalog. Adding a metric means adding a line here; there is no way to record something this
 * file does not name.
 */
export const EVENTS: Record<string, EventSpec> = {
  // Where an event is raised follows who actually knows the fact. An outcome the server performed —
  // rows committed, a thread moved, a revision saved — is raised by the server, where the count is
  // exact and a client cannot inflate it. Intent, timing and abandonment are raised by the client,
  // because a form the person closed never reached the server at all. Nothing is raised twice.
  // Adoption ----------------------------------------------------------
  'session.started': { family: 'adoption', properties: { returning: bool, days_since_last: num } },
  'surface.viewed': { family: 'adoption', properties: { surface: oneOf('dashboard', 'records', 'queue', 'tasks', 'goals', 'correspondence', 'studio', 'reports', 'career', 'readiness', 'team', 'settings', 'operator', 'help') } },

  // The capture funnel, and where it is abandoned ----------------------
  'capture.opened': { family: 'capture', properties: { surface: oneOf('quick_log', 'record_form', 'work_action', 'thread_message') } },
  'capture.abandoned': {
    family: 'capture',
    // Why a capture ended without a record is the most useful thing this pipeline can learn, and it
    // is a state, never the text the person had typed.
    properties: {
      surface: oneOf('quick_log', 'record_form', 'work_action', 'thread_message'),
      state: oneOf('closed_immediately', 'typed_then_left', 'validation_blocked', 'save_failed', 'navigated_away', 'unknown'),
      fields_filled: num,
      had_measure: bool,
    },
    times: ['form_ms'],
  },
  'capture.completed': {
    family: 'capture',
    properties: {
      surface: oneOf('quick_log', 'record_form', 'work_action', 'thread_message'),
      had_measure: bool,
      had_outcome: bool,
      ai_assisted: bool,
      source: oneOf('manual', 'work_action', 'import', 'ai_draft'),
    },
    times: ['form_ms', 'confirmed_work_minutes'],
  },

  // Work ---------------------------------------------------------------
  'work.claimed': { serverOnly: true, family: 'work', properties: { bulk: bool, count: num } },
  'work.released': { serverOnly: true, family: 'work', properties: { held_hours: num } },
  'work.action_recorded': { serverOnly: true, family: 'work', properties: { kind: oneOf('note', 'progress', 'resolution', 'correction'), drafted_record: bool, resolved: bool }, times: ['confirmed_work_minutes'] },
  'work.view_saved': { family: 'work', properties: { filters: num } },

  // Import --------------------------------------------------------------
  'import.uploaded': { serverOnly: true, family: 'import', properties: { format: oneOf('xlsx', 'csv', 'other'), bytes: num, scan: oneOf('clean', 'infected', 'skipped', 'error') } },
  'import.previewed': { family: 'import', properties: { rows: num, mapped_columns: num, unmapped_columns: num, damaged_identifiers: num } },
  'import.committed': { serverOnly: true, family: 'import', properties: { inserted: num, updated: num, unchanged: num, rejected: num, reimport: bool }, times: ['form_ms'] },
  'import.abandoned': { family: 'import', properties: { state: oneOf('at_upload', 'at_mapping', 'at_preview', 'save_failed') }, times: ['form_ms'] },

  // The editor ----------------------------------------------------------
  // active_editor_ms is an estimate the client makes from typing and focus. It is labelled an
  // estimate everywhere it is shown, and it is never presented as time worked.
  'editor.session': { family: 'editor', properties: { surface: oneOf('studio', 'record_form', 'thread_message'), sections: num, characters: num, saved: bool }, times: ['active_editor_ms', 'form_ms'] },

  // Correspondence -------------------------------------------------------
  'correspondence.thread_created': { serverOnly: true, family: 'correspondence', properties: { has_contact: bool, has_follow_up: bool } },
  'correspondence.state_changed': { serverOnly: true, family: 'correspondence', properties: { to: oneOf('draft', 'sent', 'awaiting_reply', 'response_received', 'ksd_received', 'resolved'), days_since_sent: num } },
  'correspondence.message_imported': { serverOnly: true, family: 'correspondence', properties: { source: oneOf('eml', 'graph', 'manual'), duplicate: bool, blocked_remote_images: bool, blocked_active_content: bool, attachments: num } },
  'correspondence.linked': { serverOnly: true, family: 'correspondence', properties: { items: num } },
  'correspondence.sync': { family: 'correspondence', serverOnly: true, properties: { cloud: oneOf('global', 'usgov', 'usgovdod'), stored: num, skipped: num, pages: num, failed: bool } },

  // Goals and reports ----------------------------------------------------
  'goal.created': { serverOnly: true, family: 'goal', properties: { typed: bool, direction: oneOf('increase', 'decrease', 'threshold', 'completion'), automatic: bool } },
  'goal.inspected': { family: 'goal', properties: { contributors: num } },
  'report.revision_saved': { serverOnly: true, family: 'report', properties: { revision: num, sources: num, sections: num, characters: num }, times: ['active_editor_ms', 'form_ms'] },
  'report.stale_source_rejected': { family: 'report', serverOnly: true, properties: { sources: num, stale: num } },
  'report.exported': { serverOnly: true, family: 'report', properties: { revision: num, format: oneOf('txt', 'pdf', 'csv') } },

  // AI --------------------------------------------------------------------
  'ai.requested': { family: 'ai', properties: { workflow: oneOf('quick_log', 'writing', 'personal_review', 'record_quality', 'goal_draft', 'award_citation', 'counseling_prep', 'command_brief', 'maradmin_summary', 'report_narrative'), surface: oneOf('dashboard', 'records', 'record_detail', 'goals', 'career', 'team', 'studio', 'maradmins', 'reports', 'correspondence', 'quick_log') } },
  'ai.answered': { family: 'ai', serverOnly: true, properties: { workflow: oneOf('quick_log', 'writing', 'personal_review', 'record_quality', 'goal_draft', 'award_citation', 'counseling_prep', 'command_brief', 'maradmin_summary', 'report_narrative'), tokens: num, ms: num, failed: bool, reason: oneOf('ok', 'unreachable', 'rejected', 'budget', 'invalid_output', 'disabled') } },
  'ai.accepted': { family: 'ai', properties: { workflow: oneOf('quick_log', 'writing', 'personal_review', 'record_quality', 'goal_draft', 'award_citation', 'counseling_prep', 'command_brief', 'maradmin_summary', 'report_narrative'), edited: bool } },

  // Reliability -------------------------------------------------------------
  'reliability.request_failed': { family: 'reliability', serverOnly: true, properties: { status: num, ms: num, route: oneOf('records', 'work', 'imports', 'correspondence', 'studio', 'metrics', 'reports', 'org', 'auth', 'admin', 'ai', 'other') } },
  'reliability.client_error': { family: 'reliability', properties: { surface: oneOf('dashboard', 'records', 'queue', 'tasks', 'goals', 'correspondence', 'studio', 'reports', 'career', 'readiness', 'team', 'settings', 'operator', 'help'), recovered: bool } },
  'reliability.offline_queue': { family: 'reliability', properties: { queued: num, replayed: num, failed: num } },

  // Security ------------------------------------------------------------------
  'security.step_up': { family: 'security', serverOnly: true, properties: { granted: bool, method: oneOf('password', 'totp', 'passkey') } },
  'security.authorization_denied': { family: 'security', serverOnly: true, properties: { route: oneOf('records', 'work', 'imports', 'correspondence', 'studio', 'metrics', 'reports', 'org', 'auth', 'admin', 'ai', 'other') } },

  // Data quality ----------------------------------------------------------------
  'quality.record_missing_measure': { family: 'quality', serverOnly: true, properties: { missing: oneOf('quantity', 'outcome', 'area', 'unit') } },
  'quality.duplicate_suspected': { family: 'quality', serverOnly: true, properties: { candidates: num } },
};

export interface IncomingEvent {
  name: string;
  properties?: Record<string, unknown>;
  form_ms?: unknown;
  active_editor_ms?: unknown;
  confirmed_work_minutes?: unknown;
  occurred_at?: unknown;
  unit_id?: unknown;
}

export interface RejectedEvent { name: string; reason: string }
export interface IngestResult { accepted: number; rejected: RejectedEvent[] }

/** A duration only counts if it is a finite, non-negative number inside a sane bound. */
function duration(value: unknown, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * Validates one event's properties against its spec. Undeclared keys and wrong-typed values are
 * dropped rather than coerced: a value that does not match the declaration is not a value, and
 * guessing at what the caller meant is how content leaks into an analytics table.
 */
export function validateProperties(spec: EventSpec, input: Record<string, unknown> | undefined): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, declared] of Object.entries(spec.properties)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (declared.kind === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.round(n * 1000) / 1000;
    } else if (declared.kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      else if (value === 'true' || value === 'false') out[key] = value === 'true';
    } else if (declared.kind === 'enum') {
      const text = String(value);
      if (declared.values?.includes(text)) out[key] = text;
    }
  }
  return out;
}

const MAX_FORM_MS = 12 * 60 * 60 * 1000;
const MAX_WORK_MINUTES = 24 * 60;

export interface Actor { id: string | null; sessionId?: string | null }

/**
 * Takes a batch from a client, keeps what the catalog allows, and says what it dropped and why.
 * A rejected event is never a failed request: telemetry must never block a person's work.
 */
export function ingest(ctx: AppContext, actor: Actor, events: IncomingEvent[], origin: 'client' | 'server' = 'client'): IngestResult {
  const rejected: RejectedEvent[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const receivedAt = now();

  for (const event of events.slice(0, 200)) {
    const name = String(event?.name || '');
    const spec = EVENTS[name];
    if (!spec) { rejected.push({ name, reason: 'not in the event catalog' }); continue; }
    if (spec.serverOnly && origin !== 'server') { rejected.push({ name, reason: 'this event is raised by the server, not by a client' }); continue; }

    const properties = validateProperties(spec, event.properties as Record<string, unknown> | undefined);
    const allowed = new Set(spec.times || []);
    rows.push({
      id: newId(),
      name,
      user_id: actor.id,
      unit_id: typeof event.unit_id === 'string' ? event.unit_id.slice(0, 64) : null,
      session_id: actor.sessionId || null,
      origin,
      properties: JSON.stringify(properties),
      form_ms: allowed.has('form_ms') ? duration(event.form_ms, MAX_FORM_MS) : null,
      active_editor_ms: allowed.has('active_editor_ms') ? duration(event.active_editor_ms, MAX_FORM_MS) : null,
      confirmed_work_minutes: allowed.has('confirmed_work_minutes') ? duration(event.confirmed_work_minutes, MAX_WORK_MINUTES) : null,
      // A device clock can be wrong or forged, so a client time outside a day of now is not trusted.
      occurred_at: plausibleTime(event.occurred_at, receivedAt) || receivedAt,
      received_at: receivedAt,
    });
  }

  if (rows.length) {
    const insert = ctx.db.prepare(
      `INSERT INTO product_events (id, name, user_id, unit_id, session_id, origin, properties, form_ms, active_editor_ms, confirmed_work_minutes, occurred_at, received_at)
       VALUES (@id, @name, @user_id, @unit_id, @session_id, @origin, @properties, @form_ms, @active_editor_ms, @confirmed_work_minutes, @occurred_at, @received_at)`
    );
    ctx.db.transaction(() => { for (const row of rows) insert.run(row); })();
  }
  return { accepted: rows.length, rejected };
}

function plausibleTime(value: unknown, receivedAt: string): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const received = Date.parse(receivedAt);
  if (Math.abs(at - received) > 24 * 60 * 60 * 1000) return null;
  return new Date(at).toISOString();
}

/** Raised by the server itself, where the fact is known accurately and a client could lie about it. */
export function record(ctx: AppContext, name: string, properties: Record<string, unknown>, actor: Actor = { id: null }) {
  try {
    ingest(ctx, actor, [{ name, properties }], 'server');
  } catch {
    // Measurement never breaks the thing it measures.
  }
}
