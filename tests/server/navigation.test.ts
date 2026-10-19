import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The menu is the information architecture (ADR-0016): every surface reads it, so its invariants are the IA's.
// It is the web app's file, typed by tsconfig.web.json and its '@/' paths; node runs it as it is, so it is loaded by a
// path this project's type check does not follow.
interface Page { to: string; label: string; key?: string }
interface Group { id: string; label: string; key: string; foot?: boolean; pages: Page[] }
interface Nav {
  ALL_PAGES: Page[]; FOOTER: Page[]; GROUPS: Group[]; HOME: Page; MOVED: Record<string, string>;
  groupFor(pathname: string): Group | undefined; movedTo(pathname: string, search: string): string | null;
  pageFor(pathname: string): Page | undefined; placeName(to: string): string;
}
const NAV = '../../src/config/nav.ts';
const { ALL_PAGES, FOOTER, GROUPS, HOME, MOVED, groupFor, movedTo, pageFor, placeName } = await import(NAV) as Nav;

test('the menu is the specification’s top-level structure, with Help and Settings at the foot', () => {
  const top = [HOME.label, ...GROUPS.filter((g) => !g.foot).map((g) => g.label)];
  assert.deepEqual(top, ['Today', 'Work', 'Records', 'Personnel', 'Training & Development', 'Reports & Analytics', 'Administration']);
  assert.deepEqual(GROUPS.filter((g) => g.foot).map((g) => g.label), ['Help']);
  assert.deepEqual(FOOTER.map((p) => p.label), ['Settings']);
  const pages = (id: string) => GROUPS.find((g) => g.id === id)!.pages.map((p) => p.label);
  assert.deepEqual(pages('records'), ['Overview', 'Timeline', 'Activities', 'Awards', 'Counseling', 'Drafts', 'Contributions']);
  assert.deepEqual(pages('development'), ['Training', 'Career plan', 'Goals', 'Readiness', 'MARADMINs']);
  assert.deepEqual(pages('personnel'), ['Overview', 'Roster', 'Workload']);
  assert.deepEqual(pages('reports'), ['Packages', 'Analysis', 'Unit dashboard']);
  assert.deepEqual(pages('admin'), ['Invitations', 'Roles', 'Units', 'Access log', 'Unit Manager console', 'Vantage Administrator console', 'Unit Manager console']);
});

test('every G key is used once, and the old ones still open their pages', () => {
  const keys = [...GROUPS.map((g) => g.key), ...ALL_PAGES.filter((p) => p.key).map((p) => p.key!)];
  assert.equal(new Set(keys).size, keys.length, `a key is used twice: ${keys.join(' ')}`);
  for (const k of keys) assert.match(k, /^[a-z]$/);
  const opens = (key: string) => {
    const group = GROUPS.find((g) => g.key === key);
    return group ? group.pages[0].to : ALL_PAGES.find((p) => p.key === key)?.to;
  };
  // Keyboard efficiency: each letter someone already knows lands where it did before the menu changed.
  for (const [key, to] of Object.entries({ d: '/', w: '/work/queue', r: '/record', g: '/goals', p: '/reports', t: '/team', f: '/reference', m: '/maradmins', h: '/help', s: '/settings', o: '/console' })) {
    assert.equal(opens(key), to, `G ${key.toUpperCase()}`);
  }
  assert.equal(opens('c'), '/career/training');
  assert.equal(opens('a'), '/team/invitations');
  assert.equal(opens('k'), undefined, 'K (Knowledge) is retired');
});

test('each page sits in one group, and every page in the menu is a route', () => {
  const seen = new Map<string, string>();
  for (const g of GROUPS) for (const p of g.pages) {
    assert.ok(!seen.has(p.to), `${p.to} is in ${seen.get(p.to)} and ${g.label}`);
    seen.set(p.to, g.label);
  }
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const routes = new Set([...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => `/${m[1].replace(/\/\*$/, '')}`));
  const team = [...app.matchAll(/\['([a-z-]+)', '[a-z]+'\]/g)].map((m) => `/team/${m[1]}`);
  for (const p of ALL_PAGES) {
    if (p.to === '/') continue;
    assert.ok(routes.has(p.to) || team.includes(p.to), `${p.to} has no route in src/App.tsx`);
  }
});

