import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { seedRoles, addMember, ownerRoleId } from './org.ts';
import { resealAuditChain } from './audit.ts';
import { HttpError } from '../lib/errors.ts';
import { formatCents } from '../../shared/money.ts';
import { UMT_2WAY, UMT_FORMULA, PROCEDURES } from '../../shared/procedures.ts';
import { sealBacklog } from './caseSeal.ts';

/**
 * The synthetic demonstration.
 *
 * Every visitor gets their own disposable workspace: one synthetic section, six synthetic Marines,
 * and a few weeks of synthetic work history. Nobody signs in; the visitor is handed the persona of
 * one of those Marines and can switch to the section lead. Nothing here is real and nothing here
 * can reach something real:
 *
 *   - demo mode is refused in production and refused on a database that holds real accounts;
 *   - a database created for the demo is marked as one, and an accounts-mode server refuses it;
 *   - the people here have no password, no email, and no operator authority;
 *   - workspaces are isolated by membership, the same scope every other read goes through;
 *   - each workspace is removed whole when it expires.
 *
 * The names are neutral inventions. Document numbers start with SYN so nobody mistakes one for a
 * real award, and no DODAAC, contract number or dollar figure here belongs to anything real.
 */

export const DEMO_UNIT_NAME = 'G-8 Budget Execution (synthetic)';
export const DEMO_UNIT_SHORT = 'G-8 BE';
export const FLAGSHIP_REFERENCE = 'SYN-26-P-0047';

/** Values a Marine would read off DAI during the flagship walkthrough. Shown only in demo mode, labelled synthetic. */
export const FLAGSHIP_SYSTEM_VALUES = {
  reference: FLAGSHIP_REFERENCE,
  note: 'In real work these are read from DAI.',
  values: [
    { field: 'current_award', label: 'Current award amount', display: '$91,250.00' },
    { field: 'invoice_amount', label: 'Invoice SYN-INV-0047-1', display: '$45,000.00', reference: 'SYN-INV-0047-1' },
    { field: 'invoice_amount', label: 'Invoice SYN-INV-0047-2', display: '$44,725.00', reference: 'SYN-INV-0047-2' },
    { field: 'requisition_funding', label: 'Requisition funding available', display: '$1,500.00' },
  ],
  scenario: 'In this synthetic scenario the analyst chooses to amend the requisition. That choice is the scenario, not a rule Vantage applies.',
} as const;

interface Person { key: string; first: string; last: string; rank: string; role: string; billet: string }
const PEOPLE: Person[] = [
  { key: 'marine', first: 'Jordan', last: 'Avery', rank: 'LCpl', role: 'marine', billet: 'Budget analyst' },
  { key: 'chen', first: 'Riley', last: 'Chen', rank: 'Cpl', role: 'nco', billet: 'Budget analyst' },
  { key: 'patel', first: 'Sam', last: 'Patel', rank: 'LCpl', role: 'marine', billet: 'Budget analyst' },
  { key: 'nguyen', first: 'Taylor', last: 'Nguyen', rank: 'Cpl', role: 'marine', billet: 'Budget analyst' },
  { key: 'brooks', first: 'Casey', last: 'Brooks', rank: 'PFC', role: 'marine', billet: 'Budget analyst' },
  { key: 'leader', first: 'Morgan', last: 'Diaz', rank: 'SSgt', role: 'sncoic', billet: 'Section SNCOIC' },
];

export const PERSONAS = {
  marine: { label: 'Marine', description: 'A budget analyst working the queue' },
  leader: { label: 'Section lead', description: 'Sees the section’s workload and assigns work' },
} as const;
export type Persona = keyof typeof PERSONAS;

/** A small seeded generator, so every workspace tells the same story and a board demo is repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const DAY = 86_400_000;
const isoAt = (daysAgo: number, hour = 14, minute = 0) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};
const dayOffset = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const docNumber = (n: number) => `SYN-26-P-${String(n).padStart(4, '0')}`;
const condition = (open: number) => `2WAY PO MATCH PO open Qty ${open} is less than the DCAS qty ${open + 1}`;

/* ── Database guard ────────────────────────────────────────────────────────────────────────── */

/**
 * Called at startup. A database is either a demo database or a real one, decided when it is first
 * used, and each mode refuses the other kind. This is what stops a misconfigured demo from opening
 * a real database without sign-in, and stops a real server from running on synthetic data.
 */
export function assertDatabaseMatchesMode(ctx: AppContext) {
  const flagged = metaGet(ctx.db, 'demo_database') === '1';
  if (ctx.config.accessMode === 'demo') {
    if (flagged) return;
    const real = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE demo_workspace_id IS NULL').get() as { n: number }).n;
    if (real > 0) {
      throw new Error('VANTAGE_ACCESS_MODE=demo was pointed at a database that holds real accounts. The synthetic demo needs its own database: set VANTAGE_DB to a new path (or :memory:).');
    }
    metaSet(ctx.db, 'demo_database', '1');
    return;
  }
  if (flagged) {
    throw new Error('This database was created for the synthetic demo and holds only synthetic data. Point VANTAGE_DB at the real database, or start with VANTAGE_ACCESS_MODE=demo.');
  }
}

const assertDemo = (ctx: AppContext) => {
  if (ctx.config.accessMode !== 'demo' || metaGet(ctx.db, 'demo_database') !== '1') throw new Error('Demo operations only run on a demo database in demo mode.');
};

/* ── Workspaces ────────────────────────────────────────────────────────────────────────────── */

