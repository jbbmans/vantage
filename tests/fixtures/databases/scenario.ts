import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The scenario every frozen database fixture is written with (ADR-0041). `node scripts/database-fixtures.ts freeze <ref>`
 * copies this file into a checkout of that ref and runs it there, from the checkout's root, with that build's own test
 * helpers and API: the database is what that build writes, through the routes it served. Each step is tried and its
 * answer kept, so a build without a feature answers 404 and the manifest says so. Everything is made up: example.mil
 * accounts, the test helpers' secret and password, and dates in 2026.
 *
 * It imports nothing from this checkout, only from the one it runs in, so it keeps working as the helpers change.
 */
interface Answer { status: number; body: unknown }
interface TestApp {
  call: (method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<Answer>;
  setupOperator: () => Promise<{ token: string; id: string }>;
  register: (username: string) => Promise<{ token: string; id: string }>;
  login: (username: string) => Promise<Answer>;
  close: () => Promise<void>;
}
interface Helpers {
  startApp: (env: Record<string, string>) => Promise<TestApp>;
  enroll: (app: TestApp, operatorToken: string, unitId: string, userId: string) => Promise<void>;
}

const out = process.argv[2];
if (!out) { console.error('Usage: node scenario.ts <database file>'); process.exit(2); }
const helpers = await import(pathToFileURL(resolve(process.cwd(), 'tests/server/helpers.ts')).href) as Helpers;
const app = await helpers.startApp({ VANTAGE_DB: resolve(out) });
const steps: Array<{ step: string; status: number | string }> = [];
const step = async (name: string, run: () => Promise<number | string>) => {
  try { steps.push({ step: name, status: await run() }); } catch (error) { steps.push({ step: name, status: `failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }); }
};
const tokenIn = (body: unknown) => (body && typeof body === 'object' && 'token' in body ? String((body as { token: unknown }).token) : '');

// The Lead Vantage Administrator who set the service up, with the G-8 unit, and three Marines in it.
const lead = await app.setupOperator();
const marines: Record<string, { token: string; id: string }> = {};
for (const name of ['alpha', 'bravo', 'charlie']) {
  await step(`register and enroll ${name}`, async () => {
    const made = await app.register(name);
    await helpers.enroll(app, lead.token, 'G8', made.id);
    // Joining a unit changes what the account may do, so its session ends: it signs in again.
    const again = await app.login(name);
    marines[name] = { id: made.id, token: tokenIn(again.body) || made.token };
    return again.status;
  });
}
const tokenOf = (who: string) => (who === 'lead' ? lead.token : marines[who]?.token ?? '');
const post = (who: string, path: string, body: Record<string, unknown>) =>
  step(`${who} POST ${path}`, async () => (await app.call('POST', path, { token: tokenOf(who), body })).status);

await post('alpha', '/api/records/activities', { title: 'Reconciled 22 MIPRs against the ledger', date: '2026-09-20', visibility: 'unit', quantity: 22, unit_label: 'MIPRs' });
await post('alpha', '/api/records/activities', { title: 'Drafted the travel claim checklist', date: '2026-09-22', visibility: 'private' });
await post('bravo', '/api/records/activities', { title: 'Closed out 14 unliquidated obligations', date: '2026-09-18', visibility: 'unit', quantity: 14, unit_label: 'ULOs' });
await post('lead', '/api/records/awards', { name: 'Certificate of Commendation', status: 'presented', date: '2026-08-15' });
await post('alpha', '/api/records/awards', { name: 'Navy and Marine Corps Achievement Medal', status: 'recommended', type: 'personal_award' });
await post('lead', '/api/records/trainings', { title: 'Fiscal law', date: '2026-08-01', hours: 4, type: 'course' });
await post('charlie', '/api/records/trainings', { title: 'Financial management course', visibility: 'unit', date: '2026-09-10', hours: 6 });
await post('lead', '/api/records/counselings', { user_id: marines.alpha?.id, type: 'monthly', date: '2026-09-01', summary: 'Solid month. Push outcomes on every entry.', follow_up_date: '2026-10-01', visibility: 'unit' });
await post('alpha', '/api/records/goals', { title: 'Reconcile 100 ULOs', metric: 'activity_quantity', target_value: 100, unit_label: 'ULOs', period_start: '2026-07-01', period_end: '2026-09-30', status: 'active' });
await post('lead', '/api/records/tasks', { title: 'Close the ULO review', visibility: 'unit', assignee_id: marines.bravo?.id, due_date: '2026-09-30' });
await post('bravo', '/api/records/projects', { name: 'Audit prep', visibility: 'unit' });

await app.close();
console.log(JSON.stringify({ steps }));
