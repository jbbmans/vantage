import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { errorReportTypesOf } from '../../server/services/unitConfig.ts';
import { DRILL_DATA_SQL, OVERVIEW_COUNTS_SQL, OVERVIEW_LATEST_SQL, SEEN_SQL, SERIES_HISTORY_SQL } from '../../server/services/errorReports.ts';
import {
  PERSISTENT_REPORTS, ageOf, compareRows, inDrill, summarize,
  type ComparisonResult, type Drill, type DrillResult, type ErrorReportPreview, type ErrorReportsOverview, type SeriesFacts, type SnapshotRow,
} from '../../shared/errorReports.ts';

/**
 * Error reports at the size a unit keeps them for years: a series' history is read for the identifiers on the
 * two reports compared, not for every report the series has had, and gives exactly the figures the whole history gives;
 * the rows behind a figure go out a page at a time, cut only after the checks and filters; the overview reads counts
 * and the latest two reports of each series. The reads use the indexes their plans name, with planner statistics in
 * place, as production collects them (PRAGMA optimize).
 */

let app: TestApp;
let op: { token: string; id: string };
let ulo: string;
let ocmt: string;
let g1ulo: string;

const D = today();
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const get = (path: string) => app.call('GET', path, { token: op.token });
const qs = (params: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]): [string, string] => [k, String(v)])).toString();

// ——— A series of 34 weekly reports, some withdrawn between them, and the identifiers whose history matters ———

/** A small seeded generator, so the fixture is the same on every run. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Report { id: string; as_of: string; withdrawn: boolean; filed_at: string; rows: SnapshotRow[] }

const N = 34;
const KEYS = 300;
const DAYS = Array.from({ length: N }, (_, i) => dayAfter(D, -7 * (N - i)));
const two = 'D9\u001f2';

/** Every report of the series: one standing a week, and withdrawn ones on some of those days and between them. */
function seriesReports(prefix: string, seed: number): Report[] {
  const rand = random(seed);
  const row = (key: string, i: number, over: Partial<SnapshotRow> = {}): SnapshotRow => {
    const n = Number(key.replace(/\D/g, '')) || 0;
    return {
      key, source_row: i + 2, reference: null, description: `Error ${key}`, category: `C${n % 4}`, unit: n % 3 ? 'G8' : 'FISCAL',
      owner: null, owner_user_id: null, status: 'Open', closed: false, amount_cents: 100 + ((n * 37) % 900) * 100,
      opened_on: n % 5 === 0 ? dayAfter(DAYS[0], -(n % 40)) : null, age_days: n % 5 === 1 ? 10 + (n % 50) : null, ...over,
    };
  };
  const reports: Report[] = [];
  for (let i = 0; i < N; i += 1) {
    const rows: SnapshotRow[] = [];
    for (let k = 0; k < KEYS; k += 1) {
      if (rand() < 0.2) continue;
      const closed = rand() < 0.25;
      rows.push(row(`K${String(k).padStart(4, '0')}`, rows.length, closed ? { closed: true, status: 'Closed' } : {}));
    }
    // Leaves after the sixth report, comes back at the twelfth, is gone from the one before the latest, and is back.
    if (i <= 5 || (i >= 11 && i !== N - 2)) rows.push(row('BACK', rows.length));
    if (i >= N - PERSISTENT_REPORTS) rows.push(row('LAST3', rows.length));
    if (i === N - 1) rows.push(row('ONCE', rows.length), row('GHOST', rows.length));
    rows.push(row(two, rows.length, { age_days: 400 }));
    rows.push(row('SHUT', rows.length, i === N - 2 ? { closed: true, status: 'Closed' } : {}));
    reports.push({ id: `${prefix}-${i}`, as_of: DAYS[i], withdrawn: false, filed_at: `${DAYS[i]}T12:00:00.000Z`, rows });
  }
  // Withdrawn: one the same day as a report that stands, filed before it; one between two weeks. Every identifier on them
  // is open, GHOST among them, so a history that read a withdrawn report would count GHOST as back, not new.
  const ghostly = (id: string, asOf: string, at: string): Report => ({
    id, as_of: asOf, withdrawn: true, filed_at: at,
    rows: [...Array.from({ length: KEYS }, (_, k) => row(`K${String(k).padStart(4, '0')}`, k)), row('GHOST', KEYS), row('ONCE', KEYS + 1), row('LAST3', KEYS + 2)],
  });
  for (const i of [3, 10, 20, N - 2]) reports.push(ghostly(`${prefix}-w${i}`, DAYS[i], `${DAYS[i]}T08:00:00.000Z`));
  reports.push(ghostly(`${prefix}-w15b`, dayAfter(DAYS[15], 3), `${dayAfter(DAYS[15], 3)}T08:00:00.000Z`));
  return reports;
}

