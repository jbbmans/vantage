import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';
import { SCHEMA_VERSION } from '../../server/db/index.ts';
import { drillHistory, recordDrill } from '../../server/services/drillLog.ts';
import { VERSION } from '../../server/version.ts';

const port = Number(process.env.VANTAGE_BROWSER_PORT || 8797);

const AI_ANSWERS: Record<string, unknown> = {
  quick_log: { title: 'Reconciled 30 ULOs in DAI', date: '2026-08-20', category: 'Fiscal & Financial', evaluation_area: 'MOS / Mission Accomplishment', action_amount: 30, action_unit: 'ULOs', transaction_value: 1118.38, dollar_type: 'reconciled', organization: 'G-8', system: 'DAI', result: 'cleared the aged backlog', status: 'completed', confidence: 0.9, warnings: [] },
  writing: { draft: 'Reconciled 30 unliquidated obligations totaling $1,118.38 in DAI, closing the fiscal year with zero unresolved items.', alternatives: [], facts_used: ['30 ULOs', '$1,118.38'], cautions: ['Verify the dollar figure against DAI.'] },
  personal_review: { summary: 'Steady fiscal work with measurable outcomes.', highlights: ['30 ULOs reconciled'], gaps: [], next_actions: ['Log the FY close-out.'], goal_observations: [], cautions: [] },
  record_quality: { summary: 'Entries carry quantities; a few lack results.', issues: [], strongest_records: ['Reconciled 30 ULOs'], cautions: [] },
  goal_draft: { title: 'Reconcile 100 ULOs by FY close', description: 'Clear the aged ULO backlog in DAI.', target_value: 100, unit: 'ULOs', period_start: '2026-09-01', period_end: '2026-09-30', category: 'Fiscal & Financial', milestones: ['25 by 10 Sep'], assumptions: [] },
};
function startMockGenAi(): Promise<string> {
  const mock = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer browser-test-genai-key') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad key' } })); return; }
      if (req.url?.startsWith('/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'model-fast' }, { id: 'model-pro' }, { id: 'model-alt' }, { id: 'model-large' }] })); return; }
      const body = data ? JSON.parse(data) : {};
      const workflow = String(JSON.parse(body.messages?.[1]?.content || '{}').workflow || '');
      const answer = AI_ANSWERS[workflow] || { summary: `mock answer for ${workflow}`, cautions: [] };
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }));
    });
  });
  return new Promise((resolve) => mock.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`)));
}
const aiBaseUrl = await startMockGenAi();
if (!existsSync(join(PROJECT_ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run `npm run build` before the browser tests.');
  process.exit(1);
}
const config = loadConfig({
  ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
  VANTAGE_SECRET: 'browser-test-secret-browser-test-secret-1234', VANTAGE_PUBLIC_URL: `http://localhost:${port}`, VANTAGE_OPERATOR: '', VANTAGE_SELF_REGISTRATION: 'true',
  // The calendar "today" is reckoned in; specs compute their days in it (fixtures.ts INSTANCE_TIMEZONE), not in UTC.
  VANTAGE_TIMEZONE: 'America/New_York',
  VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'browser-test-genai-key', VANTAGE_GENAI_BASE_URL: aiBaseUrl, VANTAGE_GENAI_MODELS: 'model-fast,model-pro,model-alt',
  // Every spec registers its people from this one address, more than one connection may in production.
  VANTAGE_REGISTRATIONS_PER_15_MINUTES: '200',
  // The whole suite signs in as the same few staff and walks both consoles many times over; one person does not.
  VANTAGE_CONSOLE_READS_PER_15_MINUTES: '20000',
  // Nearly every spec writes as the same operator, and the suite runs about fifteen minutes: more than 300 changes in
  // one window, which no one person makes. Production keeps its default.
  VANTAGE_MUTATIONS_PER_15_MINUTES: '3000',
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
const app = createApp(ctx);

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/__test/mail')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ctx.mailer.outbox));
    return;
  }
  // A restore drill runs on the host (scripts/restore.ts DRILL), never through the product, so no spec can make one. This
  // records one that passed, one that failed and, last, one that stopped before it finished, as the script would, once
  // (ADR-0041). Test server only.
  if (req.method === 'POST' && req.url?.startsWith('/api/__test/drills')) {
    if (!drillHistory(ctx.db).length) {
      const backup = { file: 'nightly.db', bytes: 1_048_576, sha256: 'a'.repeat(64), schema: SCHEMA_VERSION, seq: 40, at: new Date().toISOString(), recorded: true };
      const drill = { kind: 'drill' as const, upgraded: null, sameDatabase: true, by: null, hostUser: 'vantage', version: VERSION, ms: 900 };
      recordDrill(ctx.db, { ...drill, ok: true, failure: null, backup, trail: 40, wouldUndo: { entries: 3, instances: 1, changes: 0 } });
      recordDrill(ctx.db, { ...drill, ok: false, failure: "The backup cannot be restored. It fails SQLite's integrity check: database disk image is malformed.", backup: { ...backup, file: 'damaged.db', recorded: false }, trail: null, sameDatabase: null, wouldUndo: null });
      recordDrill(ctx.db, { ...drill, ok: false, stopped: true, failure: 'The drill stopped: SQLITE_FULL: database or disk is full', backup: { ...backup, file: 'interrupted.db' }, trail: null, wouldUndo: null });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // A sign-in confirms it is the person for ten minutes, longer than a spec waits. This ends that for one account's
  // sessions, so a spec sees the confirmation a change asks for (ADR-0040). Test server only.
  if (req.method === 'POST' && req.url?.startsWith('/api/__test/end-step-up')) {
    const user = new URL(req.url, 'http://localhost').searchParams.get('user') || '';
    ctx.db.prepare('UPDATE sessions SET sudo_until = NULL WHERE user_id = ?').run(user);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // A scoring version takes effect tomorrow at the earliest (ADR-0012) and duty is recorded once it has been stood, so no
  // spec can reach duty with calculated points through the product alone. This puts a version in force for a Unit
  // Instance that has none: three points for each of its duty types, from a day long past. Test server only.
  if (req.method === 'POST' && req.url?.startsWith('/api/__test/duty-scoring')) {
    const orgId = new URL(req.url, 'http://localhost').searchParams.get('org') || 'G8';
    const today = new Date().toISOString().slice(0, 10);
    const inForce = ctx.db.prepare('SELECT 1 FROM duty_scoring_policies WHERE org_id = ? AND withdrawn_at IS NULL AND effective_from <= ?').get(orgId, today);
    if (!inForce) {
      const types = ctx.db.prepare('SELECT id FROM duty_types WHERE org_id = ? AND active = 1').all(orgId) as Array<{ id: string }>;
      const next = (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM duty_scoring_policies WHERE org_id = ?').get(orgId) as { n: number }).n;
      ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(`browser-test-scoring-${orgId}`, orgId, next, '2020-01-01', JSON.stringify({ rules: types.map((t) => ({ duty_type_id: t.id, method: 'fixed', points: 3, bands: null })), multipliers: [], combine: 'highest' }), 'Browser tests: three points a duty', new Date().toISOString());
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  app(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`Vantage browser-test server on http://localhost:${port}`));
