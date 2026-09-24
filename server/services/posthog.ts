/**
 * Optional forwarding of the product-event pipeline to PostHog, for the synthetic demo only.
 *
 * The owner wants to see what visitors to the public demo actually do: which screens they reach,
 * which steps of the flagship case they finish, and where they stop. PostHog answers that well. It
 * is also a third party, and the contract Vantage is built to (§24) rules out session replay,
 * keystroke capture and broad DOM telemetry, and keeps free text, document numbers and records out
 * of usage telemetry. So this is a sink on the closed catalog in telemetry.ts, not a second pipeline:
 *
 *  - It forwards rows that are already in product_events, and nothing else. An event PostHog sees
 *    was declared in the catalog, validated against it, and stored on this server first. There is
 *    no PostHog script in the browser, so nothing a visitor types, clicks or hovers over reaches
 *    PostHog unless the catalog names it; there is no autocapture, heatmap, replay or survey.
 *  - It runs only with VANTAGE_ACCESS_MODE=demo, where every person and record is synthetic, and
 *    only when VANTAGE_POSTHOG_KEY is set. config.ts refuses the key in accounts mode.
 *  - Visitors are pseudonymous. The PostHog id is a keyed hash of the demo workspace, so it cannot be
 *    joined back to anything, and person profiles and GeoIP lookups are switched off per event. The
 *    request comes from this server, so a visitor's IP address never reaches PostHog.
 *  - It reads committed rows by rowid, so an event inside a transaction that later rolled back is
 *    never sent, and it resumes where it left off after a restart.
 *  - It never gets in the way. A failed send is retried on the next tick a few times and then
 *    dropped; the demo works the same with PostHog unreachable or egress blocked.
 */

import { createHmac } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { EVENTS, validateProperties } from './telemetry.ts';

const MARK = 'posthog_forwarded_rowid';
const BATCH = 200;
const MAX_ATTEMPTS = 3;

interface Row {
  rowid: number; name: string; user_id: string | null; properties: string;
  form_ms: number | null; confirmed_work_minutes: number | null; occurred_at: string;
}
interface Visitor { workspace: string; created_at: string; persona: 'marine' | 'leader' | null }

export interface ForwardResult { sent: number; skipped: number; dropped: number; failed: boolean }

/** A stable, unlinkable id for one demo workspace: the same visitor across both personas. */
export function pseudonym(secret: string, workspaceId: string): string {
  return `demo-${createHmac('sha256', secret).update(`posthog:visitor:${workspaceId}`).digest('base64url').slice(0, 24)}`;
}

/**
 * A UUIDv7 for the visit, which PostHog uses to group events into a session: the workspace's
 * creation time, and keyed-hash bits where v7 puts randomness. Deterministic, so a restart does
 * not split a visit in two.
 */
export function visitSessionId(secret: string, workspaceId: string, createdAt: string): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Math.max(0, Date.parse(createdAt) || 0), 0, 6);
  createHmac('sha256', secret).update(`posthog:session:${workspaceId}`).digest().copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function visitorOf(ctx: AppContext, userId: string | null): Visitor | null {
  if (!userId) return null;
  const row = ctx.db.prepare(
    `SELECT w.id, w.created_at, w.persona_user_id, w.leader_user_id FROM users u JOIN demo_workspaces w ON w.id = u.demo_workspace_id WHERE u.id = ?`
  ).get(userId) as { id: string; created_at: string; persona_user_id: string; leader_user_id: string } | undefined;
  if (!row) return null;
  return { workspace: row.id, created_at: row.created_at, persona: userId === row.persona_user_id ? 'marine' : userId === row.leader_user_id ? 'leader' : null };
}