function seed(orgId: string, unitId: string, typeId: string, reports: Report[]) {
  const db = app.ctx.db;
  const at = new Date().toISOString();
  db.transaction(() => {
    for (const r of reports) {
      db.prepare(`INSERT INTO source_files (id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, content, created_at)
        VALUES (?, ?, ?, 'unit', ?, 'text/csv', 'delimited', 1, ?, 'clean', ?, ?)`).run(`src-${r.id}`, op.id, unitId, `${r.id}.csv`, `sha-${r.id}`, Buffer.from('x'), at);
      const open = r.rows.filter((x) => !x.closed);
      db.prepare(`INSERT INTO error_snapshots (id, org_id, unit_id, type_id, source_file_id, filename, sha256, as_of, sheet_name, header_row, key_columns, columns, closed_statuses,
          row_count, open_count, open_cents, rejected_rows, rejections, note, filed_by, filed_at, withdrawn_at, withdrawn_by, withdrawn_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sheet1', 1, '["Document"]', '{}', '["closed"]', ?, ?, ?, 0, '[]', NULL, ?, ?, ?, ?, ?)`).run(
        r.id, orgId, unitId, typeId, `src-${r.id}`, `${r.id}.csv`, `sha-${r.id}`, r.as_of, r.rows.length, open.length, open.reduce((n, x) => n + (x.amount_cents ?? 0), 0),
        op.id, r.filed_at, r.withdrawn ? `${r.as_of}T13:00:00.000Z` : null, r.withdrawn ? op.id : null, r.withdrawn ? 'Filed in error, for the test' : null,
      );
      const insert = db.prepare(`INSERT INTO error_snapshot_rows (snapshot_id, natural_key, source_row, reference, description, category, unit_text, owner, owner_user_id, status, closed, amount_cents, opened_on, age_days, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const x of r.rows) {
        insert.run(r.id, x.key, x.source_row, x.reference, x.description, x.category, x.unit, x.owner, x.owner_user_id, x.status, x.closed ? 1 : 0, x.amount_cents, x.opened_on, x.age_days,
          JSON.stringify({ Document: x.key, Description: x.description ?? '', Amount: String((x.amount_cents ?? 0) / 100), Status: x.status ?? '', Extra: `${r.id}/${x.key}` }));
      }
    }
  })();
}

/**
 * What the series says of each identifier, worked out from every row of every report in plain code: the figures a
 * comparison must give, whatever its SQL reads.
 */
function bruteFacts(reports: Report[], afterId: string, beforeId: string | null): { facts: SeriesFacts; seen: Set<string>; before: Report | null; after: Report } {
  const kept = reports.filter((r) => !r.withdrawn).sort((a, b) => a.as_of.localeCompare(b.as_of));
  const at = kept.findIndex((r) => r.id === afterId);
  const beforeAt = beforeId ? kept.findIndex((r) => r.id === beforeId) : -1;
  const keys = new Set([...kept[at].rows, ...(beforeAt >= 0 ? kept[beforeAt].rows : [])].map((r) => r.key));
  const seen = new Set<string>();
  const firstOpenOn = new Map<string, string>();
  const persistent = new Set<string>();
  const recurring = new Set<string>();
  const openOn = (i: number, key: string) => kept[i].rows.some((r) => r.key === key && !r.closed);
  for (const key of keys) {
    if (kept.slice(0, beforeAt + 1).some((r) => r.rows.some((x) => x.key === key))) seen.add(key);
    const open = kept.slice(0, at + 1).map((_, i) => i).filter((i) => openOn(i, key));
    if (open.length) firstOpenOn.set(key, kept[open[0]].as_of);
    if (at >= PERSISTENT_REPORTS - 1 && Array.from({ length: PERSISTENT_REPORTS }, (_, j) => at - j).every((i) => openOn(i, key))) persistent.add(key);
    if (open.at(-1) === at && open.length < at - open[0] + 1) recurring.add(key);
  }
  return { facts: { firstOpenOn, persistent, recurring, persistentKnown: at + 1 >= PERSISTENT_REPORTS }, seen, before: beforeAt >= 0 ? kept[beforeAt] : null, after: kept[at] };
}

/** The history query this replaced, which read every report of the series up to the later one by position. */
const WHOLE_HISTORY_SQL = `SELECT r.natural_key, MIN(p.value) AS first_any,
    MIN(CASE WHEN r.closed = 0 THEN p.value END) AS first_open, MAX(CASE WHEN r.closed = 0 THEN p.value END) AS last_open,
    SUM(CASE WHEN r.closed = 0 THEN 1 ELSE 0 END) AS n_open, SUM(CASE WHEN r.closed = 0 AND p.value > ? THEN 1 ELSE 0 END) AS recent_open
  FROM error_snapshot_rows r JOIN json_each(?) p ON p.key = r.snapshot_id GROUP BY r.natural_key`;

function wholeHistoryFacts(reports: Report[], afterId: string, beforeId: string | null, keys: Set<string>) {
  const kept = reports.filter((r) => !r.withdrawn).sort((a, b) => a.as_of.localeCompare(b.as_of));
  const at = kept.findIndex((r) => r.id === afterId);
  const beforeAt = beforeId ? kept.findIndex((r) => r.id === beforeId) : -1;
  const positions = Object.fromEntries(kept.slice(0, at + 1).map((s, i) => [s.id, i]));
  const history = app.ctx.db.prepare(WHOLE_HISTORY_SQL).all(at - PERSISTENT_REPORTS, JSON.stringify(positions)) as Array<{ natural_key: string; first_any: number; first_open: number | null; last_open: number | null; n_open: number; recent_open: number }>;
  const out = { seen: new Set<string>(), firstOpenOn: new Map<string, string>(), persistent: new Set<string>(), recurring: new Set<string>() };
  for (const h of history.filter((x) => keys.has(x.natural_key))) {
    if (h.first_any <= beforeAt) out.seen.add(h.natural_key);
    if (h.first_open != null) out.firstOpenOn.set(h.natural_key, kept[h.first_open].as_of);
    if (h.recent_open >= PERSISTENT_REPORTS) out.persistent.add(h.natural_key);
    if (h.last_open === at && h.first_open != null && h.n_open < at - h.first_open + 1) out.recurring.add(h.natural_key);
  }
  return out;
}

let g8: Report[];

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  const types = ((await get('/api/error-reports?unit_id=G8')).body as ErrorReportsOverview).types;
  ulo = types.find((t) => t.code === 'ULO')!.id;
  ocmt = types.find((t) => t.code === 'OCMT')!.id;
  assert.equal((await app.call('POST', '/api/org/units', { token: op.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
  const g1lead = await app.register('g1lead');
  assert.equal((await app.call('POST', '/api/platform/orgs', { token: op.token, body: { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id } })).status, 201);
  g1ulo = errorReportTypesOf(app.ctx, 'G1').find((t) => t.code === 'ULO')!.id;
  g8 = seriesReports('g8', 7);
  seed('G8', 'G8', ulo, g8);
});
after(async () => { await app.close(); });

const series = async (params: Record<string, string | undefined> = {}) => {
  const res = await get(`/api/error-reports/series?${qs({ unit_id: 'G8', type_id: ulo, ...params })}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as ComparisonResult;
};
const drill = (params: Record<string, string | number | undefined>) => get(`/api/error-reports/rows?${qs({ unit_id: 'G8', type_id: ulo, ...params })}`);
/** Every page of a drill, `limit` rows at a time, until the server says there is no more. */
async function everyPage(params: Record<string, string | number | undefined>, limit: number) {
  const pages: DrillResult[] = [];
  let offset: number | null = 0;
  while (offset != null) {
    const res = await drill({ ...params, offset, limit });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const page = res.body as DrillResult;
    assert.equal(page.offset, offset);
    pages.push(page);
    offset = page.next_offset;
    assert.ok(pages.length < 1000, 'the pages end');
  }
  return pages;
}

const live = () => g8.filter((r) => !r.withdrawn).sort((a, b) => a.as_of.localeCompare(b.as_of));
const COMPARISONS = () => {
  const kept = live();
  return [
    { label: 'the latest against the one before', after: kept[N - 1], before: kept[N - 2], params: {} },
    { label: 'a report mid-series against one five before it', after: kept[22], before: kept[17], params: { snapshot: kept[22].id, against: kept[17].id } },
    { label: 'the report after a withdrawn one between weeks', after: kept[16], before: kept[15], params: { snapshot: kept[16].id } },
    { label: 'the second report, before anything can be persistent', after: kept[1], before: kept[0], params: { snapshot: kept[1].id } },
    { label: 'the first report, compared with nothing', after: kept[0], before: null, params: { snapshot: kept[0].id } },
  ];
};

test('a series’ history read by identifier gives the figures of its whole history, and of the query it replaced', async () => {
  for (const c of COMPARISONS()) {
    const truth = bruteFacts(g8, c.after.id, c.before?.id ?? null);
    const compared = compareRows(truth.before?.rows ?? [], truth.after.rows, truth.seen);
    const expected = summarize(compared, { before: truth.before?.as_of ?? null, after: truth.after.as_of }, truth.facts);
    const keys = new Set(compared.map((r) => r.key));
    const old = wholeHistoryFacts(g8, c.after.id, c.before?.id ?? null, keys);
    assert.deepEqual([...old.seen].sort(), [...truth.seen].sort(), `${c.label}: seen, as the whole history has it`);
    assert.deepEqual([...old.firstOpenOn].sort(), [...truth.facts.firstOpenOn].sort(), `${c.label}: first open`);
    assert.deepEqual([...old.persistent].sort(), [...truth.facts.persistent].sort(), `${c.label}: persistent`);
    assert.deepEqual([...old.recurring].sort(), [...truth.facts.recurring].sort(), `${c.label}: recurring`);

    const r = await series(c.params);
    assert.equal(r.after.id, c.after.id, c.label);
    assert.equal(r.before?.id ?? null, c.before?.id ?? null, c.label);
    assert.deepEqual(r.summary.counts, expected.counts, `${c.label}: counts`);
    assert.deepEqual(r.summary.figures, JSON.parse(JSON.stringify(expected.figures)), `${c.label}: every figure, as JSON carries them`);
    assert.deepEqual(r.summary.ages, expected.ages, `${c.label}: ages`);
    assert.deepEqual(r.oldest.map((o) => [o.key, o.days, o.basis]), expected.oldest.map((o) => [o.key, o.days, o.basis]), `${c.label}: the oldest`);
  }
  const latest = await series();
  const counts = latest.summary.counts;
  assert.ok(counts.persistent > 0 && counts.recurring > 0 && counts.reopened > 0 && counts.new > 0, 'the fixture holds each kind');
  const truth = bruteFacts(g8, live()[N - 1].id, live()[N - 2].id);
  for (const key of ['BACK', 'SHUT']) assert.ok(truth.facts.recurring.has(key) && truth.seen.has(key), `${key} came back`);
  assert.ok(truth.facts.persistent.has('LAST3') && truth.facts.persistent.has(two) && !truth.facts.recurring.has('LAST3'));
  assert.ok(!truth.seen.has('GHOST') && !truth.seen.has('ONCE'), 'on withdrawn reports only, so new');
});

test('every drill of a comparison holds the rows its figure counts, with the ages the history gives', async () => {
  for (const c of COMPARISONS().slice(0, 3)) {
    const truth = bruteFacts(g8, c.after.id, c.before?.id ?? null);
    const compared = compareRows(truth.before?.rows ?? [], truth.after.rows, truth.seen);
    for (const d of ['open', 'reopened', 'new', 'persistent', 'recurring', 'resolved'] as Drill[]) {
      const want = compared.filter((r) => inDrill(r, d, truth.facts)).map((r) => r.key).sort();
      const pages = await everyPage({ ...c.params, drill: d }, 250);
      const got = pages.flatMap((p) => p.rows);
      assert.deepEqual(got.map((r) => r.key).sort(), want, `${c.label}: ${d}`);
      assert.ok(pages.every((p) => p.total === want.length), `${c.label}: ${d} total on every page`);
      if (d === 'open') {
        for (const row of got) {
          const source = truth.after.rows.find((x) => x.key === row.key)!;
          assert.deepEqual([row.age_days, row.age_basis], Object.values(ageOf(source, truth.after.as_of, truth.facts.firstOpenOn.get(row.key) ?? null)), `${c.label}: age of ${row.key}`);
        }
      }
    }
  }
});

test('a drill is cut into pages only after its rows are decided: each page in order, totals of all, and the columns of its own rows', async () => {
  const latest = await series();
  const open = latest.summary.counts.open;
  assert.ok(open > 150, `enough rows to page (${open})`);
  const first = (await drill({ drill: 'open' })).body as DrillResult;
  assert.equal(first.rows.length, 100, 'a hundred at a time, unless asked');
  assert.equal(first.total, open);
  assert.equal(first.next_offset, 100);
  assert.equal(first.cents, latest.summary.figures.find((f) => f.id === 'open')!.cents, 'the value of every row, not the page');
  const all = (await drill({ drill: 'open', limit: 500 })).body as DrillResult;
  assert.equal(all.rows.length, open);
  assert.equal(all.next_offset, null);
  const pages = await everyPage({ drill: 'open' }, 100);
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.key)), all.rows.map((r) => r.key), 'the pages, joined, are the drill in its order');
  for (const p of pages) {
    assert.ok(p.rows.every((r) => r.data.Extra === `${r.as_of === latest.after.as_of ? latest.after.id : latest.before!.id}/${r.key}`), 'each row with the columns its own report kept');
    assert.deepEqual(p.headers, ['Document', 'Description', 'Amount', 'Status', 'Extra']);
  }
  const resolved = (await drill({ drill: 'resolved', limit: 500 })).body as DrillResult;
  assert.ok(resolved.rows.length && resolved.rows.every((r) => r.data.Extra === `${latest.before!.id}/${r.key}`), 'a resolved row with the columns of the earlier report');
  // A group: every row of every page is of that line.
  const line = latest.groups.category[0];
  const grouped = await everyPage({ drill: 'open', group: 'category', value: line.value }, 20);
  assert.ok(grouped.length > 1, 'more than one page');
  assert.equal(grouped.flatMap((p) => p.rows).length, line.open);
  assert.ok(grouped.every((p) => p.total === line.open && p.rows.every((r) => r.category === line.value)), 'only the line’s rows, on every page');
  const past = (await drill({ drill: 'open', offset: open + 5 })).body as DrillResult;
  assert.deepEqual([past.rows.length, past.total, past.next_offset], [0, open, null], 'past the end, an empty page that says so');
  for (const bad of [{ limit: 0 }, { limit: 501 }, { offset: -1 }, { limit: 'many' }]) {
    const res = await drill({ drill: 'open', ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('a page of a drill reads its rows’ columns in two statements at most, whatever its length', async () => {
  const db = app.ctx.db;
  const prepare = db.prepare;
  const seen: string[] = [];
  db.prepare = ((sql: string) => { seen.push(sql); return prepare.call(db, sql); }) as typeof db.prepare;
  try {
    const statements = async (limit: number) => { seen.length = 0; assert.equal((await drill({ drill: 'still_open', limit })).status, 200); return seen.length; };
    const few = await statements(5);
    const many = await statements(400);
    assert.equal(many, few, 'as many statements for 400 rows as for 5');
    assert.ok(seen.filter((s) => s === DRILL_DATA_SQL).length <= 2, 'one read of columns a report');
  } finally { db.prepare = prepare; }
});

test('a series in another Unit Instance, or of another type, with the same identifiers changes nothing', async () => {
  const before = await series();
  const mid = await series({ snapshot: live()[22].id, against: live()[17].id });
  const g1 = seriesReports('g1', 11).map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, closed: false, status: 'Open' })) }));
  seed('G1', 'G1', g1ulo, g1);
  seed('G8', 'G8', ocmt, seriesReports('oc', 13).map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, closed: false, status: 'Open' })) })));
  const fiscal = seriesReports('fi', 17).slice(0, 5);
  seed('G8', 'FISCAL', ulo, fiscal);
  const strip = (r: ComparisonResult) => ({ summary: r.summary, oldest: r.oldest, groups: r.groups, after: r.after.id, before: r.before?.id });
  assert.deepEqual(strip(await series()), strip(before), 'the latest comparison');
  assert.deepEqual(strip(await series({ snapshot: live()[22].id, against: live()[17].id })), strip(mid), 'one mid-series');
  const overview = (await get('/api/error-reports?unit_id=G8')).body as ErrorReportsOverview;
  assert.ok(!overview.series.some((s) => s.type_id === g1ulo), 'another Unit Instance’s series is not listed');
});

