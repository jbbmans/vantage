import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { prefsSchema } from '../../shared/schemas.ts';

// Single-key shortcuts can be turned off (WCAG 2.1.4): the choice is a preference of the person's own, kept with the
// rest, and nothing but a yes or a no is taken for it.

let app: TestApp;
let marine: { token: string; id: string };
let other: { token: string; id: string };
before(async () => {
  app = await startApp();
  await app.setupOperator();
  marine = await app.register('keyless');
  other = await app.register('keyed');
});
after(async () => { await app.close(); });

test('KB-03: shortcuts are on for anyone who never chose, and turning them off is kept with the other preferences', async () => {
  const fresh = await app.call('GET', '/api/me', { token: marine.token });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.prefs.shortcuts, undefined, 'no choice is stored until one is made; the app reads that as on');

  await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { theme: 'dark' } });
  const off = await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { shortcuts: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.shortcuts, false);
  assert.equal(off.body.theme, 'dark', 'the other preferences stay as they were');
  assert.equal((await app.call('GET', '/api/me', { token: marine.token })).body.prefs.shortcuts, false);
  assert.equal((await app.call('GET', '/api/me/prefs', { token: marine.token })).body.shortcuts, false);

  // One person's choice is theirs alone.
  assert.equal((await app.call('GET', '/api/me', { token: other.token })).body.prefs.shortcuts, undefined);

  const on = await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { shortcuts: true } });
  assert.equal(on.status, 200);
  assert.equal((await app.call('GET', '/api/me', { token: marine.token })).body.prefs.shortcuts, true);
});

test('KB-03: a shortcuts value that is not a yes or a no is refused, and changes nothing', async () => {
  for (const shortcuts of ['off', 0, null, { all: false }]) {
    const res = await app.call('PUT', '/api/me/prefs', { token: other.token, body: { shortcuts } });
    assert.equal(res.status, 400, `shortcuts: ${JSON.stringify(shortcuts)}`);
  }
  assert.equal((await app.call('GET', '/api/me', { token: other.token })).body.prefs.shortcuts, undefined);
  assert.equal(prefsSchema.safeParse({ shortcuts: false }).success, true);
  assert.equal(prefsSchema.safeParse({ shortcuts: 'false' }).success, false);
});
