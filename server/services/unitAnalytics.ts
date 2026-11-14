import type { AppContext, SessionUser } from '../context.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { audit, auditListedRecords } from './audit.ts';
import { PERMISSIONS, can, detailUnitsFor, subtreeIds, unitTree, type Scope } from '../authz/scope.ts';
import { getUnit } from './org.ts';
import { periodClause } from './timeframes.ts';
import { personnelRoster } from './personnelRecords.ts';
import { isAnonymizedDuty } from './duties.ts';
import { stageOf } from './cases.ts';
import {
  CASE_AGE_BANDS, ageOf, casesOf, isClosed, namesOf, personName, procedureLabel, requirementStandings, words, type CaseRow, type ReportTarget,
} from './reportCenter.ts';
import { STAGES, STAGE_LABEL, CLOSED_STAGES } from '../../shared/caseModel.ts';
import { DUTY_STATUS_LABELS, type DutyStatus } from '../../shared/duty.ts';
import { countedPoints } from '../../shared/dutyReview.ts';
import { DUE_SOON_DAYS } from '../../shared/reportCatalog.ts';
import {
  DRILL_LIMIT, drillOf, monthKeys, monthOf, tally,
  type AnalyticsResponse, type AnalyticsSection, type DrillRecord, type DrillResponse, type Membership, type SourceRecord, type VisualSpec,
} from '../../shared/unitAnalytics.ts';

/**
 * A unit's analytics (Task 21, ADR-0028): casework, duty, training and personnel, each a set of visuals drawn from the
 * records of the unit and the units beneath it that the reader may read, and the records behind any one figure.
 *
 * Who may read them is decided before anything is read: viewing the unit's shared records. The units beneath it are read
 * only where the reader views their records too, so a role that does not reach down (position 0) reads its own unit.
 * Only shared records count, never private ones or drafts. A record names a Marine only where the reader opens member
 * records in its unit, and a duty a retention schedule anonymized names nobody. Each read and each drill is audited.
 *
 * The figures and the drills are built from the same records (shared/unitAnalytics.ts), so a drill always lists what its
 * figure counts. Casework, the training standing and the roster are read through the report center's own readers, so a
 * figure here is the figure on the printed report.
 */

export interface AnalyticsWindow { from: string; to: string }
export interface DrillAsk { visual: string; key: string; series?: string | null }

/** A source record: what the drill lists, and whose it is for the audit trail. */
interface Source { drill: Omit<DrillRecord, 'value'>; user_id: string | null; unit_id: string | null; table: string | null; named: boolean }

interface Reading {
  ctx: AppContext; user: SessionUser; scope: Scope;
  unitId: string;
  /** The unit and those beneath it whose shared records the reader may read. */
  units: string[];
  /** Of those, the units where the reader may see figures by Marine. */
  detailIn: Set<string>;
  /** Figures by Marine in the unit itself. */
  detail: boolean;
  from: string; to: string;
  today: string;
  at: number;
  unitName: (id: string | null) => string | null;
}

interface Built { specs: VisualSpec[]; sources: Array<SourceRecord<Source>>; notes: string[] }

/** The most rows a section reads, as the report center does. */
const SCAN_LIMIT = 50_000;
const DAY_MS = 86_400_000;
const SECTION_TITLES: Record<AnalyticsSection, string> = { work: 'casework', duty: 'duty', training: 'training', personnel: 'personnel' };
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hoursText = (h: number) => `${Math.round(h * 10) / 10} h`;