test('the overview lists each series’ counts and its latest two standing reports, as reading every report gave them', async () => {
  const res = await get('/api/error-reports?unit_id=G8');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const overview = res.body as ErrorReportsOverview;
  // What the overview said when it read every report: grouped by series, the standing ones in the order of their days.
  const every = app.ctx.db.prepare("SELECT id, unit_id, type_id, as_of, withdrawn_at FROM error_snapshots WHERE unit_id IN ('G8', 'FISCAL') ORDER BY as_of, filed_at").all() as Array<{ id: string; unit_id: string; type_id: string; as_of: string; withdrawn_at: string | null }>;
  const groups = new Map<string, typeof every>();
  for (const r of every) groups.set(`${r.unit_id}/${r.type_id}`, [...(groups.get(`${r.unit_id}/${r.type_id}`) ?? []), r]);
  assert.equal(overview.series.length, groups.size);
  for (const s of overview.series) {
    const list = groups.get(`${s.unit_id}/${s.type_id}`)!;
    const kept = list.filter((r) => !r.withdrawn_at);
    assert.deepEqual([s.reports, s.withdrawn, s.latest?.id ?? null, s.previous?.id ?? null], [kept.length, list.length - kept.length, kept.at(-1)?.id ?? null, kept.at(-2)?.id ?? null], `${s.unit_id} ${s.code}`);
    if (s.latest) assert.equal(s.latest.filed_by, 'Cpl John Boletz');
  }
  assert.deepEqual(overview.series.map((s) => s.unit_id), ['G8', 'G8', 'FISCAL'], 'the unit’s own series first');
  const seriesOf = (unit: string, type: string) => overview.series.find((s) => s.unit_id === unit && s.type_id === type)!;
  assert.deepEqual([seriesOf('G8', ulo).reports, seriesOf('G8', ulo).withdrawn], [N, 5]);
});