test('a page keeps its address when it changes group, and its group is read from the page', () => {
  const group = (path: string) => groupFor(path)?.label;
  assert.equal(group('/career/awards'), 'Records');
  assert.equal(group('/career/counseling'), 'Records');
  assert.equal(group('/career/training'), 'Training & Development');
  assert.equal(group('/career'), 'Training & Development');
  assert.equal(group('/goals'), 'Training & Development');
  assert.equal(group('/maradmins'), 'Training & Development');
  assert.equal(group('/reference'), 'Work');
  assert.equal(group('/team'), 'Personnel');
  assert.equal(group('/team/roster'), 'Personnel');
  assert.equal(group('/team/dashboard'), 'Reports & Analytics');
  assert.equal(group('/team/roles'), 'Administration');
  assert.equal(group('/team/access-log'), 'Administration');
  assert.equal(group('/console'), 'Administration');
  assert.equal(group('/help'), 'Help');
  // Detail pages belong to the group that claims them.
  assert.equal(group('/work/items/abc'), 'Work');
  assert.equal(group('/records/abc'), 'Records');
  assert.equal(group('/team/4b1e'), 'Personnel');
  // Today and Settings stand alone.
  assert.equal(group('/'), undefined);
  assert.equal(group('/settings'), undefined);
  // The longest match wins: Awards, not Career plan.
  assert.equal(pageFor('/career/awards')?.label, 'Awards');
  assert.equal(pageFor('/career')?.label, 'Career plan');
  // A trailing slash is the same page, as the router treats it.
  assert.equal(group('/record/'), 'Records');
  assert.equal(pageFor('/record/')?.label, 'Overview');
  assert.equal(group('/career/'), 'Training & Development');
  assert.equal(group('/reports/'), 'Reports & Analytics');
  assert.equal(group('/team/roles/'), 'Administration');
  assert.equal(pageFor('/')?.label, 'Today');
});

test('placeName names a place the way the menu does', () => {
  assert.equal(placeName('/career/awards'), 'Records → Awards');
  assert.equal(placeName('/career/training'), 'Training & Development → Training');
  assert.equal(placeName('/record/activities?import=1'), 'Records → Activities');
  assert.equal(placeName('/team/dashboard'), 'Reports & Analytics → Unit dashboard');
  assert.equal(placeName('/'), 'Today');
  assert.equal(placeName('/settings'), 'Settings');
  assert.equal(placeName('/nowhere'), '/nowhere');
});

test('every old address still lands on a page in the menu, with its query kept', () => {
  const lands = (path: string, search = '') => {
    const to = movedTo(path, search);
    assert.ok(to, `${path}${search} is not redirected`);
    const page = pageFor(to.split('?')[0]);
    assert.ok(page, `${path}${search} lands on ${to}, which is no page`);
    return to;
  };
  for (const from of Object.keys(MOVED)) lands(from);
  const tabs: Record<string, string[]> = {
    '/work': ['queue', 'tasks', 'projects', 'mail'],
    '/record': ['overview', 'entries', 'drafts', 'contributions'],
    '/career': ['plan', 'training', 'awards', 'counseling', 'readiness', 'messages'],
    '/reports': ['packages', 'analysis'],
    '/team': ['overview', 'workload', 'roster', 'dashboard', 'invites', 'roles', 'units', 'audit'],
  };
  for (const [path, list] of Object.entries(tabs)) for (const tab of list) lands(path, `?tab=${tab}`);
  assert.equal(lands('/career', '?tab=awards&open=7'), '/career/awards?open=7');
  assert.equal(movedTo('/career/awards', ''), null, 'a current address is not redirected');
});
