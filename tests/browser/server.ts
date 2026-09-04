/** Boots Vantage in test mode for Playwright: in-memory database, memory mailer, built client from dist/. */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';

const port = Number(process.env.VANTAGE_BROWSER_PORT || 8797);

/** A stand-in for the GenAI.mil gateway so the browser suite can exercise every AI surface without a key. */
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
      if (req.url?.startsWith('/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }, { id: 'grok-3' }, { id: 'gpt-4o' }] })); return; }
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
  VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'browser-test-genai-key', VANTAGE_GENAI_BASE_URL: aiBaseUrl, VANTAGE_GENAI_MODELS: 'gemini-2.5-flash,gemini-2.5-pro,grok-3',
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
const app = createApp(ctx);

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/__test/mail')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ctx.mailer.outbox));
    return;
  }
  app(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`Vantage browser-test server on http://localhost:${port}`));
