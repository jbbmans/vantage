import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { startApp } from './helpers.ts';
import { audit } from '../../server/services/audit.ts';
import { syslogLine, closeAuditSink } from '../../server/services/auditSink.ts';

/** A syslog collector that reads RFC 6587 octet-counted frames. */
async function collector() {
  const lines: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const space = buf.indexOf(' ');
        if (space < 0) break;
        const len = Number(buf.slice(0, space));
        const body = Buffer.from(buf.slice(space + 1), 'utf8');
        if (body.length < len) break;
        lines.push(body.subarray(0, len).toString('utf8'));
        buf = body.subarray(len).toString('utf8');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { lines, port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

test('every audit record reaches a syslog collector with its chain hash, and a rolled-back record does not', async () => {
  const siem = await collector();
  const app = await startApp({ VANTAGE_AUDIT_SYSLOG: `tcp://127.0.0.1:${siem.port}` });
  try {
    await app.setupOperator();
    await until(() => siem.lines.some((l) => l.includes(' setup ') || l.includes('"action":"setup"')));
    assert.ok(siem.lines.length > 0, 'records arrive');
    const first = siem.lines[0];
    assert.match(first, /^<109>1 \d{4}-\d{2}-\d{2}T[^ ]+ \S+ vantage \d+ \S+ - \{/);
    const record = JSON.parse(first.slice(first.indexOf('{')));
    assert.equal(record.type, 'vantage.audit');
    const stored = app.ctx.db.prepare('SELECT entry_hash FROM audit_log WHERE id = ?').get(record.id) as { entry_hash: string };
    assert.equal(record.entry_hash, stored.entry_hash, 'the off-host copy carries the same hash as the chain');

    const before = siem.lines.length;
    try {
      app.ctx.db.transaction(() => {
        audit(app.ctx, { action: 'rolled_back_on_purpose' });
        throw new Error('roll back');
      })();
    } catch { /* expected */ }
    audit(app.ctx, { action: 'kept_after_rollback' });
    await until(() => siem.lines.some((l) => l.includes('kept_after_rollback')));
    const after = siem.lines.slice(before).join('\n');
    assert.match(after, /kept_after_rollback/);
    assert.doesNotMatch(after, /rolled_back_on_purpose/, 'a record that never reached the chain is never sent');

    const overview = await app.call('GET', '/api/platform/overview', { token: (await app.login('boletz')).body.token });
    assert.ok([200, 403].includes(overview.status));
  } finally {
    closeAuditSink(app.ctx);
    await app.close();
    await siem.close();
  }
});

test('a syslog line carries the action as its message id and never a control character', () => {
  const line = syslogLine({ id: 'a', at: '2026-10-02T12:00:00.000Z', action: 'login\nforged', actor_id: null, entity: null, entity_id: null, subject_id: null, unit_id: null, detail: 'x\ny', ip: null, prev_hash: null, entry_hash: 'h' }, 'vantage');
  assert.equal(line.split('\n').length, 1, 'one line, whatever the record holds');
  assert.match(line, / login_forged - /);
});

test('an address that is not udp, tcp or tls is refused at start', async () => {
  await assert.rejects(startApp({ VANTAGE_AUDIT_SYSLOG: 'http://siem.example.mil' }), /VANTAGE_AUDIT_SYSLOG/);
});
