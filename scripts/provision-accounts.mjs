/**
 * One-time, shell-only provisioning for a freshly reset Vantage instance.
 *
 * Real personnel data and temporary passwords belong in a chmod 600 JSON file
 * on the deployment host. They must never be committed with this script.
 *
 *   VANTAGE_PROVISION=1 npm run provision:accounts -- \
 *     --input /tmp/vantage-provision.json --delete-input
 */

import { existsSync, readFileSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { hashPassword } from '../server/auth.js';
import { passwordProblem } from '../server/passwordPolicy.js';
import { normalizeUsername } from '../server/identity.js';
import {
  addMember, audit, copyTemplateInto, getDb, grantRole, newId, now,
} from '../server/db.js';

function refuse(message) {
  console.error(`Refusing provisioning: ${message}`);
  process.exit(1);
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function cleanText(value, name, max = 120) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`${name} is required and must be at most ${max} characters.`);
  return text;
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

if (process.env.VANTAGE_PROVISION !== '1') {
  refuse('set VANTAGE_PROVISION=1 for this one invocation.');
}

const inputArg = valueAfter('--input');
if (!inputArg) refuse('pass --input with a private provisioning JSON file.');
if (!process.argv.includes('--delete-input')) {
  refuse('pass --delete-input so plaintext temporary credentials are removed after a successful transaction.');
}
const requestedInput = isAbsolute(inputArg) ? inputArg : resolve(process.cwd(), inputArg);
const inputStat = lstatSync(requestedInput);
if (!inputStat.isFile() || inputStat.isSymbolicLink()) refuse('the input must be a regular file, not a symbolic link.');
if ((inputStat.mode & 0o077) !== 0) refuse('protect the input first: chmod 600 <file>.');
if (inputStat.size > 1024 * 1024) refuse('the provisioning file must not exceed 1 MiB.');
const inputPath = realpathSync(requestedInput);

let payload;
try {
  payload = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch {
  refuse('the input is not valid JSON.');
}

if (!payload || !Array.isArray(payload.units) || !Array.isArray(payload.accounts)) {
  refuse('the input must contain units and accounts arrays.');
}
if (!payload.accounts.length) refuse('at least one account is required.');

const units = payload.units.map((raw, index) => ({
  code: cleanText(raw.code, `units[${index}].code`, 64).toUpperCase(),
  name: cleanText(raw.name, `units[${index}].name`),
  short_name: cleanText(raw.short_name || raw.name, `units[${index}].short_name`, 80),
  echelon: cleanText(raw.echelon || 'fire_team', `units[${index}].echelon`, 40),
  parent_code: cleanText(raw.parent_code || 'MFR', `units[${index}].parent_code`, 64).toUpperCase(),
  owner_username: normalizeUsername(raw.owner_username || ''),
}));

const accounts = payload.accounts.map((raw, index) => {
  const username = normalizeUsername(cleanText(raw.username, `accounts[${index}].username`, 40));
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error(`accounts[${index}].username is invalid.`);
  const passwordIssue = passwordProblem(raw.password);
  if (passwordIssue) throw new Error(`accounts[${index}].password: ${passwordIssue}`);
  const email = cleanText(raw.email, `accounts[${index}].email`, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`accounts[${index}].email is invalid.`);
  const unitCode = cleanText(raw.unit_code, `accounts[${index}].unit_code`, 64).toUpperCase();
  const roleKey = cleanText(raw.role_key || 'marine', `accounts[${index}].role_key`, 64).toLowerCase();
  return {
    username,
    password: raw.password,
    first_name: cleanText(raw.first_name, `accounts[${index}].first_name`, 80),
    last_name: cleanText(raw.last_name, `accounts[${index}].last_name`, 80),
    email,
    unit_code: unitCode,
    role_key: roleKey,
    billet_title: cleanText(raw.billet_title, `accounts[${index}].billet_title`, 120),
    rank_id: raw.rank_id ? cleanText(raw.rank_id, `accounts[${index}].rank_id`, 12) : null,
    mos: raw.mos ? cleanText(raw.mos, `accounts[${index}].mos`, 12) : null,
  };
});

const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(key);
  }
};
unique(units.map((unit) => unit.code), 'unit code');
unique(accounts.map((account) => account.username), 'username');
unique(accounts.map((account) => account.email), 'email');

const rootOwnerUsername = normalizeUsername(cleanText(payload.root_owner_username, 'root_owner_username', 40));
const accountNames = new Set(accounts.map((account) => account.username));
if (!accountNames.has(rootOwnerUsername)) throw new Error('root_owner_username must name an account in this batch.');
for (const unit of units) {
  if (!unit.owner_username) throw new Error(`unit ${unit.code} requires owner_username.`);
  if (!accountNames.has(unit.owner_username)) throw new Error(`unit ${unit.code} owner is not an account in this batch.`);
}

const db = getDb();
const maintenancePath = `${db.name}.maintenance`;
if (!existsSync(maintenancePath)) {
  db.close();
  refuse('the factory-reset maintenance lock is missing; do not provision against an open service.');
}
const currentUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
const currentUnits = db.prepare('SELECT code FROM units WHERE active = 1 ORDER BY code').all().map((row) => row.code);
if (currentUsers !== 0 || JSON.stringify(currentUnits) !== JSON.stringify(['MFR'])) {
  db.close();
  refuse('provisioning only runs immediately after factory reset (0 users and only MFR).');
}