test('the overview reads as many statements for many series as for one', async () => {
  const db = app.ctx.db;
  const prepare = db.prepare;
  let n = 0;
  db.prepare = ((sql: string) => { n += 1; return prepare.call(db, sql); }) as typeof db.prepare;
  try {
    const statements = async (unit: string) => { n = 0; assert.equal((await get(`/api/error-reports?unit_id=${unit}`)).status, 200); return n; };
    await statements('FISCAL');
    const one = await statements('FISCAL');
    const three = await statements('G8');
    assert.equal(three, one, `one series ${one}, three series ${three}`);
  } finally { db.prepare = prepare; }
});

test('a preview against a long series counts what the comparison counts once it is filed, and ticks the usual closed statuses itself', async () => {
  const HEAD = 'Document,Description,Amount,Status';
  const lines = [HEAD];
  for (let k = 0; k < KEYS; k += 3) lines.push(`K${String(k).padStart(4, '0')},Error,${k}.00,${k % 2 ? 'Open' : 'Closed'}`);
  lines.push('BACK,Back,1.00,Open', 'GHOST,Ghost,2.00,Open', 'NEWEST,New,3.00,Open', `${two.split('\u001f')[0]},Not the two-part identifier,4.00,Open`);
  const csv = lines.join('\n');
  const source = await app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-filename': 'ULO now.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const plan = (closed: string[] | null) => ({
    unit_id: 'G8', type_id: ulo, as_of: D, source_file_id: source.body.id, sheet_name: 'ULO now.csv', header_row: 1, key_columns: ['Document'],
    columns: { Document: 'reference', Description: 'description', Amount: 'amount', Status: 'status' }, closed_statuses: closed,
  });
  const ticked = await app.call('POST', '/api/error-reports/preview', { token: op.token, body: plan(null) });
  assert.equal(ticked.status, 200, JSON.stringify(ticked.body));
  const auto = ticked.body as ErrorReportPreview;
  assert.deepEqual(auto.closed_statuses, ['closed'], 'Closed usually means closed');
  assert.deepEqual(auto.statuses.map((s) => [s.status, s.closed]).sort(), [['Closed', true], ['Open', false]]);
  const explicit = (await app.call('POST', '/api/error-reports/preview', { token: op.token, body: plan(['closed']) })).body as ErrorReportPreview;
  assert.deepEqual({ ...auto }, { ...explicit }, 'the same preview as the plan that names it');
  const none = (await app.call('POST', '/api/error-reports/preview', { token: op.token, body: plan([]) })).body as ErrorReportPreview;
  assert.deepEqual(none.closed_statuses, [], 'an empty list closes nothing');
  assert.ok(none.open > auto.open);

  const filed = await app.call('POST', '/api/error-reports/snapshots', { token: op.token, body: plan(null) });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.open_count, auto.open);
  const stored = app.ctx.db.prepare('SELECT closed_statuses FROM error_snapshots WHERE id = ?').get(filed.body.id) as { closed_statuses: string };
  assert.deepEqual(JSON.parse(stored.closed_statuses), ['closed'], 'filed with the statuses it closed');
  const now = await series();
  assert.equal(now.after.id, filed.body.id);
  const c = now.summary.counts;
  assert.deepEqual(auto.changes, { new: c.new, still_open: c.still_open, reopened: c.reopened, resolved: c.resolved, amount_changed: c.amount_changed, owner_changed: c.owner_changed, status_changed: c.status_changed });
  assert.ok(c.reopened > 0 && c.new >= 2, 'some are back; NEWEST and D9 (not the two-part D9 / 2) are new');
});

