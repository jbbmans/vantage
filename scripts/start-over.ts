import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { createContext } from '../server/app.ts';
import { hashPassword } from '../server/lib/crypto.ts';
import { newId, now, slug } from '../server/lib/ids.ts';
import { claimUnit } from '../server/services/org.ts';
import { audit } from '../server/services/audit.ts';
import { readRoster, applyAccounts, type RosterRow } from '../server/services/accountImport.ts';
import { passwordProblem } from '../shared/password.ts';
import type { SessionUser } from '../server/context.ts';

const USAGE = `Usage:
  VANTAGE_START_OVER=1 VANTAGE_ADMIN_PASSWORD='<password>' node scripts/start-over.ts ERASE-EVERYTHING \\
    --unit "<first unit name>" [--short <short name>] [--admin <username>] [--first <name>] [--last <name>] \\
    [--roster <roster.csv or .xlsx>] [--no-backup]`;

const fail = (message: string): never => { console.error(message); process.exit(1); };

if (process.env.VANTAGE_START_OVER !== '1' || process.argv[2] !== 'ERASE-EVERYTHING') fail(`Refusing: this erases every account, unit and record.\n${USAGE}`);

const argv = process.argv.slice(3);
const flags = new Set<string>(argv.filter((a) => a === '--no-backup'));
const opts = new Map<string, string>();
for (let i = 0; i < argv.length; i += 1) {
  if (flags.has(argv[i])) continue;
  if (!argv[i].startsWith('--') || argv[i + 1] === undefined) fail(`Unexpected argument "${argv[i]}".\n${USAGE}`);
  opts.set(argv[i].slice(2), argv[i + 1]);
  i += 1;
}

const username = (opts.get('admin') || 'vantage.admin').trim().toLowerCase();
const firstName = (opts.get('first') || 'Vantage').trim();
const lastName = (opts.get('last') || 'Admin').trim();
const unitName = (opts.get('unit') || '').trim();
const unitShort = (opts.get('short') || '').trim() || null;
const password = process.env.VANTAGE_ADMIN_PASSWORD || '';

if (!/^[a-z0-9._-]{3,40}$/.test(username)) fail('--admin must be 3 to 40 letters, numbers, dots, dashes or underscores.');
if (!unitName || unitName.length > 120) fail(`--unit is required (the first unit, up to 120 characters).\n${USAGE}`);
const unitId = slug(unitShort || unitName);
if (!unitId) fail('That unit name produces an empty unit code. Use letters or numbers.');
const weak = passwordProblem(password);
if (weak) fail(`VANTAGE_ADMIN_PASSWORD: ${weak}`);

let roster: RosterRow[] = [];
const rosterPath = opts.get('roster');
if (rosterPath) {
  try { roster = readRoster(readFileSync(rosterPath), rosterPath); }
  catch (error) { fail(`The roster could not be read, so nothing was erased: ${(error as Error).message}`); }
}

const config = loadConfig();
const ctx = createContext(config);
const { db } = ctx;

if (!flags.has('--no-backup') && db.name !== ':memory:') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backup = join(dirname(db.name), `vantage-before-start-over-${stamp}.db`);
  await db.backup(backup);
  console.log(`Backed up the current database to ${backup}`);
}

const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('meta', 'ranks') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
const adminId = newId();
db.pragma('foreign_keys = OFF');
try {
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM "${table}"`).run();
    db.prepare("DELETE FROM meta WHERE key = 'audit_head'").run();
    db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, is_operator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(adminId, username, hashPassword(password), firstName, lastName, now(), now());
    db.prepare('INSERT INTO units (id, code, name, short_name, echelon, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(unitId, unitId, unitName, unitShort, 'command', now());
    claimUnit(ctx, unitId, adminId);
    const broken = db.pragma('foreign_key_check') as unknown[];
    if (broken.length) throw new Error(`The erase left ${broken.length} dangling references; nothing was changed.`);
  })();
} finally {
  db.pragma('foreign_keys = ON');
}
audit(ctx, { actor_id: adminId, action: 'setup', entity: 'instance', unit_id: unitId, detail: `started over from the shell; ${tables.length} tables emptied` });
console.log(`Erased all accounts, units and records. ${username} is the Instance Operator and leads ${unitName}.`);

if (roster.length) {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId) as SessionUser;
  const result = applyAccounts(ctx, admin, roster, 'shell');
  audit(ctx, { actor_id: adminId, action: 'accounts_imported', entity: 'instance', detail: `${result.created} created; ${result.counts.error} skipped; ${result.counts.new_units} new units; from the shell` });
  console.log(`Imported ${result.created} accounts. New units: ${result.units.filter((u) => !u.exists).map((u) => (u.parent ? `${u.parent} > ${u.name}` : u.name)).join(', ') || 'none'}.`);
  for (const a of result.accounts) {
    if (a.status === 'error') console.log(`  skipped row ${a.line} (${a.username}): ${a.problems.join(' ')}`);
    else if (a.warnings.length) console.log(`  row ${a.line} (${a.username}): ${a.warnings.join(' ')}`);
  }
  if (result.generated.length) {
    console.log('Temporary passwords made for rows that had none (shown only now):');
    for (const g of result.generated) console.log(`  ${g.username}  ${g.password}`);
  }
}

db.close();
console.log('Done. Everyone signed in before has been signed out; sign in at the site with the new account.');
