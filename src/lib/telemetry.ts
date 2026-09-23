/**
 * The client half of the product-event pipeline.
 *
 * The server can see what it did. It cannot see a form somebody opened and closed, how long they sat
 * with it, or that a draft was abandoned at validation rather than at the save. Those are the facts
 * this file sends, and only those: an event carries a name and declared scalars, never anything a
 * person typed.
 *
 * Two things it will not do. It will not delay a person's work: events are queued and flushed in the
 * background, and a failed flush is dropped rather than retried forever. And it will not follow
 * anyone off this app: there is no third-party SDK here, no beacon to anywhere but this server.
 */

import * as api from './api.ts';

interface Queued {
  name: string;
  properties?: Record<string, unknown>;
  form_ms?: number;
  active_editor_ms?: number;
  confirmed_work_minutes?: number;
  occurred_at: string;
}

const queue: Queued[] = [];
const MAX_QUEUE = 200;
let timer: number | null = null;

/** Records one event. Returns immediately; the send happens later and may never happen at all. */
export function track(name: string, properties?: Record<string, unknown>, times?: { form_ms?: number; active_editor_ms?: number; confirmed_work_minutes?: number }) {
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ name, properties, ...times, occurred_at: new Date().toISOString() });
  schedule();
}

function schedule() {
  if (timer != null) return;
  timer = window.setTimeout(() => { timer = null; void flush(); }, 4000);
}

export async function flush(keepalive = false) {
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    await api.sendEvents(batch, keepalive);
  } catch {
    // A dropped batch is a dropped measurement, which is the correct trade against a retry storm.
  }
}

/** Flushes what is queued when the page goes away, so a closed tab is not a lost funnel. */
export function installTelemetry() {
  const onHidden = () => { if (document.visibilityState === 'hidden') void flush(true); };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', () => void flush(true));
  return () => document.removeEventListener('visibilitychange', onHidden);
}

/**
 * Times one capture from the moment it opened. Nothing is recorded unless the caller says how it
 * ended, so a timer that is simply forgotten records nothing at all.
 */
export function captureTimer(surface: string) {
  const openedAt = Date.now();
  track('capture.opened', { surface });
  let ended = false;
  return {
    completed(properties: Record<string, unknown> = {}, confirmedWorkMinutes?: number) {
      if (ended) return;
      ended = true;
      track('capture.completed', { surface, ...properties }, { form_ms: Date.now() - openedAt, confirmed_work_minutes: confirmedWorkMinutes });
    },
    abandoned(state: string, properties: Record<string, unknown> = {}) {
      if (ended) return;
      ended = true;
      track('capture.abandoned', { surface, state, ...properties }, { form_ms: Date.now() - openedAt });
    },
  };
}

/**
 * How long an editor was open. Nothing more.
 *
 * This used to also estimate "active editing" from the gaps between keystrokes. That is keystroke
 * timing tied to a person, which Vantage does not collect: an open tab is not labour, and typing
 * rhythm is not a measure of work. Only the time the form was open is kept, and it is never
 * presented as time worked. The duration a person states themselves is recorded separately.
 */
export function editorClock() {
  const startedAt = Date.now();
  return {
    /** Kept so callers need not change; records nothing. */
    beat() {},
    read() {
      return { form_ms: Date.now() - startedAt };
    },
  };
}