const allowedRoles = new Set(
  db.prepare('SELECT template_key FROM roles WHERE unit_id = ?').all('MFR').map((row) => row.template_key)
);
for (const account of accounts) {
  if (!allowedRoles.has(account.role_key)) throw new Error(`unknown default role key for ${account.username}: ${account.role_key}`);
}

const suppliedUnitCodes = new Set(['MFR', ...units.map((unit) => unit.code)]);
for (const unit of units) {
  if (unit.code === 'MFR') throw new Error('MFR is the existing root and must not appear in units.');
  if (!suppliedUnitCodes.has(unit.parent_code)) throw new Error(`unit ${unit.code} has an unknown parent ${unit.parent_code}.`);
}
for (const account of accounts) {
  if (!suppliedUnitCodes.has(account.unit_code)) throw new Error(`account ${account.username} has an unknown unit ${account.unit_code}.`);
}

const createdUsers = new Map();
const createdAt = now();

db.transaction(() => {
  const insertUnit = db.prepare(
    `INSERT INTO units (id, code, name, short_name, echelon, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const pending = [...units];
  const createdCodes = new Set(['MFR']);
  while (pending.length) {
    const readyIndex = pending.findIndex((unit) => createdCodes.has(unit.parent_code));
    if (readyIndex === -1) throw new Error('unit hierarchy contains a cycle.');
    const [unit] = pending.splice(readyIndex, 1);
    insertUnit.run(unit.code, unit.code, unit.name, unit.short_name, unit.echelon, unit.parent_code, createdAt);
    copyTemplateInto(unit.code);
    createdCodes.add(unit.code);
  }

  const billetTitles = new Set(accounts.map((account) => account.billet_title));
  const insertBillet = db.prepare(
    `INSERT INTO billets (id, title, category, echelon, default_role)
     VALUES (?, ?, 'Comptroller', 'fire_team', 'member')
     ON CONFLICT(title) DO NOTHING`
  );
  for (const title of billetTitles) insertBillet.run(slug(title), title);

  const insertUser = db.prepare(
    `INSERT INTO users
       (id, username, password_hash, last_name, first_name, rank_id, mos, email,
        must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertAssignment = db.prepare(
    `INSERT INTO assignments
       (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
     VALUES (?, ?, ?, ?, '', 1, ?, ?)`
  );

  for (const account of accounts) {
    const id = newId();
    createdUsers.set(account.username, id);
    insertUser.run(
      id, account.username, hashPassword(account.password), account.last_name, account.first_name,
      account.rank_id, account.mos, account.email, createdAt, createdAt,
    );
    insertAssignment.run(
      newId(), id, account.unit_code, slug(account.billet_title), createdAt.slice(0, 10), createdAt,
    );
    addMember(id, account.unit_code, { kind: 'member' });
    grantRole(id, `${account.unit_code}:marine`, account.unit_code, null);
    if (account.role_key !== 'marine') {
      grantRole(id, `${account.unit_code}:${account.role_key}`, account.unit_code, null);
    }
  }

  const ownership = [['MFR', rootOwnerUsername], ...units.map((unit) => [unit.code, unit.owner_username])];
  for (const [unitCode, ownerUsername] of ownership) {
    const ownerId = createdUsers.get(ownerUsername);
    addMember(ownerId, unitCode, { kind: 'owner' });
    db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ownerId, unitCode);
    grantRole(ownerId, `${unitCode}:unit-leader`, unitCode, ownerId);
  }

  const actorId = createdUsers.get(rootOwnerUsername);
  audit({
    actor_id: actorId,
    action: 'initial_provisioning',
    entity: 'database',
    subject_id: actorId,
    unit_id: 'MFR',
    detail: `${accounts.length} account(s) and ${units.length} subordinate unit(s); temporary passwords require change`,
  });
})();

const result = {
  accounts: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  units: db.prepare('SELECT COUNT(*) AS count FROM units WHERE active = 1').get().count,
  owners: db.prepare('SELECT COUNT(*) AS count FROM units WHERE active = 1 AND owner_user_id IS NOT NULL').get().count,
  forcedChanges: db.prepare('SELECT COUNT(*) AS count FROM users WHERE must_change_password = 1').get().count,
  violations: db.pragma('foreign_key_check'),
};
db.close();

if (result.violations.length || result.accounts !== accounts.length || result.owners !== units.length + 1) {
  console.error('Provisioning verification failed. Restore the pre-reset backup before allowing sign-in.');
  process.exit(2);
}

unlinkSync(inputPath);
unlinkSync(maintenancePath);
console.log(`Provisioning complete: ${result.accounts} accounts, ${result.units} units, ${result.owners} Unit Leaders.`);
console.log(`All ${result.forcedChanges} accounts must replace their temporary password at first sign-in.`);
console.log('Private provisioning input deleted and maintenance lock released. Restart Vantage before sign-in.');
