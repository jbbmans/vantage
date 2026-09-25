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
    /* ignore */
  }
}

export function installTelemetry() {
  const onHidden = () => { if (document.visibilityState === 'hidden') void flush(true); };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', () => void flush(true));
  return () => document.removeEventListener('visibilitychange', onHidden);
}

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
