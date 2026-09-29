import { createServer } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';

/** A fresh accounts-mode instance for the films the demo cannot show: first run, sign-in email, administration. */
const port = Number(process.env.VANTAGE_FILM_INSTANCE_PORT || 8799);
const config = loadConfig({
  ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_ACCESS_MODE: 'accounts', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory',
  VANTAGE_EMAIL_FROM: 'Vantage <no-reply@vantageusmc.com>',
  VANTAGE_MARADMIN_ENABLED: 'false', VANTAGE_AI_ENABLED: 'false', VANTAGE_OPERATOR: '', VANTAGE_SECRET: 'film-instance-secret-film-instance-secret-1234',
  VANTAGE_PUBLIC_URL: `http://localhost:${port}`,
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
// Mail stays in memory here, but the Owner console names the provider a real deployment uses.
ctx.mailer.provider = 'resend';
const app = createApp(ctx);

/**
 * The film opens the email a Marine receives. The instance's own outbox holds it; this route shows the latest one
 * to an address as a page, as it reads from the public deployment: the address shown is vantageusmc.com rather
 * than this local instance (the links still point here, so the film can follow them), and the mark sits beside
 * the wordmark, which a local instance leaves out only because recipients could not load it.
 */
const MARK = '<td valign="middle" style="padding-right:12px"><img src="/brand/email-mark.png" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border:0"></td>';
createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/__film/mail') {
    const to = url.searchParams.get('to') || '';
    const mail = [...ctx.mailer.outbox].reverse().find((m) => m.to === to);
    if (!mail) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no mail'); return; }
    const html = mail.html
      .replace(/(<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>)(\s*<td valign="middle" style="font-family:[^"]*letter-spacing:4px)/, `$1${MARK}$2`)
      // Only text a reader sees changes; the href attributes still point at this instance.
      .replace(/>http:\/\/localhost:\d+/g, '>https://vantageusmc.com')
      .replace(/(>| from )localhost:\d+/g, '$1vantageusmc.com');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  app(req, res);
}).listen(port, '127.0.0.1', () => console.log(`Vantage film instance on http://localhost:${port}`));