function reading(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string, w: AnalyticsWindow): Reading {
  if (!getUnit(ctx, unitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You cannot view that unit’s analytics.');
  const tree = unitTree(ctx);
  const units = subtreeIds(ctx, unitId, tree).filter((u) => can(scope, PERMISSIONS.VIEW_RECORDS, u));
  const detailIn = new Set(units.filter((u) => can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, u)));
  const names = new Map<string, string | null>();
  const unitName = (id: string | null) => {
    if (!id) return null;
    if (!names.has(id)) {
      const u = ctx.db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(id) as { name: string; short_name: string | null } | undefined;
      names.set(id, u ? u.short_name || u.name : null);
    }
    return names.get(id) ?? null;
  };
  return { ctx, user, scope, unitId, units, detailIn, detail: detailIn.has(unitId), from: w.from, to: w.to, today: zonedDay(zoneOf(ctx, user)), at: Date.now(), unitName };
}

const sourceNote = (r: Reading) => {
  const beneath = r.units.length - 1;
  return `Drawn from what is shared with ${r.unitName(r.unitId) || 'the unit'}${beneath ? ` and the ${plural(beneath, 'unit')} beneath it you may read` : ''}. Private entries and drafts are never included.`;
};
const NO_DETAIL = 'Figures by Marine are left out: they need opening member records in this unit.';

// ——— Casework ———

const OPEN_STAGES = STAGES.filter((s) => !CLOSED_STAGES.has(s));

function buildWork(r: Reading): Built {
  const months = monthKeys(r.from, r.to);
  const target = { unitIds: r.units };
  // Open on any day of the window, and open now: the two reads the financial report makes (ADR-0020).
  const live = casesOf(r.ctx, target, {}, { from: r.from, to: r.to });
  const open = casesOf(r.ctx, target, {}).filter((c) => !isClosed(c));
  const openIds = new Set(open.map((c) => c.id));
  const liveIds = new Set(live.map((c) => c.id));
  const every = new Map<string, CaseRow>();
  for (const c of [...live, ...open]) if (!every.has(c.id)) every.set(c.id, c);
  const holders = namesOf(r.ctx, [...every.values()].filter((c) => r.detailIn.has(c.unit_id)).map((c) => c.claimed_by));
  const inWindow = (d: string | null) => Boolean(d && d >= r.from && d <= r.to);

  const specs: VisualSpec[] = [
    {
      id: 'work_now', question: 'Where does the casework stand?', kind: 'kpis', format: 'number', noun: 'case',
      keys: [
        { key: 'open', label: 'Open now' }, { key: 'amount_open', label: 'Amount open', format: 'money', hint: 'As each open case records it' },
        { key: 'overdue', label: 'Overdue now', hint: 'Open past the date it is due' }, { key: 'opened', label: 'Opened in the window' },
        { key: 'resolved', label: 'Resolved in the window' },
      ],
    },
    {
      id: 'work_age', question: 'How long have the open cases been open?', kind: 'bars', format: 'number', noun: 'case',
      keys: CASE_AGE_BANDS.map((b) => ({ key: b.key, label: b.label })), note: 'Every case open today, counted from the day it was opened.',
    },
    {
      id: 'work_flow', question: 'Are cases being closed as fast as they arrive?', kind: 'columns', format: 'number', noun: 'case', keys: months,
      series: [{ key: 'opened', label: 'Opened', tone: 'accent' }, { key: 'closed', label: 'Closed', tone: 'neutral' }],
      note: 'Opened counts a case in the month it was opened; closed, in the month it was resolved or found not to apply.',
    },
    {
      id: 'work_dollars', question: 'How much money was resolved each month?', kind: 'columns', format: 'money', noun: 'case', keys: months,
      note: 'The amount each resolved case records, in the month it was resolved. A case does not say what kind of amount it holds.',
    },
    {
      id: 'work_stage', question: 'Where are the open cases waiting?', kind: 'bars', format: 'number', noun: 'case',
      keys: OPEN_STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s] })),
    },
    {
      id: 'work_rate', question: 'How many of the window’s cases were resolved?', kind: 'rate', format: 'number', noun: 'case',
      keys: [{ key: 'resolved', label: 'Resolved in the window' }, { key: 'not_resolved', label: 'Not resolved in it' }],
      note: 'Of the cases open on any day of the window, those resolved in it: the financial report’s resolution rate.',
    },
  ];

  const sources: Array<SourceRecord<Source>> = [];
  for (const c of every.values()) {
    const amount = Number(c.amount) || 0;
    const created = day(c.created_at);
    const closed = isClosed(c) ? day(c.closed_at) : null;
    const resolvedAt = day(c.resolved_at);
    const resolvedIn = liveIds.has(c.id) && stageOf(c as never) === 'resolved' && Boolean(resolvedAt) && resolvedAt! <= r.to;
    const m: Membership[] = [];
    if (openIds.has(c.id)) {
      m.push({ visual: 'work_now', key: 'open', value: 1 }, { visual: 'work_now', key: 'amount_open', value: amount });
      if (c.due_date && c.due_date < r.today) m.push({ visual: 'work_now', key: 'overdue', value: 1 });
      const band = CASE_AGE_BANDS.find((b) => b.test(ageOf(c, r.at)));
      if (band) m.push({ visual: 'work_age', key: band.key, value: 1 });
      m.push({ visual: 'work_stage', key: stageOf(c as never), value: 1 });
    }
    if (liveIds.has(c.id) && created && created >= r.from) m.push({ visual: 'work_now', key: 'opened', value: 1 });
    if (resolvedIn) m.push({ visual: 'work_now', key: 'resolved', value: 1 });
    if (inWindow(created)) m.push({ visual: 'work_flow', key: created!.slice(0, 7), series: 'opened', value: 1 });
    if (inWindow(closed)) m.push({ visual: 'work_flow', key: closed!.slice(0, 7), series: 'closed', value: 1 });
    if (resolvedIn && inWindow(resolvedAt)) m.push({ visual: 'work_dollars', key: resolvedAt!.slice(0, 7), value: amount });
    if (liveIds.has(c.id)) m.push({ visual: 'work_rate', key: resolvedIn ? 'resolved' : 'not_resolved', value: 1 });
    if (!m.length) continue;
    sources.push({
      record: {
        drill: {
          id: c.id, kind: 'case', title: c.title, detail: [procedureLabel(c), c.reference].filter(Boolean).join(' · ') || null, date: created,
          who: r.detailIn.has(c.unit_id) && c.claimed_by ? holders.get(c.claimed_by) || null : null, unit: r.unitName(c.unit_id),
          status: STAGE_LABEL[stageOf(c as never)] || null, to: `/work/items/${encodeURIComponent(c.id)}`,
        },
        user_id: null, unit_id: c.unit_id, table: null, named: false,
      },
      in: m,
    });
  }
  return {
    specs, sources,
    notes: [sourceNote(r), 'Open now, the amount open, overdue and age are as of today. Amounts are added as each case records them.'],
  };
}

