import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, type TestApp } from './helpers.ts';
import { prefsSchema } from '../../shared/schemas.ts';
import { TUTORIAL_IDS } from '../../shared/tutorials.ts';

// The tutorials (ADR-0034) are the web app's files, typed by tsconfig.web.json; node runs them as they are, loaded by a
// path the project's type check does not follow (as tests/server/navigation.test.ts loads the menu).
interface Requirement { [key: string]: unknown }
interface Step { title: string; body: string; at: string; from?: string; place?: string; anchor?: string; control?: string; when?: Requirement & { anyOf?: string[] } }
interface Tutorial { id: string; title: string; outcome: string; pages: string[]; when?: Requirement & { anyOf?: string[] }; steps: Step[]; help?: string[]; keywords?: string }
interface Page { to: string; label: string; when?: Requirement }
const { TUTORIALS } = await import('../../src/config/tutorials.ts' as string) as { TUTORIALS: Tutorial[] };
const { pageFor, placeName } = await import('../../src/config/nav.ts' as string) as { pageFor(p: string): Page | undefined; placeName(p: string): string };
const { onPage, hasParam, DEFAULT_QUERY } = await import('../../src/lib/tutorialPaths.ts' as string) as { onPage(p: string, path: string, search?: string): boolean; hasParam(p: string): boolean; DEFAULT_QUERY: Record<string, Record<string, string>> };
const { ALL_ANSWERS } = await import('../../src/config/help.ts' as string) as { ALL_ANSWERS: Array<{ id: string }> };
const { PERMISSIONS } = await import('../../shared/permissions.ts');

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

/** Every .tsx file under src, with its text. */
function sources(dir = 'src'): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(new URL(dir, ROOT))) {
    const path = join(dir, name);
    if (statSync(new URL(path, ROOT)).isDirectory()) out.push(...sources(path));
    else if (path.endsWith('.tsx')) out.push({ file: path, text: read(path) });
  }
  return out;
}

/** The app's routes, as patterns: src/App.tsx's <Route path>s and the Personnel and Administration pages it maps. */
function routes(): string[] {
  const app = read('src/App.tsx');
  const paths = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => (m[1] === '/' ? '/' : `/${m[1].replace(/\/\*$/, '')}`));
  const team = [...app.matchAll(/\['([a-z-]+)', '[a-z]+'\]/g)].map((m) => `/team/${m[1]}`);
  return [...new Set(['/', ...paths, ...team])];
}
const ROUTES = routes();
const isRoute = (pattern: string) => {
  const path = pattern.split('?')[0];
  return ROUTES.some((r) => r === path || (r.includes(':') && onPage(r, path.replace(/:[a-z]+/gi, 'x'))));
};

const SPEC = ['Getting started', 'Logging work', 'Personnel', 'Import and export', 'Error reports', 'Case diagnosis', 'Duty', 'Training', 'Certificates', 'Counselings', 'Reports', 'Analytics'];

test('there is one short tutorial for each topic the specification names, in the order the server keeps them', () => {
  assert.deepEqual(TUTORIALS.map((t) => t.id), [...TUTORIAL_IDS]);
  assert.deepEqual(TUTORIALS.map((t) => t.title), SPEC);
  for (const t of TUTORIALS) {
    assert.ok(t.steps.length >= 3 && t.steps.length <= 6, `${t.id} has ${t.steps.length} steps; a tutorial is short (3 to 6)`);
    assert.equal(new Set(t.steps.map((s) => s.title)).size, t.steps.length, `${t.id}: two steps share a title`);
    assert.ok(t.pages.length > 0, `${t.id} is offered on no page`);
    assert.match(t.outcome, /^[A-Z].*\.$/, `${t.id}: the outcome is one sentence`);
    assert.ok(!/[.!?]\s+\S/.test(t.outcome), `${t.id}: the outcome is one sentence`);
  }
});