export interface WorkspaceRow { id: string; unit_id: string; persona_user_id: string; leader_user_id: string; created_at: string; last_used_at: string; expires_at: string }

export function workspaceOf(ctx: AppContext, userId: string): WorkspaceRow | null {
  return (ctx.db.prepare('SELECT w.* FROM demo_workspaces w JOIN users u ON u.demo_workspace_id = w.id WHERE u.id = ?').get(userId) as WorkspaceRow | undefined) || null;
}

export function personaOf(ws: WorkspaceRow, userId: string): Persona | null {
  if (userId === ws.persona_user_id) return 'marine';
  if (userId === ws.leader_user_id) return 'leader';
  return null;
}

export function demoStatus(ctx: AppContext, userId?: string | null) {
  const ws = userId ? workspaceOf(ctx, userId) : null;
  return {
    mode: 'demo' as const,
    ttl_hours: ctx.config.demo.ttlHours,
    workspace: ws ? { expires_at: ws.expires_at, persona: personaOf(ws, userId!) } : null,
    personas: PERSONAS,
    flagship: FLAGSHIP_SYSTEM_VALUES,
  };
}

/** Creates a fresh workspace and returns the Marine persona's user id. */
export function createWorkspace(ctx: AppContext): WorkspaceRow {
  assertDemo(ctx);
  purgeExpired(ctx);
  const live = (ctx.db.prepare('SELECT COUNT(*) AS n FROM demo_workspaces').get() as { n: number }).n;
  if (live >= ctx.config.demo.maxWorkspaces) {
    throw new HttpError(503, 'The demo is at capacity right now. Try again in a little while.', 'demo_full');
  }
  const wsId = randomBytes(6).toString('hex');
  const unitId = `DEMO-${wsId.toUpperCase()}`;
  const at = now();
  const expires = new Date(Date.now() + ctx.config.demo.ttlHours * 3_600_000).toISOString();
  const ids: Record<string, string> = {};

  ctx.db.transaction(() => {
    const unusable = `demo-no-password$${createHash('sha256').update(randomBytes(16)).digest('hex')}`;
    for (const p of PEOPLE) {
      ids[p.key] = newId();
      ctx.db.prepare(
        `INSERT INTO users (id, username, email, password_hash, first_name, last_name, rank_id, mos, is_operator, demo_workspace_id, prefs, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, '3451', 0, ?, ?, ?, ?)`
      ).run(ids[p.key], `demo-${wsId}-${p.key}`, unusable, p.first, p.last, p.rank, wsId, JSON.stringify({ onboardingDone: true }), at, at);
    }
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(unitId, unitId, DEMO_UNIT_NAME, DEMO_UNIT_SHORT, 'section', at);
    ctx.db.prepare('INSERT INTO demo_workspaces (id, unit_id, persona_user_id, leader_user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(wsId, unitId, ids.marine, ids.leader, at, at, expires);
    seedRoles(ctx, unitId);
    ctx.db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ids.leader, unitId);
    for (const p of PEOPLE) {
      addMember(ctx, ids[p.key], unitId, { primary: true, billet: p.billet });
      const roleId = p.role === 'sncoic' ? ownerRoleId(unitId) : `${unitId}:${p.role}`;
      if (p.role !== 'marine') ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(ids[p.key], roleId, unitId, ids.leader, at);
    }
    const workIds = seedWork(ctx, unitId, ids);
    const balanceIds = seedOpenBalances(ctx, unitId, ids);
    seedPersonalRecord(ctx, unitId, ids);
    // The seeded histories were written directly, so they are sealed here, as a whole, before anyone sees them.
    sealBacklog(ctx, [...workIds, ...balanceIds]);
  })();
  return ctx.db.prepare('SELECT * FROM demo_workspaces WHERE id = ?').get(wsId) as WorkspaceRow;
}

/* ── Synthetic work ────────────────────────────────────────────────────────────────────────── */

interface SeedItem { n: number; open: number; umtCents: number; awardCents: number; invoices: number[]; due: string; createdAt: string }