// ——— Duty ———

interface DutyRow {
  id: string; user_id: string; unit_id: string; duty_type_id: string; title: string | null; location: string | null; notes: string | null;
  date: string; end_date: string; hours: number; days: number; approval_status: DutyStatus; approved_points: number | null; submitted_at: string;
}

const WAIT_BANDS: ReadonlyArray<{ key: string; label: string; test: (d: number) => boolean }> = [
  { key: 'under_3', label: 'Under 3 days', test: (d) => d < 3 },
  { key: 'from_3_to_7', label: '3 to 7 days', test: (d) => d >= 3 && d <= 7 },
  { key: 'from_8_to_30', label: '8 to 30 days', test: (d) => d > 7 && d <= 30 },
  { key: 'over_30', label: 'Over 30 days', test: (d) => d > 30 },
];

function buildDuty(r: Reading): Built {
  const units = JSON.stringify(r.units);
  const columns = 't.id, t.user_id, t.unit_id, t.duty_type_id, t.title, t.location, t.notes, t.date, t.end_date, t.hours, t.days, t.approval_status, t.approved_points, t.submitted_at';
  const span = periodClause('duties', 't', r.from, r.to);
  // Duty is always a unit record (ADR-0023). What was stood in the window, and what waits for review now whenever it was stood.
  const stood = r.ctx.db.prepare(`SELECT ${columns} FROM duties t WHERE t.unit_id IN (SELECT value FROM json_each(?)) AND t.deleted_at IS NULL AND ${span.sql} ORDER BY t.date DESC LIMIT ${SCAN_LIMIT}`).all(units, ...span.params) as DutyRow[];
  const waiting = r.ctx.db.prepare(`SELECT ${columns} FROM duties t WHERE t.unit_id IN (SELECT value FROM json_each(?)) AND t.deleted_at IS NULL AND t.approval_status = 'pending' ORDER BY t.submitted_at LIMIT ${SCAN_LIMIT}`).all(units) as DutyRow[];
  const stoodIds = new Set(stood.map((d) => d.id));
  const waitingIds = new Set(waiting.map((d) => d.id));
  const every = new Map<string, DutyRow>();
  for (const d of [...stood, ...waiting]) if (!every.has(d.id)) every.set(d.id, d);
  const named = (d: DutyRow) => !isAnonymizedDuty(d) && r.detailIn.has(d.unit_id);
  const marines = namesOf(r.ctx, [...every.values()].filter(named).map((d) => d.user_id));
  const typeIds = JSON.stringify([...new Set([...every.values()].map((d) => d.duty_type_id))]);
  const types = new Map((r.ctx.db.prepare('SELECT id, name FROM duty_types WHERE id IN (SELECT value FROM json_each(?))').all(typeIds) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  const months = monthKeys(r.from, r.to);

  const specs: VisualSpec[] = [
    {
      id: 'duty_now', question: 'How much duty is being stood, and how much counts yet?', kind: 'kpis', format: 'number', noun: 'duty',
      keys: [
        { key: 'recorded', label: 'Duty in the window' }, { key: 'hours', label: 'Hours stood', format: 'hours' },
        { key: 'approved_points', label: 'Approved points', hint: 'Only approved duty counts, at its approved points' },
        { key: 'waiting', label: 'Awaiting review now', hint: 'Whenever it was stood' },
      ],
    },
    {
      id: 'duty_load', question: r.detail ? 'Who is carrying the duty load?' : 'Which units are carrying the duty load?', kind: 'bars', format: 'hours', noun: 'duty',
      note: r.detail ? 'Hours of duty each Marine stood in the window. Counts show what was recorded, not effort.' : `Hours of duty stood in each unit in the window. ${NO_DETAIL}`,
    },
    { id: 'duty_type', question: 'What duty is being stood?', kind: 'bars', format: 'number', noun: 'duty', note: 'Duty in the window, by the duty type the Unit Instance set.' },
    { id: 'duty_months', question: 'How many hours of duty each month?', kind: 'columns', format: 'hours', noun: 'duty', keys: months, note: 'A duty across a month’s end counts in the first month of the window it touches.' },
    {
      id: 'duty_wait', question: 'How long has duty waited for review?', kind: 'bars', format: 'number', noun: 'duty',
      keys: WAIT_BANDS.map((b) => ({ key: b.key, label: b.label })), note: 'Duty awaiting review today, counted from the day it was submitted.',
    },
    {
      id: 'duty_rate', question: 'How much of the window’s duty is approved?', kind: 'rate', format: 'number', noun: 'duty',
      keys: [{ key: 'approved', label: 'Approved' }, { key: 'not_approved', label: 'Awaiting review, returned or rejected' }],
    },
  ];

  const sources: Array<SourceRecord<Source>> = [];
  for (const d of every.values()) {
    const m: Membership[] = [];
    const hours = Number(d.hours) || 0;
    if (stoodIds.has(d.id)) {
      m.push({ visual: 'duty_now', key: 'recorded', value: 1 }, { visual: 'duty_now', key: 'hours', value: hours });
      if (d.approval_status === 'approved') m.push({ visual: 'duty_now', key: 'approved_points', value: countedPoints(d) });
      if (r.detail) {
        // A duty a retention schedule anonymized counts and names nobody; one in a unit the reader cannot see by Marine, likewise.
        if (isAnonymizedDuty(d)) m.push({ visual: 'duty_load', key: '__anonymized', label: 'Anonymized by a retention schedule', value: hours });
        else if (!r.detailIn.has(d.unit_id)) m.push({ visual: 'duty_load', key: '__unnamed', label: 'In units you cannot see by Marine', value: hours });
        else m.push({ visual: 'duty_load', key: `marine:${d.user_id}`, label: marines.get(d.user_id) || 'A Marine', value: hours });
      } else {
        m.push({ visual: 'duty_load', key: `unit:${d.unit_id}`, label: r.unitName(d.unit_id) || 'A unit', value: hours });
      }
      m.push({ visual: 'duty_type', key: d.duty_type_id, label: types.get(d.duty_type_id) || 'A duty type', value: 1 });
      m.push({ visual: 'duty_months', key: monthOf(d.date, r.from), value: hours });
      m.push({ visual: 'duty_rate', key: d.approval_status === 'approved' ? 'approved' : 'not_approved', value: 1 });
    }
    if (waitingIds.has(d.id)) {
      m.push({ visual: 'duty_now', key: 'waiting', value: 1 });
      const waited = Math.max(0, Math.floor((r.at - Date.parse(d.submitted_at)) / DAY_MS));
      const band = WAIT_BANDS.find((b) => b.test(waited));
      if (band) m.push({ visual: 'duty_wait', key: band.key, value: 1 });
    }
    const who = named(d) ? marines.get(d.user_id) || null : null;
    sources.push({
      record: {
        drill: {
          id: d.id, kind: 'duty', title: [types.get(d.duty_type_id) || 'Duty', isAnonymizedDuty(d) ? null : d.title].filter(Boolean).join(' · '),
          detail: `${hoursText(hours)} · ${plural(Number(d.days) || 1, 'day')}`, date: d.date, who, unit: r.unitName(d.unit_id),
          status: DUTY_STATUS_LABELS[d.approval_status] || words(d.approval_status), to: null,
        },
        user_id: d.user_id, unit_id: d.unit_id, table: 'duties', named: Boolean(who),
      },
      in: m,
    });
  }
  const anonymous = stood.filter((d) => isAnonymizedDuty(d)).length;
  return {
    specs, sources,
    notes: [
      sourceNote(r), 'An entry that spans more than one period counts in each period it touches (ADR-0018).',
      'Only approved duty counts, at its approved points (ADR-0024).',
      ...(r.detail ? [] : [NO_DETAIL]),
      ...(anonymous ? [`${anonymous === 1 ? 'One duty' : `${anonymous} duties`} a retention schedule anonymized ${anonymous === 1 ? 'counts' : 'count'} in the figures and ${anonymous === 1 ? 'names' : 'name'} nobody.`] : []),
    ],
  };
}

// ——— Training ———

const STANDING_SERIES = [
  { key: 'met', label: 'Met', tone: 'good' as const }, { key: 'due_soon', label: 'Due soon', tone: 'warn' as const },
  { key: 'overdue', label: 'Past due', tone: 'bad' as const }, { key: 'missing', label: 'No record', tone: 'muted' as const },
];

interface TrainingRow { id: string; user_id: string; unit_id: string; title: string; type: string | null; hours: number | null; date: string | null; status: string | null; provider: string | null }

function buildTraining(r: Reading): Built {
  const span = periodClause('trainings', 't', r.from, r.to);
  const rows = r.ctx.db.prepare(`SELECT t.id, t.user_id, t.unit_id, t.title, t.type, t.hours, t.date, t.status, t.provider FROM trainings t
      WHERE t.unit_id IN (SELECT value FROM json_each(?)) AND t.visibility = 'unit' AND t.deleted_at IS NULL AND ${span.sql}
      ORDER BY t.date DESC LIMIT ${SCAN_LIMIT}`).all(JSON.stringify(r.units), ...span.params) as TrainingRow[];
  const names = namesOf(r.ctx, rows.filter((x) => r.detailIn.has(x.unit_id)).map((x) => x.user_id));
  // The requirement standing as the training report reads it, over the units read here (ADR-0020).
  const target: ReportTarget = { type: 'training', subject: 'unit', userId: null, unitId: r.unitId, unitIds: r.units, detail: r.detail, files: [] };
  const { orgId, requirements, standings } = requirementStandings(r.ctx, target, r.today);
  const months = monthKeys(r.from, r.to);

  const specs: VisualSpec[] = [
    {
      id: 'training_now', question: 'How much training is being done?', kind: 'kpis', format: 'number', noun: 'course',
      keys: [{ key: 'courses', label: 'Courses in the window' }, { key: 'hours', label: 'Training hours', format: 'hours' }, { key: 'marines', label: 'Marines who trained', noun: 'Marine' }],
    },
    {
      id: 'training_rate', question: 'Are Marines current on required training?', kind: 'rate', format: 'number', noun: 'standing', drill: r.detail,
      keys: [{ key: 'current', label: 'Met or due soon' }, { key: 'behind', label: 'Past due or no record' }],
      note: `Each Marine against each requirement that applies to them, today. Due soon is due again within ${DUE_SOON_DAYS} days.`,
    },
    {
      id: 'training_standing', question: 'Which requirements are falling behind?', kind: 'bars', format: 'number', noun: 'Marine', drill: r.detail,
      keys: requirements.map((q) => ({ key: q.id, label: q.title })), series: STANDING_SERIES,
      note: 'No record means no such course was shared, not that none was taken.',
    },
    { id: 'training_months', question: 'How many training hours each month?', kind: 'columns', format: 'hours', noun: 'course', keys: months, note: 'A course across a month’s end counts in the first month of the window it touches.' },
    { id: 'training_type', question: 'What kinds of training?', kind: 'bars', format: 'number', noun: 'course' },
  ];

  const sources: Array<SourceRecord<Source>> = [];
  // Marines who trained are Marines, each once, with what they did in the window: the drill lists them, not a course.
  const trained = new Map<string, { unit_id: string; courses: number; hours: number }>();
  for (const t of rows) {
    const hours = Number(t.hours) || 0;
    const m: Membership[] = [
      { visual: 'training_now', key: 'courses', value: 1 }, { visual: 'training_now', key: 'hours', value: hours },
      { visual: 'training_months', key: monthOf(t.date, r.from), value: hours },
      { visual: 'training_type', key: t.type || 'none', label: words(t.type) || 'No type', value: 1 },
    ];
    const mine = trained.get(t.user_id) || { unit_id: t.unit_id, courses: 0, hours: 0 };
    mine.courses += 1; mine.hours += hours; trained.set(t.user_id, mine);
    const who = r.detailIn.has(t.unit_id) ? names.get(t.user_id) || null : null;
    sources.push({
      record: {
        drill: { id: t.id, kind: 'training', title: t.title, detail: [words(t.type), t.hours == null ? null : hoursText(hours), t.provider].filter(Boolean).join(' · ') || null, date: day(t.date), who, unit: r.unitName(t.unit_id), status: words(t.status), to: null },
        user_id: t.user_id, unit_id: t.unit_id, table: 'trainings', named: Boolean(who),
      },
      in: m,
    });
  }
  // A Marine the reader may not see by name is listed under a number, not their account id, which the roster would name.
  let unnamed = 0;
  const unnamedId = () => `unnamed-${++unnamed}`;
  for (const [id, x] of trained) {
    const who = r.detailIn.has(x.unit_id) ? names.get(id) || null : null;
    sources.push({
      record: {
        drill: { id: who ? id : unnamedId(), kind: 'marine', title: who || 'A Marine', detail: `${plural(x.courses, 'course')} · ${hoursText(x.hours)}`, date: null, who: null, unit: r.unitName(x.unit_id), status: null, to: null },
        user_id: id, unit_id: x.unit_id, table: 'trainings', named: Boolean(who),
      },
      in: [{ visual: 'training_now', key: 'marines', value: 1 }],
    });
  }
  for (const x of standings) {
    // A standing names its Marine where the reader opens member records in a unit of theirs, and is then a list of
    // that Marine's training, audited as one.
    const seenIn = x.p.units.find((u) => r.detailIn.has(u)) ?? null;
    const seen = Boolean(seenIn);
    const status = x.s.status;
    sources.push({
      record: {
        drill: {
          id: seen ? `${x.r.id}:${x.p.id}` : `${x.r.id}:${unnamedId()}`, kind: 'marine', title: seen ? x.p.name : 'A Marine', detail: x.r.title, date: x.s.last, who: null, unit: x.p.team,
          status: STANDING_SERIES.find((s) => s.key === status)?.label || null, to: null,
        },
        user_id: x.p.id, unit_id: seenIn, table: 'trainings', named: seen,
      },
      in: [
        { visual: 'training_standing', key: x.r.id, series: status, value: 1 },
        { visual: 'training_rate', key: status === 'met' || status === 'due_soon' ? 'current' : 'behind', value: 1 },
      ],
    });
  }
  return {
    specs: orgId ? specs : specs.filter((s) => s.id !== 'training_rate' && s.id !== 'training_standing'),
    sources,
    notes: [
      sourceNote(r),
      ...(orgId ? ['A requirement is met by a completed course with its title, or with its course code in the title.'] : ['Not in a Unit Instance, so no training requirements apply.']),
      ...(r.detail ? [] : [`${NO_DETAIL} The standing shows counts only.`]),
    ],
  };
}

// ——— Personnel ———

function buildPersonnel(r: Reading): Built {
  // The roster as the Roster page and the personnel report read it (ADR-0017), so its count is theirs: each Marine
  // once at their own team, a deactivated account only for whoever manages it.
  const roster = personnelRoster(r.ctx, r.scope, r.user.id, r.unitId).rows;
  const soon = zonedDay(zoneOf(r.ctx, r.user), 90);
  const grades = new Map<string, { label: string; sort: number }>();
  for (const p of roster) {
    const key = p.rank_grade || 'none';
    if (!grades.has(key)) grades.set(key, { label: p.rank_grade ? `${p.rank_grade}${p.rank_abbr ? ` (${p.rank_abbr})` : ''}` : 'No grade recorded', sort: p.rank_grade ? p.rank_sort ?? 0 : -1 });
  }
  const specs: VisualSpec[] = [
    {
      id: 'people_now', question: 'Who is on the roster, and where are the gaps?', kind: 'kpis', format: 'number', noun: 'Marine',
      keys: [
        { key: 'marines', label: 'On the roster' }, { key: 'no_supervisor', label: 'No supervisor named' },
        { key: 'no_billet', label: 'No billet' }, { key: 'ending', label: 'Assignment ends in 90 days' },
      ],
    },
    {
      id: 'people_grade', question: 'What grades make up the unit?', kind: 'bars', format: 'number', noun: 'Marine',
      keys: [...grades.entries()].sort((a, b) => b[1].sort - a[1].sort).map(([key, g]) => ({ key, label: g.label })),
    },
    { id: 'people_team', question: 'How are Marines spread across the teams?', kind: 'bars', format: 'number', noun: 'Marine', note: 'Each Marine once, on their own team beneath the unit.' },
    { id: 'people_mos', question: 'Which MOSs does the unit hold?', kind: 'bars', format: 'number', noun: 'Marine' },
  ];
  const sources: Array<SourceRecord<Source>> = roster.map((p) => {
    const m: Membership[] = [
      { visual: 'people_now', key: 'marines', value: 1 },
      { visual: 'people_grade', key: p.rank_grade || 'none', value: 1 },
      { visual: 'people_team', key: p.assignment.unit_id, label: p.team_label, value: 1 },
      { visual: 'people_mos', key: p.mos || 'none', label: p.mos || 'No MOS recorded', value: 1 },
    ];
    if (!p.supervisor) m.push({ visual: 'people_now', key: 'no_supervisor', value: 1 });
    if (!p.assignment.billet) m.push({ visual: 'people_now', key: 'no_billet', value: 1 });
    // Ends within 90 days and has not ended yet.
    if (p.assignment.assignment_end && p.assignment.assignment_end >= r.today && p.assignment.assignment_end <= soon) m.push({ visual: 'people_now', key: 'ending', value: 1 });
    return {
      record: {
        drill: {
          id: p.id, kind: 'marine', title: personName(p), detail: [p.assignment.billet, p.mos].filter(Boolean).join(' · ') || null, date: p.assignment.assignment_start,
          who: null, unit: p.team_label, status: [p.status === 'deactivated' ? 'Deactivated' : null, p.supervisor ? null : 'No supervisor'].filter(Boolean).join(' · ') || null, to: p.canOpenRecords && !p.self ? `/team/${encodeURIComponent(p.id)}` : null,
        },
        user_id: null, unit_id: null, table: null, named: false,
      },
      in: m,
    };
  });
  return { specs, sources, notes: [`The roster of ${r.unitName(r.unitId) || 'the unit'} as its Roster page shows it to you: each Marine once, at their own team. Opening a Marine needs opening member records in their unit.`] };
}

const BUILDERS: Record<AnalyticsSection, (r: Reading) => Built> = { work: buildWork, duty: buildDuty, training: buildTraining, personnel: buildPersonnel };

/** A section's figures for a unit, with no record and no name in them. Audited. */
export function unitAnalytics(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string, section: AnalyticsSection, w: AnalyticsWindow, ip?: string | null): AnalyticsResponse {
  const r = reading(ctx, user, scope, unitId, w);
  const built = BUILDERS[section](r);
  audit(ctx, { actor_id: user.id, action: 'view_unit_analytics', entity: 'unit', entity_id: unitId, unit_id: unitId, detail: `${section};${w.from}..${w.to}`, ip });
  return { unit_id: unitId, section, from: w.from, to: w.to, as_of: r.today, units: r.units.length, detail: r.detail, visuals: tally(built.specs, built.sources), notes: built.notes };
}

/**
 * The records one figure counts: the same records the figure was added up from, filtered to its bar. Refused where the
 * figure lists no records to this reader (the training standing without opening member records). Audited, and a list of
 * other Marines' duty or training is audited as such too.
 */
export function unitAnalyticsDrill(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string, section: AnalyticsSection, w: AnalyticsWindow, ask: DrillAsk, ip?: string | null): DrillResponse {
  const r = reading(ctx, user, scope, unitId, w);
  const built = BUILDERS[section](r);
  const spec = built.specs.find((s) => s.id === ask.visual);
  if (!spec) throw notFound(`No such figure in the ${SECTION_TITLES[section]} analytics.`);
  if (spec.drill === false) throw forbidden('Listing who stands where needs opening member records in this unit.');
  const visual = tally([spec], built.sources)[0];
  const bucket = visual.buckets.find((b) => b.key === ask.key);
  const series = ask.series ? visual.series.find((s) => s.key === ask.series) : null;
  if (!bucket || (ask.series && !series)) throw notFound('No such figure.');
  const found = drillOf(built.sources, ask.visual, ask.key, ask.series ?? null);
  found.records.sort((a, b) => String(b.record.drill.date || '').localeCompare(String(a.record.drill.date || '')) || b.value - a.value);
  const shown = found.records.slice(0, DRILL_LIMIT);
  // A link to a Marine's record only where the reader may open it, as the member page decides (detailUnitsFor).
  const openable = new Map<string, boolean>();
  const opens = (id: string) => { if (!openable.has(id)) openable.set(id, id !== user.id && detailUnitsFor(ctx, scope, id).length > 0); return openable.get(id)!; };
  const records: DrillRecord[] = shown.map(({ record, value }) => ({
    ...record.drill, value,
    to: record.drill.to ?? (record.named && record.user_id && opens(record.user_id) ? `/team/${encodeURIComponent(record.user_id)}` : null),
  }));
  const label = [bucket.label, series && visual.series.length > 1 ? series.label : null].filter(Boolean).join(' · ');
  audit(ctx, {
    actor_id: user.id, action: 'drill_unit_analytics', entity: 'unit', entity_id: unitId, unit_id: unitId,
    detail: `${section}:${ask.visual}:${ask.key}${ask.series ? `:${ask.series}` : ''};${w.from}..${w.to};${found.records.length} records`, ip,
  });
  for (const table of ['duties', 'trainings']) {
    const listed = shown.filter((x) => x.record.table === table && x.record.named).map((x) => ({ user_id: x.record.user_id, unit_id: x.record.unit_id }));
    if (listed.length) auditListedRecords(ctx, user.id, table, listed, ip);
  }
  return {
    unit_id: unitId, section, visual: ask.visual, key: ask.key, series: series ? series.key : null, label,
    format: bucket.format || spec.format, noun: bucket.noun || spec.noun, count: found.records.length, value: found.value, records,
  };
}