test('each step is a few words to do and at most two plain sentences', () => {
  for (const t of TUTORIALS) for (const s of t.steps) {
    const where = `${t.id} → "${s.title}"`;
    assert.ok(s.title.length <= 48, `${where}: the title is long`);
    assert.ok(!/[.!]$/.test(s.title), `${where}: a title is not a sentence`);
    assert.ok(s.body.length <= 300, `${where}: the body is ${s.body.length} characters`);
    const sentences = s.body.split(/(?<=[.?])\s+(?=[A-Z“"0-9])/).filter(Boolean);
    assert.ok(sentences.length <= 2, `${where}: ${sentences.length} sentences`);
    assert.ok(!/!/.test(s.body + s.title + t.outcome), `${where}: no exclamation marks`);
  }
});

test('every step happens on a page of the application, and one reached through another names it', () => {
  for (const t of TUTORIALS) {
    for (const p of t.pages) assert.ok(isRoute(p), `${t.id} is offered on ${p}, which is not a route`);
    for (const s of t.steps) {
      const where = `${t.id} → "${s.title}"`;
      assert.ok(isRoute(s.at), `${where} happens on ${s.at}, which is not a route`);
      if (hasParam(s.at)) {
        assert.ok(s.from, `${where} happens on a page reached from another (${s.at}), so it names that page`);
        assert.ok(pageFor(s.from!.split('?')[0]), `${where}: "${s.from}" is not a page of the menu`);
      } else {
        assert.equal(s.from, undefined, `${where}: "from" is only for a page reached through another`);
        assert.ok(pageFor(s.at.split('?')[0]), `${where}: ${s.at} is not a page of the menu`);
      }
      // "Go to" names the place as the menu does, unless the step says it (a tab of a page).
      if (!s.place) assert.notEqual(placeName(s.from ?? s.at), s.from ?? s.at, `${where}: the menu has no name for ${s.from ?? s.at}`);
    }
  }
});

test('a tutorial leads only where the menu lets the same person go', () => {
  // The rule the menu hides a page by is the rule its step is offered by, at least: nobody is led to a page they lack.
  for (const t of TUTORIALS) for (const s of t.steps) {
    const page = pageFor((s.from ?? s.at).split('?')[0]);
    const gate = { ...(t.when || {}), ...(s.when || {}) } as Requirement;
    for (const [key, value] of Object.entries(page?.when || {})) {
      assert.deepEqual(gate[key], value, `${t.id} → "${s.title}" leads to ${page!.to}, which the menu shows only when ${key} is ${JSON.stringify(value)}`);
    }
    for (const key of [...(t.when?.anyOf || []), ...(s.when?.anyOf || [])]) assert.ok(key in PERMISSIONS, `${t.id}: ${key} is not a permission`);
  }
});

test('every control a step points at is tagged in the application, and every tag belongs to a step', () => {
  const files = sources();
  const tagged = new Map<string, string[]>();
  for (const { file, text } of files) {
    // On an element or a component (data-tutorial="name"), or on a tab given to Segmented ('data-tutorial': 'name').
    for (const m of text.matchAll(/data-tutorial(?:="([^"]+)"|': '([^']+)')/g)) for (const name of (m[1] ?? m[2]).split(/\s+/)) tagged.set(name, [...(tagged.get(name) || []), file]);
    // A tag is a plain string, so this test can read it: a computed one could be anything. A primitive only passes on
    // the one it is given (data-tutorial={tutorial}, or a tab's own).
    for (const m of text.matchAll(/data-tutorial=\{([^}]*)\}/g)) assert.ok(/^(tutorial|o\['data-tutorial'\])$/.test(m[1]), `${file} computes a data-tutorial name: {${m[1]}}`);
  }
  const used = new Set<string>();
  for (const t of TUTORIALS) for (const s of t.steps) {
    const where = `${t.id} → "${s.title}"`;
    if (!s.anchor) { assert.equal(s.control, undefined, `${where} names a control but no tag`); continue; }
    used.add(s.anchor);
    assert.match(s.anchor, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: tag names are kebab-case`);
    assert.ok(tagged.has(s.anchor), `${where} points at data-tutorial="${s.anchor}", which no component carries`);
    // A control named by what it holds (a training's own title, a figure's count) has no fixed name to give.
    if (s.control) assert.ok(`${s.title} ${s.body}`.includes(s.control), `${where}: its words do not name "${s.control}", the control it shows`);
  }
  for (const name of tagged.keys()) assert.ok(used.has(name), `data-tutorial="${name}" (${tagged.get(name)!.join(', ')}) belongs to no step`);
});

test('the Field guide answers a tutorial points to exist', () => {
  const ids = new Set(ALL_ANSWERS.map((a) => a.id));
  for (const t of TUTORIALS) for (const id of t.help || []) assert.ok(ids.has(id), `${t.id} points to help answer "${id}", which does not exist`);
});

test('a page pattern matches its page, its parameter stands for no page of the menu, and a query names a tab', () => {
  assert.equal(onPage('/record/duty', '/record/duty'), true);
  assert.equal(onPage('/record/duty', '/record/duty/'), true, 'a trailing slash is the same page');
  assert.equal(onPage('/record/duty', '/record'), false);
  assert.equal(onPage('/record', '/record/duty'), false, 'a page is not every page beneath it');
  assert.equal(onPage('/team/:id', '/team/u-123'), true);
  assert.equal(onPage('/team/:id', '/team/roster'), false, 'Personnel → Roster is not a Marine’s page');
  assert.equal(onPage('/team/:id', '/team'), false);
  assert.equal(onPage('/settings?tab=data', '/settings', '?tab=data'), true);
  assert.equal(onPage('/settings?tab=data', '/settings', '?tab=data&import=1'), true, 'other query words do not matter');
  assert.equal(onPage('/settings?tab=data', '/settings', '?tab=profile'), false);
  assert.equal(onPage('/settings?tab=data', '/settings'), false);
  assert.equal(onPage('/', '/'), true);
  assert.equal(hasParam('/team/:id'), true);
  assert.equal(hasParam('/settings?tab=data'), false);
});

test('a page’s first tab is the page with no tab in its address, and no other tab is', () => {
  assert.equal(onPage('/settings?tab=profile', '/settings'), true, 'Settings opens on Profile');
  assert.equal(onPage('/settings?tab=profile', '/settings', '?tab=security'), false);
  assert.equal(onPage('/reference?tab=diagnose', '/reference'), true, 'Reference opens on Diagnose');
  assert.equal(onPage('/reference?tab=diagnose', '/reference', '?tab=glossary'), false);
  assert.equal(onPage('/record/duty?who=mine', '/record/duty'), true, 'Duty opens on Yours');
  assert.equal(onPage('/record/duty?who=review', '/record/duty'), false);
  assert.equal(onPage('/record/duty?who=mine', '/record/duty', '?who=review'), false);
  assert.equal(onPage('/team/:id?tab=personnel', '/team/u-1'), true, 'a Marine’s page opens on Personnel');
  assert.equal(onPage('/team/:id?tab=career', '/team/u-1'), false);
});

test('each first tab the tutorials assume is the one its page opens on', () => {
  // A page leaves its first tab out of its address (useParam drops a value equal to its fallback), so a page that
  // changed its first tab would make a step say "here" on the wrong one.
  const PAGE_FILES: Record<string, string> = {
    '/settings': 'src/pages/Settings.tsx', '/reference': 'src/pages/Reference.tsx', '/record/duty': 'src/pages/Duty.tsx', '/team/:id': 'src/pages/MemberDetail.tsx',
  };
  assert.deepEqual(Object.keys(DEFAULT_QUERY).sort(), Object.keys(PAGE_FILES).sort(), 'every page with a first tab is checked');
  for (const [page, query] of Object.entries(DEFAULT_QUERY)) {
    const text = read(PAGE_FILES[page]);
    for (const [key, value] of Object.entries(query)) {
      assert.ok(new RegExp(String.raw`useParam\(\s*'${key}'\s*,\s*'${value}'\s*\)`).test(text), `${PAGE_FILES[page]} opens with ${key}=${value}`);
    }
  }
});

let app: TestApp;
let marine: { token: string; id: string };
let other: { token: string; id: string };
before(async () => {
  app = await startApp();
  await app.setupOperator();
  marine = await app.register('learner');
  other = await app.register('bystander');
});
after(async () => { await app.close(); });

test('a finished tutorial is kept with the person’s own preferences, once, and nobody else’s', async () => {
  const fresh = await app.call('GET', '/api/me', { token: marine.token });
  assert.equal(fresh.body.prefs.tutorials, undefined, 'nothing is finished until something is');
  assert.equal(fresh.body.prefs.tutorialPrompts, undefined, 'the line under page titles is on until turned off');

  await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { theme: 'dark' } });
  const saved = await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { tutorials: { done: ['duty', 'getting-started', 'duty'] } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.tutorials, { done: ['duty', 'getting-started'] }, 'a tutorial finished twice is kept once');
  assert.equal(saved.body.theme, 'dark', 'the other preferences stay as they were');
  assert.deepEqual((await app.call('GET', '/api/me', { token: marine.token })).body.prefs.tutorials, { done: ['duty', 'getting-started'] });
  assert.equal((await app.call('GET', '/api/me', { token: other.token })).body.prefs.tutorials, undefined);

  const off = await app.call('PUT', '/api/me/prefs', { token: marine.token, body: { tutorialPrompts: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.tutorialPrompts, false);
  assert.deepEqual(off.body.tutorials, { done: ['duty', 'getting-started'] });
});

test('only the tutorials there are can be kept as finished, and only so many', async () => {
  for (const tutorials of [{ done: ['duty', 'not-a-tutorial'] }, { done: 'duty' }, { done: [...TUTORIAL_IDS, ...TUTORIAL_IDS] }, ['duty'], { done: [{ id: 'duty' }] }]) {
    const res = await app.call('PUT', '/api/me/prefs', { token: other.token, body: { tutorials } });
    assert.equal(res.status, 400, `tutorials: ${JSON.stringify(tutorials)}`);
  }
  for (const tutorialPrompts of ['off', 0, null]) {
    assert.equal((await app.call('PUT', '/api/me/prefs', { token: other.token, body: { tutorialPrompts } })).status, 400);
  }
  assert.equal((await app.call('GET', '/api/me', { token: other.token })).body.prefs.tutorials, undefined);
  assert.equal(prefsSchema.safeParse({ tutorials: { done: [...TUTORIAL_IDS] } }).success, true);
  assert.equal(prefsSchema.safeParse({ tutorials: { done: [] } }).success, true);
});