/** Maps one stored event to a PostHog event, or null when it is not a visitor's. */
export function toPostHogEvent(ctx: AppContext, row: Row) {
  const spec = EVENTS[row.name];
  if (!spec) return null;
  const visitor = visitorOf(ctx, row.user_id);
  if (!visitor) return null;
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(row.properties || '{}'); } catch { /* treated as no properties */ }
  // Validated again on the way out: only what the catalog declares for this event leaves.
  const properties: Record<string, unknown> = {
    ...validateProperties(spec, stored),
    distinct_id: pseudonym(ctx.config.secret, visitor.workspace),
    $session_id: visitSessionId(ctx.config.secret, visitor.workspace, visitor.created_at),
    $process_person_profile: false,
    $geoip_disable: true,
    $lib: 'vantage-server',
    family: spec.family,
    persona: visitor.persona,
  };
  if (row.form_ms != null && spec.times?.includes('form_ms')) properties.form_ms = row.form_ms;
  if (row.confirmed_work_minutes != null && spec.times?.includes('confirmed_work_minutes')) properties.confirmed_work_minutes = row.confirmed_work_minutes;

  let event = row.name;
  if (row.name === 'surface.viewed' && typeof properties.surface === 'string') {
    // A screen view becomes PostHog's page view, so its paths and drop-off views work. The path is
    // the surface's name, never a real URL: no record id, document number or query string.
    event = '$pageview';
    properties.$pathname = `/${properties.surface}`;
    properties.$current_url = `${ctx.config.publicUrl}/${properties.surface}`;
  }
  return { event, properties, timestamp: row.occurred_at };
}

/**
 * Where forwarding resumes. The first time it is switched on it starts from now: what was measured
 * before that stays on this server.
 */
function startMark(ctx: AppContext): number {
  const stored = metaGet(ctx.db, MARK);
  const mark = Number(stored);
  if (stored != null && Number.isFinite(mark)) return mark;
  const start = (ctx.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM product_events').get() as { n: number }).n;
  metaSet(ctx.db, MARK, String(start));
  return start;
}

/**
 * Sends the next batch of stored events. Exported for tests; the scheduler in app.ts calls it.
 * `attempts` is how many ticks in a row the current batch has failed.
 */
export async function forwardPending(ctx: AppContext, state: { attempts: number }, send: typeof fetch = fetch): Promise<ForwardResult> {
  const cfg = ctx.config.posthog;
  const result: ForwardResult = { sent: 0, skipped: 0, dropped: 0, failed: false };
  if (!cfg) return result;

  const mark = startMark(ctx);
  const rows = ctx.db.prepare(
    `SELECT rowid, name, user_id, properties, form_ms, confirmed_work_minutes, occurred_at FROM product_events WHERE rowid > ? ORDER BY rowid LIMIT ${BATCH}`
  ).all(mark) as Row[];
  if (!rows.length) return result;

  const batch = [];
  for (const row of rows) {
    const event = toPostHogEvent(ctx, row);
    if (event) batch.push(event); else result.skipped++;
  }
  const last = rows[rows.length - 1].rowid;
  if (!batch.length) { metaSet(ctx.db, MARK, String(last)); return result; }

  try {
    const res = await send(`${cfg.host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: cfg.key, batch }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`PostHog answered ${res.status}`);
    result.sent = batch.length;
    state.attempts = 0;
    metaSet(ctx.db, MARK, String(last));
  } catch {
    result.failed = true;
    state.attempts++;
    if (state.attempts >= MAX_ATTEMPTS) {
      // Measurement never piles up behind an outage. The events are still in product_events.
      result.dropped = batch.length;
      state.attempts = 0;
      metaSet(ctx.db, MARK, String(last));
    }
  }
  return result;
}

/** Starts the forwarding loop when PostHog is configured. Returns a stop function, or null. */
export function startPostHogForwarding(ctx: AppContext, everyMs = 10_000): (() => void) | null {
  if (!ctx.config.posthog) return null;
  startMark(ctx);
  const state = { attempts: 0 };
  let running = false;
  let warned = false;
  console.log(`PostHog forwarding on: catalogued demo events only, to ${ctx.config.posthog.host}`);
  const tick = () => {
    if (running) return;
    running = true;
    forwardPending(ctx, state)
      .then((r) => {
        if (r.failed && !warned) { warned = true; console.warn('PostHog is unreachable. Events stay on this server; forwarding retries and then skips.'); }
        if (!r.failed) warned = false;
      })
      .catch(() => { /* forwarding never throws into the app */ })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