function seedWork(ctx: AppContext, unitId: string, ids: Record<string, string>): string[] {
  const rand = rng(47);
  const cents = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100);
  const importedAt = isoAt(34, 13);
  const secondBatchAt = isoAt(6, 9);
  const at = now();

  // The tasker the section lead set up for this quarter's UMT review.
  const projectId = newId();
  ctx.db.prepare(
    `INSERT INTO projects (id, user_id, unit_id, visibility, name, description, status, priority, progress, start_date, target_date, organization, version, created_at, updated_at)
     VALUES (?, ?, ?, 'unit', ?, ?, 'active', 'high', 0, ?, ?, 'G-8', 1, ?, ?)`
  ).run(projectId, ids.leader, unitId, 'FY26 Q4 2-Way UMT review',
    'Clear the 2-Way unmatched transactions on the Q4 report. Claim an item, research it in DAI, and record what you find.',
    dayOffset(-34), dayOffset(21), importedAt, at);

  // Every item came off one synthetic sheet, kept as it arrived.
  const items: SeedItem[] = [];
  for (let n = 1; n <= 93; n++) {
    const umt = n === 47 ? 430_000 : cents(300, 9_000);
    const award = n === 47 ? 9_125_000 : cents(20_000, 150_000);
    const invoices = n === 47 ? [4_500_000, 4_472_500] : [cents(5_000, 60_000), ...(rand() > 0.5 ? [cents(2_000, 40_000)] : [])];
    const dueIn = n === 47 ? 5 : n <= 76 ? -Math.floor(rand() * 20) - 1 : Math.floor(rand() * 25) - 3;
    // The second batch arrived last week, so the section has new work as well as old.
    items.push({ n, open: 1 + Math.floor(rand() * 9), umtCents: umt, awardCents: award, invoices, due: dayOffset(dueIn), createdAt: n >= 83 ? secondBatchAt : importedAt });
  }
  const header = ['Document Number', 'Condition', 'UMT Amount', 'Due Date', 'Office'];
  const csv = [header.join(','), ...items.map((i) => [docNumber(i.n), `"${condition(i.open)}"`, (i.umtCents / 100).toFixed(2), i.due, 'SYN-OFFICE-1'].join(','))].join('\n');
  const buffer = Buffer.from(csv);
  const sourceId = newId();
  const jobId = newId();
  ctx.db.prepare(
    `INSERT INTO source_files (id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, scan_detail, scanner, scanned_at, content, created_at)
     VALUES (?, ?, ?, 'unit', 'FY26-Q4-2WAY-UMT (synthetic).csv', 'text/csv', 'delimited', ?, ?, 'skipped', 'Synthetic demo file; no scanner runs in the demo.', 'none', ?, ?, ?)`
  ).run(sourceId, ids.leader, unitId, buffer.length, createHash('sha256').update(buffer).digest('hex'), importedAt, buffer, importedAt);
  ctx.db.prepare(
    `INSERT INTO import_jobs (id, source_file_id, user_id, unit_id, visibility, sheet_name, header_row, mapping, key_columns, status, total_rows, processed_rows, inserted_rows, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'unit', 'FY26-Q4-2WAY-UMT (synthetic).csv', 1, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, sourceId, ids.leader, unitId,
    JSON.stringify({ 'Document Number': 'reference', Condition: 'title', 'UMT Amount': 'amount', 'Due Date': 'due_date', Office: 'keep' }),
    JSON.stringify(['Document Number']), items.length, items.length, items.length, importedAt, importedAt, importedAt, importedAt);

  const insertItem = ctx.db.prepare(
    `INSERT INTO work_items (id, unit_id, owner_id, visibility, source_file_id, import_job_id, natural_key, row_hash, source_row, title, reference, due_date,
                             amount, amount_type, state, stage, data, project_id, procedure_key, procedure_version, version, created_at, updated_at)
     VALUES (?, ?, ?, 'unit', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', 'not_started', ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertEvent = ctx.db.prepare(
    `INSERT INTO work_events (id, work_item_id, unit_id, actor_id, kind, step, subject_id, body, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let tick = 0;
  const ev = (itemId: string, actor: string | null, kind: string, occurredAt: string, body: Record<string, unknown> = {}, step: string | null = null, subject: string | null = null) => {
    // created_at orders the history; keep it in step with the synthetic timeline.
    tick += 1;
    const created = new Date(Date.parse(occurredAt) + (tick % 1000)).toISOString();
    const eventId = newId();
    insertEvent.run(eventId, itemId, unitId, actor, kind, step, subject, JSON.stringify(body), occurredAt, created);
    return eventId;
  };
  const obs = (field: string, label: string, value: number, extra: Record<string, unknown> = {}) =>
    ({ field, label, amount_cents: value, currency: 'USD', display: formatCents(value), source: 'manual_observation', system: 'DAI', ...extra });

  const itemIds = new Map<number, string>();
  const umtEvent = new Map<number, string>();
  for (const i of items) {
    const id = newId();
    itemIds.set(i.n, id);
    const data = { 'Document Number': docNumber(i.n), Condition: condition(i.open), 'UMT Amount': (i.umtCents / 100).toFixed(2), 'Due Date': i.due, Office: 'SYN-OFFICE-1' };
    insertItem.run(id, unitId, ids.leader, sourceId, jobId, docNumber(i.n), createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32), i.n + 1,
      condition(i.open), docNumber(i.n), i.due, i.umtCents / 100, JSON.stringify(data), projectId, UMT_2WAY.key, UMT_2WAY.version, i.createdAt, i.createdAt);
    ev(id, ids.leader, 'created', i.createdAt, { origin: 'import', import_job_id: jobId, source_row: i.n + 1 });
    ev(id, ids.leader, 'procedure_applied', i.createdAt, { procedure: UMT_2WAY.key, version: UMT_2WAY.version, authority: UMT_2WAY.authority });
    umtEvent.set(i.n, ev(id, null, 'observation', i.createdAt, { field: 'umt_amount', label: 'UMT source amount', amount_cents: i.umtCents, currency: 'USD', display: formatCents(i.umtCents), source: 'source_file', system: 'Imported sheet' }, 'identify'));
  }

  const setItem = ctx.db.prepare(
    `UPDATE work_items SET claimed_by = ?, claimed_at = ?, state = ?, stage = ?, waiting_category = ?, waiting_since = ?, blocked_reason = ?, resolved_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`
  );

  /**
   * One person's pass at an item, from claim to wherever they stopped. Each step is its own event,
   * so the history distinguishes research, a submission, what the system reported, and verification.
   */
  const research = new Map<number, { awardId: string; invoiceIds: string[] }>();
  const work = (n: number, who: string, daysAgo: number, until: 'researched' | 'submitted' | 'resolved', handFrom?: string) => {
    const id = itemIds.get(n)!;
    const i = items[n - 1];
    const t = (hours: number) => isoAt(Math.max(daysAgo - hours / 24, 0.02), 13 + (hours % 6));
    // Someone taking over a handed-off item picks up where it was left; they do not re-read the award.
    let awardId = research.get(n)?.awardId;
    let invoiceIds = research.get(n)?.invoiceIds || [];
    if (!handFrom) {
      ev(id, who, 'claimed', t(0));
      awardId = ev(id, who, 'observation', t(1), obs('current_award', 'Current award amount', i.awardCents), 'research_award');
      invoiceIds = i.invoices.map((inv, k) => ev(id, who, 'observation', t(1.5 + k * 0.2), obs('invoice_amount', 'Invoice amount', inv, { reference: `SYN-INV-${String(n).padStart(4, '0')}-${k + 1}` }), 'research_award'));
      research.set(n, { awardId: awardId!, invoiceIds });
    }
    if (until === 'researched') return id;
    const invoiceTotal = i.invoices.reduce((a, b) => a + b, 0);
    const target = invoiceTotal + i.umtCents;
    const adjustment = target - i.awardCents;
    ev(id, who, 'observation', t(1.8), obs('requisition_funding', 'Requisition funding available', Math.max(adjustment, 0) + 50_000), 'record_funding');
    ev(id, who, 'calculation', t(1.9), {
      ok: true, formula: UMT_FORMULA.key, version: UMT_FORMULA.version, title: UMT_FORMULA.title, formula_text: UMT_FORMULA.text, applicability: UMT_FORMULA.applicability, source: 'calculated',
      inputs: [
        { event_id: awardId, field: 'current_award', label: 'Current award', cents: i.awardCents, source: 'manual_observation' },
        ...invoiceIds.map((eid, k) => ({ event_id: eid, field: 'invoice_amount', label: `Invoice ${k + 1}`, cents: i.invoices[k], source: 'manual_observation' })),
        { event_id: umtEvent.get(n), field: 'umt_amount', label: 'UMT source amount', cents: i.umtCents, source: 'source_file' },
      ],
      invoice_total_cents: invoiceTotal, umt_amount_cents: i.umtCents, current_award_cents: i.awardCents, target_award_cents: target, adjustment_cents: adjustment,
      direction: adjustment > 0 ? 'upward' : adjustment === 0 ? 'zero' : 'downward', requires_review: adjustment <= 0,
      display: `${formatCents(adjustment, { signed: true })} (target ${formatCents(target)})`,
    }, 'calculate');
    ev(id, who, 'decision', t(2), { decision: 'funding_decision', choice: 'funding_sufficient', rationale: 'Requisition shows enough available funding for the modification.' }, 'funding_decision');
    ev(id, who, 'funds_check', t(2.5), { result: 'PASSED', system: 'DAI' });
    ev(id, who, 'action_prepared', t(2.8), { reference: `SYN-MOD-${n}` }, 'award_modification');
    ev(id, who, 'action_submitted', t(3), { reference: `SYN-MOD-${n}`, funds_check_result: 'PASSED' }, 'submit_modification');
    if (until === 'submitted') return id;
    ev(id, who, 'external_event', t(4), { event: 'approved', system: 'DAI' }, 'submit_modification');
    ev(id, who, 'external_event', t(5), { event: 'posted', system: 'DAI' }, 'submit_modification');
    ev(id, who, 'action_submitted', t(5.2), { reference: `SYN-N1081-${n}` }, 'non1081_match');
    ev(id, who, 'verification', t(5.5), { check: 'invoice_posted', result: 'verified', reference: `DAI invoice status, SYN-INV-${String(n).padStart(4, '0')}-1` }, 'verify_invoice');
    ev(id, who, 'verification', t(5.8), { check: 'condition_cleared', result: 'verified', reference: 'Q4 UMT report: line no longer listed' }, 'verify_cleared');
    ev(id, who, 'stage_changed', t(6), { from: 'verification_required', to: 'resolved', reason: 'Verified cleared.' });
    ev(id, who, 'resolved', t(6), { reason: 'Verified cleared.' });
    setItem.run(null, null, 'resolved', 'resolved', null, null, null, t(6), t(6), id);
    return id;
  };

  // Recorded research in the last four weeks: Avery 39 documents, Chen 30, Patel 27, Nguyen and
  // Brooks none. Items 34-38 moved from Avery to Chen and 52-61 from Chen to Patel, so the section
  // counts 81 distinct documents while the individual totals add up to 96.
  const handOn = (n: number, from: string, to: string, daysAgo: number, note: string) => {
    work(n, from, daysAgo, 'researched');
    ev(itemIds.get(n)!, from, 'handed_off', isoAt(daysAgo - 0.3, 16), { note, from }, null, to);
    work(n, to, daysAgo - 0.5, 'resolved', from);
  };
  for (let n = 1; n <= 33; n++) work(n, ids.marine, 27 - (n % 26), 'resolved');
  for (let n = 34; n <= 38; n++) handOn(n, ids.marine, ids.chen, 20 - (n % 12), 'Award and invoices recorded. Funding decision next.');
  // Item 47 is the flagship: nobody has touched it, so the walkthrough starts from a clean case.
  for (let n = 39; n <= 51; n++) if (n !== 47) work(n, ids.chen, 26 - (n % 24), 'resolved');
  for (let n = 52; n <= 61; n++) handOn(n, ids.chen, ids.patel, 22 - (n % 18), 'Research done. Needs the modification submitted.');
  for (let n = 62; n <= 76; n++) work(n, ids.patel, 25 - (n % 22), 'resolved');

  // Work still in flight, so the section has something waiting, blocked, and awaiting verification.
  const inFlight = (n: number, who: string, stage: 'waiting' | 'blocked' | 'verification_required' | 'researching', daysAgo: number, detail: { category?: string; reason?: string } = {}) => {
    const id = work(n, who, daysAgo, stage === 'researching' ? 'researched' : 'submitted');
    const since = isoAt(Math.max(daysAgo - 0.2, 0.05), 15);
    if (stage === 'waiting') {
      ev(id, who, 'stage_changed', since, { from: 'submitted', to: 'waiting', reason: null });
      ev(id, who, 'waiting_started', since, { category: detail.category, expected_by: null });
    } else if (stage === 'blocked') {
      ev(id, who, 'stage_changed', since, { from: 'submitted', to: 'blocked', reason: detail.reason });
    } else if (stage === 'verification_required') {
      ev(id, who, 'external_event', since, { event: 'approved', system: 'DAI' }, 'submit_modification');
      ev(id, who, 'external_event', since, { event: 'posted', system: 'DAI' }, 'submit_modification');
      ev(id, who, 'action_submitted', since, { reference: `SYN-N1081-${n}` }, 'non1081_match');
      ev(id, who, 'stage_changed', since, { from: 'submitted', to: 'verification_required', reason: null });
    }
    const state = stage === 'waiting' || stage === 'blocked' ? 'waiting' : 'in_progress';
    setItem.run(who, isoAt(daysAgo, 13), state, stage, stage === 'waiting' ? detail.category : null, stage === 'waiting' ? since : null, stage === 'blocked' ? detail.reason : null, null, since, id);
  };
  inFlight(77, ids.chen, 'waiting', 6, { category: 'posting' });
  inFlight(78, ids.chen, 'waiting', 3, { category: 'posting' });
  inFlight(79, ids.chen, 'verification_required', 2);
  inFlight(80, ids.patel, 'blocked', 4, { reason: 'Vendor invoice copy is not in EDA yet.' });
  inFlight(81, ids.patel, 'waiting', 2, { category: 'approval' });
  inFlight(82, ids.marine, 'researching', 1);
  // Items 47 and 83-93 are unassigned and waiting to be claimed.

  // A task the section lead gave Avery, and one for the lead to decide.
  const task = ctx.db.prepare(
    `INSERT INTO tasks (id, user_id, assignee_id, unit_id, visibility, project_id, title, notes, status, priority, due_date, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'unit', ?, ?, ?, 'planned', ?, ?, 1, ?, ?)`
  );
  task.run(newId(), ids.leader, ids.marine, unitId, projectId, 'Send Q4 UMT status notes to SSgt Diaz', 'Two lines on what is waiting and why.', 'high', dayOffset(3), at, at);
  task.run(newId(), ids.leader, ids.leader, unitId, projectId, 'Decide who takes the overdue unassigned UMTs', null, 'high', dayOffset(1), at, at);

  const note = ctx.db.prepare('INSERT INTO notifications (id, user_id, kind, title, message, action_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  note.run(newId(), ids.marine, 'work', 'Twelve UMTs are waiting to be claimed', 'FY26 Q4 2-Way UMT review', '/work', isoAt(0.2, 12));
  note.run(newId(), ids.marine, 'work', `${docNumber(33)} is resolved`, 'Verified cleared on the Q4 UMT report.', `/work/items/${itemIds.get(33)}`, isoAt(1, 15));
  return [...itemIds.values()];
}

/* ── Synthetic open balances: one of each FMRA condition ───────────────────────────────────── */

interface BalanceSeed {
  n: number; condition: string; procedure: string; method: string | null;
  c: number | null; o: number | null; d: number | null; p: number | null;
  error?: string; umt?: number; due: number; holder?: string; stage?: 'researching' | 'waiting'; waitOn?: string;
}

/**
 * A second tasker: the quarter's open balances, one document per condition the FMRAC teaches, each
 * already under its procedure with the figures the sheet carried seeded as source-file facts. Nobody
 * has researched these yet, so the section's contribution counts are unchanged by them.
 */
function seedOpenBalances(ctx: AppContext, unitId: string, ids: Record<string, string>): string[] {
  const at = now();
  const importedAt = isoAt(3, 10);
  const projectId = newId();
  ctx.db.prepare(
    `INSERT INTO projects (id, user_id, unit_id, visibility, name, description, status, priority, progress, start_date, target_date, organization, version, created_at, updated_at)
     VALUES (?, ?, ?, 'unit', ?, ?, 'active', 'medium', 0, ?, ?, 'G-8', 1, ?, ?)`
  ).run(projectId, ids.leader, unitId, 'FY26 Q4 open balances review',
    'Open commitments, undelivered and delivered orders, travel orders, holds and UMTs from the synthetic OAS export. Each is under the FMRA procedure for its condition.',
    dayOffset(-3), dayOffset(25), importedAt, at);
  const $ = (v: number | null) => (v == null ? null : Math.round(v * 100));
  const seeds: BalanceSeed[] = [
    { n: 101, condition: 'OCMT', procedure: 'ocmt_research', method: 'gpc', c: 2450, o: null, d: null, p: null, due: 6 },
    { n: 102, condition: 'OCMT', procedure: 'ocmt_research', method: 'contract', c: 18000, o: 15200, d: 15200, p: 15200, due: 9 },
    { n: 103, condition: 'OCMT', procedure: 'ocmt_research', method: 'mipr', c: 32000, o: null, d: null, p: null, due: 4, holder: 'marine', stage: 'researching' },
    { n: 104, condition: 'UDOU', procedure: 'udou_research', method: 'gcss', c: 6812.4, o: 6812.4, d: null, p: null, due: 12 },
    { n: 105, condition: 'UDOU', procedure: 'udou_research', method: 'contract', c: 40000, o: 40000, d: 22500, p: 22500, due: 8, holder: 'chen', stage: 'researching' },
    { n: 106, condition: 'DOU', procedure: 'dou_research', method: 'gpc', c: 1275, o: 1275, d: 1275, p: null, due: 5 },
    { n: 107, condition: 'DOU', procedure: 'dou_research', method: 'mipr', c: 9900, o: 9900, d: 9900, p: 4950, due: 10, holder: 'patel', stage: 'waiting', waitOn: 'external_response' },
    { n: 108, condition: 'OTO', procedure: 'oto_research', method: 'tdy', c: null, o: 2130.55, d: null, p: null, due: 7 },
    { n: 109, condition: 'OTO', procedure: 'oto_research', method: 'tdy', c: null, o: 3480, d: 1740, p: 1740, due: 14 },
    { n: 110, condition: 'UMT', procedure: 'umt_four_stage', method: null, c: null, o: null, d: null, p: null, error: 'Billed AMT is greater than PO line AMT', umt: 1120, due: 3 },
    { n: 111, condition: 'UMT', procedure: 'umt_four_stage', method: null, c: null, o: null, d: null, p: null, error: 'Data elements do not match', umt: 845.1, due: 11 },
    { n: 112, condition: 'Invoice on hold', procedure: 'invoice_hold', method: null, c: null, o: null, d: null, p: null, error: 'Quantity billed exceeds quantity received', umt: 3300, due: 6 },
  ];
  const doc = (n: number) => `SYN-26-OB-${String(n).padStart(4, '0')}`;
  const titleOf = (s: BalanceSeed) => (s.error ? `${s.condition}: ${s.error}` : `${s.condition} on a ${s.method ? s.method.toUpperCase() : 'document'}`);
  const header = ['Document Number', 'Condition', 'Method', 'Commitment', 'Obligation', 'Delivered', 'Paid', 'Error', 'Amount', 'Due Date'];
  const cell = (v: number | null) => (v == null ? '-' : v.toFixed(2));
  const rows = seeds.map((s) => [doc(s.n), titleOf(s), s.method || '', cell(s.c), cell(s.o), cell(s.d), cell(s.p), s.error || '', s.umt == null ? '' : s.umt.toFixed(2), dayOffset(s.due)]);
  const csv = [header, ...rows].map((r) => r.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const buffer = Buffer.from(csv);
  const sourceId = newId();
  const jobId = newId();
  ctx.db.prepare(
    `INSERT INTO source_files (id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, scan_detail, scanner, scanned_at, content, created_at)
     VALUES (?, ?, ?, 'unit', 'FY26-Q4-open-balances (synthetic).csv', 'text/csv', 'delimited', ?, ?, 'skipped', 'Synthetic demo file; no scanner runs in the demo.', 'none', ?, ?, ?)`
  ).run(sourceId, ids.leader, unitId, buffer.length, createHash('sha256').update(buffer).digest('hex'), importedAt, buffer, importedAt);
  ctx.db.prepare(
    `INSERT INTO import_jobs (id, source_file_id, user_id, unit_id, visibility, sheet_name, header_row, mapping, key_columns, status, total_rows, processed_rows, inserted_rows, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'unit', 'FY26-Q4-open-balances (synthetic).csv', 1, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, sourceId, ids.leader, unitId,
    JSON.stringify({ 'Document Number': 'reference', Condition: 'title', Method: 'purchase_method', Commitment: 'commitment', Obligation: 'obligation', Delivered: 'delivered', Paid: 'paid', Error: 'error_text', Amount: 'amount', 'Due Date': 'due_date' }),
    JSON.stringify(['Document Number']), seeds.length, seeds.length, seeds.length, importedAt, importedAt, importedAt, importedAt);

  const insertItem = ctx.db.prepare(
    `INSERT INTO work_items (id, unit_id, owner_id, visibility, source_file_id, import_job_id, natural_key, row_hash, source_row, title, reference, due_date,
                             amount, amount_type, state, stage, data, project_id, procedure_key, procedure_version, version, created_at, updated_at)
     VALUES (?, ?, ?, 'unit', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', 'not_started', ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertEvent = ctx.db.prepare(
    `INSERT INTO work_events (id, work_item_id, unit_id, actor_id, kind, step, subject_id, body, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let tick = 0;
  const ev = (itemId: string, actor: string | null, kind: string, occurredAt: string, body: Record<string, unknown> = {}, step: string | null = null) => {
    tick += 1;
    insertEvent.run(newId(), itemId, unitId, actor, kind, step, null, JSON.stringify(body), occurredAt, new Date(Date.parse(occurredAt) + tick).toISOString());
  };
  const fromSheet = (field: string, label: string, cents: number | null) => (cents == null
    ? { field, label, not_shown: true, display: 'Not shown', value_text: null, source: 'source_file', system: 'Imported sheet' }
    : { field, label, amount_cents: cents, currency: 'USD', display: formatCents(cents), source: 'source_file', system: 'Imported sheet' });
  const setItem = ctx.db.prepare('UPDATE work_items SET claimed_by = ?, claimed_at = ?, state = ?, stage = ?, waiting_category = ?, waiting_since = ?, updated_at = ?, version = version + 1 WHERE id = ?');

  const out: string[] = [];
  seeds.forEach((s, i) => {
    const id = newId();
    out.push(id);
    const procedure = PROCEDURES[s.procedure];
    const data = Object.fromEntries(header.map((h, k) => [h, String(rows[i][k])]));
    insertItem.run(id, unitId, ids.leader, sourceId, jobId, doc(s.n), createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32), i + 2,
      titleOf(s), doc(s.n), dayOffset(s.due), s.umt ?? null, JSON.stringify(data), projectId, procedure.key, procedure.version, importedAt, importedAt);
    ev(id, ids.leader, 'created', importedAt, { origin: 'import', import_job_id: jobId, source_row: i + 2 });
    ev(id, ids.leader, 'procedure_applied', importedAt, { procedure: procedure.key, version: procedure.version, authority: procedure.authority });
    if (s.procedure.endsWith('_research')) {
      if (s.method) ev(id, null, 'observation', importedAt, { field: 'purchase_method', label: 'Purchase method', value_text: s.method, display: s.method === 'tdy' ? 'TDY / DTS' : s.method === 'gcss' ? 'GCSS-MC' : s.method === 'gpc' ? 'GPC' : s.method === 'mipr' ? 'MIPR' : 'Contract', source: 'source_file', system: 'Imported sheet' }, 'observe_balances');
      ev(id, null, 'observation', importedAt, fromSheet('commitment_amount', 'Commitment', $(s.c)), 'observe_balances');
      ev(id, null, 'observation', importedAt, fromSheet('obligation_amount', 'Obligation', $(s.o)), 'observe_balances');
      ev(id, null, 'observation', importedAt, fromSheet('delivered_amount', 'Delivered', $(s.d)), 'observe_balances');
      ev(id, null, 'observation', importedAt, fromSheet('paid_amount', 'Paid', $(s.p)), 'observe_balances');
    } else {
      ev(id, null, 'observation', importedAt, { field: 'error_text', label: s.procedure === 'invoice_hold' ? 'Hold reason as the report words it' : 'Exact error description from the report', value_text: s.error, display: s.error, source: 'source_file', system: 'Imported sheet' }, 'identify');
      const amountField = s.procedure === 'invoice_hold' ? ['hold_amount', 'Amount on hold'] : ['umt_amount', 'Unmatched amount'];
      ev(id, null, 'observation', importedAt, fromSheet(amountField[0], amountField[1], $(s.umt ?? null)), 'identify');
    }
    if (s.holder) {
      const who = ids[s.holder];
      const since = isoAt(1.5, 11);
      ev(id, who, 'claimed', isoAt(2, 9));
      ev(id, who, 'stage_changed', isoAt(2, 9), { from: 'not_started', to: 'researching', reason: null });
      if (s.stage === 'waiting') {
        ev(id, who, 'stage_changed', since, { from: 'researching', to: 'waiting', reason: 'Asked the performing agency for its bill.' });
        ev(id, who, 'waiting_started', since, { category: s.waitOn, expected_by: null });
      }
      setItem.run(who, isoAt(2, 9), s.stage === 'waiting' ? 'waiting' : 'in_progress', s.stage || 'researching', s.stage === 'waiting' ? s.waitOn : null, s.stage === 'waiting' ? since : null, since, id);
    }
  });
  return out;
}

/* ── The persona's own record ──────────────────────────────────────────────────────────────── */

function seedPersonalRecord(ctx: AppContext, unitId: string, ids: Record<string, string>) {
  const at = now();
  const me = ids.marine;
  const activity = ctx.db.prepare(
    `INSERT INTO activities (id, user_id, unit_id, visibility, date, title, category, quantity, unit_label, result, status, evidence_links, fingerprint, version, created_at, updated_at)
     VALUES (?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, 'completed', '[]', ?, 1, ?, ?)`
  );
  const entries: Array<[number, string, string, number | null, string | null, string]> = [
    [9, 'Volunteered at the base food pantry', 'Volunteer Service', 6, 'hours', 'Sorted and shelved the weekly delivery.'],
    [16, 'Completed Corporals Course DEP module 3', 'Training & PME', null, null, 'Module exam passed.'],
    [23, 'Led section PT: 10 km hike', 'Leadership', 10, 'km', 'Planned the route and the water points for eight Marines.'],
  ];
  for (const [days, title, category, qty, unitLabel, result] of entries) {
    activity.run(newId(), me, unitId, dayOffset(-days), title, category, qty, unitLabel, result, `demo:${title}`, at, at);
  }
  const training = ctx.db.prepare(
    `INSERT INTO trainings (id, user_id, unit_id, visibility, date, title, type, hours, provider, status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  training.run(newId(), me, unitId, dayOffset(-30), 'DAI requisition amendment desk training', 'course', 4, 'Section SNCOIC', 'completed', at, at);
  training.run(newId(), me, unitId, dayOffset(-16), 'Corporals Course DEP', 'pme', 12, 'MarineNet', 'in_progress', at, at);

  const goal = ctx.db.prepare(
    `INSERT INTO goals (id, user_id, unit_id, visibility, title, description, type, category, metric, current_value, target_value, unit_label, status, period_start, period_end,
                        direction, baseline_value, aggregation, filters, measure_scope, version, created_at, updated_at)
     VALUES (?, ?, ?, 'private', ?, ?, ?, ?, 'manual', ?, ?, ?, 'active', ?, ?, ?, ?, 'latest', '{}', 'subject', 1, ?, ?)`
  );
  goal.run(newId(), me, unitId, 'Complete Corporals Course DEP', 'Finish every module before the next promotion board.', 'developmental', 'Training & PME', 60, 100, '% complete', dayOffset(-30), dayOffset(45), 'increase', 0, at, at);
  goal.run(newId(), me, unitId, 'Raise PFT score to 270', 'Two run sessions and one strength session a week.', 'quarterly', 'Leadership', 245, 270, 'points', dayOffset(-20), dayOffset(70), 'increase', 238, at, at);

  ctx.db.prepare(
    `INSERT INTO readiness (user_id, pft_score, cft_score, rifle_qual, mcmap_belt, pme_complete, updated_at) VALUES (?, 245, 280, 'Sharpshooter', 'Grey', 'none', ?)`
  ).run(me, at);
  ctx.db.prepare('INSERT INTO career_profiles (user_id, military_goal, civilian_interests, updated_at) VALUES (?, ?, ?, ?)')
    .run(me, 'Pick up Corporal and qualify as a lead budget analyst.', 'Federal financial management and budget analysis.', at);
  const step = ctx.db.prepare(
    `INSERT INTO career_steps (id, user_id, title, category, status, due_date, notes, source_label, source_url, source_checked_on, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`
  );
  step.run(newId(), me, 'Finish Corporals Course DEP', 'pme', 'in_progress', dayOffset(45), 'Modules 4 and 5 left.', 'MarineNet course catalog', 'https://www.marinenet.usmc.mil', at, at);
  step.run(newId(), me, 'Collect Q4 JEPES supporting notes from verified work', 'evaluation', 'planned', dayOffset(20), 'Use the Record’s drafts; nothing is submitted automatically.', null, null, at, at);
  step.run(newId(), me, 'Ask SSgt Diaz what the lead analyst billet requires', 'military', 'planned', dayOffset(14), null, null, null, at, at);
  step.run(newId(), me, 'Look into the Certified Defense Financial Manager credential', 'certification', 'planned', null, 'Requirements and eligibility not checked yet.', 'American Society of Military Comptrollers', 'https://www.asmconline.org', at, at);
}

/* ── Removal ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Removes one workspace whole. Synthetic data only, and only on a demo database in demo mode.
 * Everything that hangs off the workspace's people and unit is found through the schema's own
 * foreign keys rather than a hand-kept list, so a table added later cannot be left behind.
 */
export function purgeWorkspace(ctx: AppContext, wsId: string) {
  assertDemo(ctx);
  const ws = ctx.db.prepare('SELECT * FROM demo_workspaces WHERE id = ?').get(wsId) as WorkspaceRow | undefined;
  if (!ws) return;
  const users = (ctx.db.prepare('SELECT id FROM users WHERE demo_workspace_id = ?').all(wsId) as Array<{ id: string }>).map((u) => u.id);
  const db = ctx.db;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const list = (xs: string[]) => xs.map(() => '?').join(',');
      // Rows that name the unit or the people without a foreign key.
      db.prepare(`DELETE FROM audit_log WHERE unit_id = ? OR actor_id IN (${list(users)}) OR subject_id IN (${list(users)})`).run(ws.unit_id, ...users, ...users);
      db.prepare(`DELETE FROM product_events WHERE unit_id = ? OR user_id IN (${list(users)})`).run(ws.unit_id, ...users);
      db.prepare('DELETE FROM demo_workspaces WHERE id = ?').run(wsId);
      db.prepare(`DELETE FROM users WHERE id IN (${list(users)})`).run(...users);
      db.prepare('DELETE FROM units WHERE id = ?').run(ws.unit_id);
      // Then everything that now points at something missing, until nothing does.
      for (let pass = 0; pass < 25; pass++) {
        const orphans = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number }>;
        if (!orphans.length) break;
        const byTable = new Map<string, number[]>();
        for (const o of orphans) byTable.set(o.table, [...(byTable.get(o.table) || []), o.rowid]);
        for (const [table, rowids] of byTable) {
          for (let i = 0; i < rowids.length; i += 400) {
            const chunk = rowids.slice(i, i + 400);
            db.prepare(`DELETE FROM "${table}" WHERE rowid IN (${list(chunk.map(String))})`).run(...chunk);
          }
        }
      }
      const left = db.pragma('foreign_key_check') as unknown[];
      if (left.length) throw new Error(`Demo workspace removal left ${left.length} dangling rows.`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  resealAuditChain(ctx);
}

export function purgeExpired(ctx: AppContext): number {
  if (ctx.config.accessMode !== 'demo') return 0;
  const expired = ctx.db.prepare('SELECT id FROM demo_workspaces WHERE expires_at < ?').all(now()) as Array<{ id: string }>;
  for (const ws of expired) purgeWorkspace(ctx, ws.id);
  return expired.length;
}

/** A small synthetic sheet a section lead can import during the demo, to see a tasker arrive. */
export function sampleSheet(): string {
  const rows = [['Document Number', 'Condition', 'UMT Amount', 'Due Date', 'Office']];
  for (let n = 101; n <= 110; n++) {
    rows.push([docNumber(n), condition(2 + (n % 5)), (1_200 + n * 17.5).toFixed(2), dayOffset(10 + (n % 7)), 'SYN-OFFICE-1']);
  }
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}