// ——— Plans, with planner statistics in place ———

const plan = (sql: string, ...args: unknown[]) => (app.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join('\n');

test('each read uses the index it is written for, with planner statistics in place', () => {
  app.ctx.db.exec('ANALYZE');
  const keys = JSON.stringify(['K0001', 'BACK', two]);
  const history = plan(SERIES_HISTORY_SQL, '', keys, 'G8', ulo, D);
  assert.match(history, /SEARCH r USING COVERING INDEX idx_error_snapshot_rows_key_closed \(natural_key=\?\)/, history);
  assert.match(history, /SEARCH s USING INDEX sqlite_autoindex_error_snapshots_1 \(id=\?\)/, history);
  assert.doesNotMatch(history, /SCAN (r|s|error_snapshot_rows|error_snapshots)\b/, history);
  const seen = plan(SEEN_SQL, keys, 'G8', ulo, D);
  assert.match(seen, /SEARCH r USING COVERING INDEX idx_error_snapshot_rows_key_closed \(natural_key=\?\)/, seen);
  assert.doesNotMatch(seen, /SCAN (r|s|error_snapshot_rows|error_snapshots)\b/, seen);

  const units = JSON.stringify(['G8', 'FISCAL']);
  const counts = plan(OVERVIEW_COUNTS_SQL, units);
  assert.match(counts, /SEARCH error_snapshots USING INDEX idx_error_snapshots_series \(unit_id=\?\)/, counts);
  assert.doesNotMatch(counts, /SCAN error_snapshots\b/, counts);
  const latest = plan(OVERVIEW_LATEST_SQL, JSON.stringify([['G8', ulo], ['G8', ocmt]]));
  assert.match(latest, /SEARCH s USING INDEX idx_error_snapshots_day \(unit_id=\? AND type_id=\? AND as_of>\?\)/, latest);
  assert.match(latest, /SEARCH x USING INDEX idx_error_snapshots_day \(unit_id=\? AND type_id=\?\)/, latest);
  assert.doesNotMatch(latest, /SCAN (s|x|error_snapshots)\b/, latest);

  // Each row of a page found by its report and identifier together: the key, or the identifier index that holds both.
  const data = plan(DRILL_DATA_SQL, 'g8-0', keys);
  assert.match(data, /SEARCH error_snapshot_rows USING INDEX (sqlite_autoindex_error_snapshot_rows_1 \(snapshot_id=\? AND natural_key=\?\)|idx_error_snapshot_rows_key_closed \(natural_key=\? AND snapshot_id=\?\))/, data);
  assert.doesNotMatch(data, /SCAN error_snapshot_rows\b/, data);
  // A file's reports, as the foreign key and the boundary trigger on source_files look for them.
  const source = plan('SELECT 1 FROM error_snapshots s WHERE s.source_file_id = ?', 'src-g8-0');
  assert.match(source, /SEARCH s USING COVERING INDEX idx_error_snapshots_source \(source_file_id=\?\)/, source);
});

test('the day a report stands on is its place among the reports that stand: one a day', () => {
  // The history reads a report's position by its day, which holds only while no two standing reports share a day.
  const index = app.ctx.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_error_snapshots_day'").get() as { sql: string };
  assert.match(index.sql, /UNIQUE INDEX .*idx_error_snapshots_day ON error_snapshots\(unit_id, type_id, as_of\) WHERE withdrawn_at IS NULL/);
  const r = live()[3];
  assert.throws(() => app.ctx.db.prepare(`INSERT INTO error_snapshots (id, org_id, unit_id, type_id, source_file_id, filename, sha256, as_of, sheet_name, header_row, key_columns, columns, closed_statuses, row_count, open_count, open_cents, rejected_rows, rejections, filed_by, filed_at)
    VALUES ('dup', 'G8', 'G8', ?, ?, 'x.csv', 'dup', ?, 'x', 1, '[]', '{}', '[]', 0, 0, 0, 0, '[]', ?, ?)`).run(ulo, `src-${r.id}`, r.as_of, op.id, new Date().toISOString()), /UNIQUE/);
});

test('a drill by Marine stays closed to a reader who may not open member records, at any page', async () => {
  const nco = await app.register('nco');
  await enroll(app, op.token, 'G8', nco.id, 'nco');
  const token = (await app.login('nco')).body.token as string;
  for (const offset of [0, 2, 100]) {
    const res = await app.call('GET', `/api/error-reports/rows?${qs({ unit_id: 'G8', type_id: ulo, drill: 'open', group: 'owner', value: '', offset, limit: 2 })}`, { token });
    assert.equal(res.status, 403, `offset ${offset}`);
  }
  const ok = await app.call('GET', `/api/error-reports/rows?${qs({ unit_id: 'G8', type_id: ulo, drill: 'open', offset: 2, limit: 2 })}`, { token });
  assert.equal(ok.status, 200);
  assert.ok((ok.body as DrillResult).rows.every((r) => r.marine === null));
});
