import { rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const DB = `${OUT}.building`;
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';

const { app } = await import('./server/index.js');
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {  }
  return { status: res.status, body: json };
};
const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).body?.token;
const PW = (u) => `${u}-long-enough-passphrase`;
const must = (res, what) => {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

must(await call('POST', '/api/setup', {
  body: { username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927', first_name: 'John', last_name: 'Boletz', rank_id: 'SSgt', unit_code: 'CE-G8' },
}), 'setup');
const admin = await login('boletz', 'cobalt-orbit-velvet-anchor-927');

const people = [
  ['hayes', 'CE-G8', 'section-head', 'GySgt'],
  ['nguyen', 'G8-FMRAC', 'ncoic', 'Sgt'],
  ['ohara', 'G8-FMRAC', 'fire-team-leader', 'Cpl'],
  ['rivera', 'G8-FMRAC', null, 'LCpl'],
  ['kramer', 'G8-BUDGET', 'training-nco', 'Cpl'],
  ['delgado', 'G8-BUDGET', null, 'LCpl'],
  ['zed', 'CLR-4', null, 'LCpl'],
  ['clrlead', 'CLR-4', 'section-head', 'GySgt'],
];
for (const [username, unit_id, role_id, rank_id] of people) {
  must(await call('POST', '/api/team', {
    token: admin,
    body: { username, password: PW(username), first_name: 'M', last_name: username, rank_id, mos: '3451', unit_id, role_id },
  }), `create ${username}`);
}

const branchRole = must(await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Branch Manager', unit_id: 'CE-G8', position: 25, inherits_down: 1, permissions: 767 },
}), 'branch role');

const flatRole = must(await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Budget Clerk', unit_id: 'G8-BUDGET', position: 5, inherits_down: 0, permissions: 3 },
}), 'flat role');

const roster = must(await call('GET', '/api/team', { token: admin }), 'roster').roster;
const id = (u) => roster.find((r) => r.username === u).id;

must(await call('POST', `/api/team/${id('nguyen')}/roles`, {
  token: admin, body: { role_id: branchRole.id, unit_id: 'CE-G8' },
}), 'grant branch');
must(await call('POST', `/api/team/${id('delgado')}/roles`, {
  token: admin, body: { role_id: flatRole.id, unit_id: 'G8-BUDGET' },
}), 'grant flat');

const tokens = {};
for (const [username] of people) tokens[username] = await login(username, PW(username));

let n = 0;
const rec = async (who, table, body) => must(await call('POST', `/api/${table}`, { token: tokens[who], body }), `${table} ${(n += 1)}`);
for (const who of ['rivera', 'ohara', 'kramer', 'zed']) {
  const unit = people.find((p) => p[0] === who)[1];
  await rec(who, 'activities', { title: `${who} chain activity`, date: '2026-07-01', visibility: 'chain', unit_id: unit, jepes_area: 'MOS / Mission Accomplishment' });
  await rec(who, 'activities', { title: `${who} unit activity`, date: '2026-07-02', visibility: 'unit', unit_id: unit });
  await rec(who, 'activities', { title: `${who} private activity`, date: '2026-07-03', visibility: 'private' });
  await rec(who, 'recognitions', { title: `${who} recognition`, date: '2026-07-04', visibility: 'chain', unit_id: unit });
  await rec(who, 'trainings', { title: `${who} training`, date: '2026-07-05', visibility: 'chain', unit_id: unit, hours: 4 });
  await rec(who, 'projects', { name: `${who} project`, visibility: 'private' });
  await rec(who, 'goals', { title: `${who} goal`, target_value: 10, visibility: 'private' });
  await rec(who, 'tasks', { title: `${who} task`, visibility: 'private' });
}

server.close();

const { getDb } = await import('./server/db.js');
const { permissionsIn } = await import('./server/permissions.js');
const db = getDb(DB);

const users = db.prepare('SELECT id, username, is_admin, active FROM users').all();
const units = db.prepare('SELECT id FROM units WHERE active = 1 ORDER BY id').all().map((u) => u.id);

const snapshot = { version: '3.3.0', users: {}, counts: {}, visibility: {} };
for (const u of users) {
  snapshot.users[u.username] = { id: u.id, permissions: {} };
  for (const unitId of units) {
    const bits = permissionsIn(db, u, unitId);
    if (bits) snapshot.users[u.username].permissions[unitId] = bits;
  }
}
for (const t of ['units', 'users', 'roles', 'member_roles', 'assignments', 'activities', 'recognitions', 'trainings', 'projects', 'goals', 'tasks', 'audit_log']) {
  snapshot.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
for (const t of ['activities', 'recognitions', 'trainings']) {
  snapshot.visibility[t] = Object.fromEntries(
    db.prepare(`SELECT visibility, COUNT(*) AS n FROM ${t} GROUP BY visibility`).all().map((r) => [r.visibility, r.n])
  );
}
snapshot.globalRoles = db.prepare('SELECT COUNT(*) AS n FROM roles WHERE unit_id IS NULL').get().n;
snapshot.schemaVersion = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

copyFileSync(DB, OUT);
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
writeFileSync(join(OUT.replace(/\.db$/, '') + '.snapshot.json'), JSON.stringify(snapshot, null, 2));

console.log(`captured ${OUT}`);
console.log(`  schema_version ${snapshot.schemaVersion}, ${snapshot.globalRoles} global roles`);
console.log(`  ${Object.entries(snapshot.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  chain rows: ${Object.entries(snapshot.visibility).map(([t, v]) => `${t}=${v.chain || 0}`).join(' ')}`);
process.exit(0);
