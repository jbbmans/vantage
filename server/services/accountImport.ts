import { randomBytes } from 'node:crypto';
import type { AppContext, SessionUser } from '../context.ts';
import { readWorkbook, readDelimited, sniffDelimiter, WorkbookError, ZipError } from '../lib/workbook.ts';
import { badRequest } from '../lib/errors.ts';
import { hashPassword } from '../lib/crypto.ts';
import { newId, now, slug } from '../lib/ids.ts';
import { passwordProblem } from '../../shared/password.ts';
import { ROLE_TEMPLATE } from '../../shared/permissions.ts';
import { addMember, claimUnit } from './org.ts';
import { audit } from './audit.ts';

export const MAX_ACCOUNT_ROWS = 500;

type Field = 'rank' | 'first_name' | 'last_name' | 'command' | 'team' | 'username' | 'email' | 'password' | 'role' | 'billet';

const HEADERS: Record<Field, string[]> = {
  rank: ['rank', 'grade', 'payGrade'],
  first_name: ['firstName', 'first', 'givenName'],
  last_name: ['lastName', 'last', 'surname', 'familyName'],
  command: ['l2Command', 'command', 'parentUnit', 'organization', 'l2'],
  team: ['fireTeam', 'team', 'unit', 'section', 'subUnit', 'shop', 'l3'],
  username: ['username', 'userName', 'login', 'user'],
  email: ['email', 'emailAddress', 'mail'],
  password: ['temporaryPassword', 'tempPassword', 'initialPassword', 'password'],
  role: ['role', 'vantageRole'],
  billet: ['billet', 'position', 'jobTitle', 'title'],
};

const key = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface RosterRow { line: number; values: Record<Field, string> }

export function readRoster(buffer: Buffer, filename: string): RosterRow[] {
  let matrix: string[][];
  const isWorkbook = /\.xlsx$/i.test(filename) || buffer.subarray(0, 2).toString('latin1') === 'PK';
  try {
    if (isWorkbook) {
      const sheet = readWorkbook(buffer, { maxRows: MAX_ACCOUNT_ROWS + 20 }).sheets.find((s) => s.rows.some((r) => r.some((c) => key(c) === 'username')));
      if (!sheet) throw badRequest('No sheet in this workbook has a Username column.');
      matrix = sheet.rows;
    } else {
      const text = buffer.toString('utf8');
      matrix = readDelimited(text, sniffDelimiter(text));
    }
  } catch (error) {
    if (error instanceof WorkbookError || error instanceof ZipError) throw badRequest(error.message);
    throw error;
  }

  const headerAt = matrix.findIndex((r) => r.some((c) => key(c) === 'username'));
  if (headerAt < 0) throw badRequest('The roster needs a header row with at least Username, First Name and Last Name.');
  const header = matrix[headerAt].map(key);
  const column = {} as Record<Field, number>;
  for (const field of Object.keys(HEADERS) as Field[]) column[field] = header.findIndex((h) => HEADERS[field].some((name) => key(name) === h));
  for (const field of ['username', 'first_name', 'last_name'] as const) {
    if (column[field] < 0) throw badRequest(`The roster has no ${field.replace('_', ' ')} column.`);
  }

  const rows: RosterRow[] = [];
  for (let i = headerAt + 1; i < matrix.length; i += 1) {
    const cells = matrix[i];
    if (!cells.some((c) => String(c || '').trim())) continue;
    const values = {} as Record<Field, string>;
    for (const field of Object.keys(HEADERS) as Field[]) values[field] = column[field] < 0 ? '' : String(cells[column[field]] ?? '').trim();
    rows.push({ line: i + 1, values });
  }
  if (!rows.length) throw badRequest('The roster has a header but no people under it.');
  if (rows.length > MAX_ACCOUNT_ROWS) throw badRequest(`Import at most ${MAX_ACCOUNT_ROWS} accounts at a time.`);
  return rows;
}

interface UnitRef { name: string; parent: string | null; id: string | null }

export interface PlannedAccount {
  line: number;
  username: string;
  name: string;
  rank_id: string | null;
  email: string | null;
  command: string | null;
  team: string | null;
  role: string;
  billet: string | null;
  status: 'create' | 'exists' | 'error';
  problems: string[];
  warnings: string[];
  generated_password: boolean;
}

export interface AccountPlan {
  accounts: PlannedAccount[];
  units: Array<{ name: string; parent: string | null; exists: boolean }>;
  counts: { create: number; exists: number; error: number; new_units: number };
}

const USERNAME = /^[a-z0-9._-]{3,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function findUnit(ctx: AppContext, name: string, parentId: string | null): string | null {
  const wanted = key(name);
  const candidates = ctx.db.prepare(`SELECT id, name, short_name, code FROM units WHERE active = 1 AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`)
    .all(...(parentId ? [parentId] : [])) as Array<{ id: string; name: string; short_name: string | null; code: string }>;
  return candidates.find((u) => [u.name, u.short_name, u.code].some((v) => v && key(v) === wanted))?.id ?? null;
}

function roleFor(name: string): { key: string; label: string } | null {
  const wanted = key(name || 'Marine');
  const role = ROLE_TEMPLATE.find((r) => key(r.name) === wanted || key(r.key) === wanted);
  return role ? { key: role.key, label: role.name } : null;
}

function rankFor(ctx: AppContext, value: string): string | null {
  if (!value) return null;
  const wanted = key(value);
  const rows = ctx.db.prepare('SELECT id, abbr, name, grade FROM ranks').all() as Array<{ id: string; abbr: string; name: string; grade: string }>;
  return rows.find((r) => [r.id, r.abbr, r.name, r.grade].some((v) => key(v) === wanted))?.id ?? null;
}

export function planAccounts(ctx: AppContext, rows: RosterRow[]): AccountPlan {
  const seenUsers = new Set<string>();
  const seenEmails = new Set<string>();
  const units = new Map<string, UnitRef & { exists: boolean }>();
  const accounts: PlannedAccount[] = [];

  const unitKey = (name: string, parent: string | null) => `${parent ? key(parent) : ''}/${key(name)}`;
  const noteUnit = (name: string, parent: string | null) => {
    const k = unitKey(name, parent);
    if (units.has(k)) return;
    const parentId = parent ? units.get(unitKey(parent, null))?.id ?? null : null;
    const id = parent && !parentId ? null : findUnit(ctx, name, parentId);
    units.set(k, { name, parent, id, exists: Boolean(id) });
  };

  for (const { line, values: v } of rows) {
    const problems: string[] = [];
    const warnings: string[] = [];
    const username = v.username.toLowerCase();
    if (!USERNAME.test(username)) problems.push('Usernames are 3 to 40 letters, numbers, dots, dashes or underscores.');
    else if (seenUsers.has(username)) problems.push('This username appears earlier in the roster.');
    seenUsers.add(username);
    if (!v.first_name || !v.last_name) problems.push('First and last name are both required.');

    let email: string | null = v.email ? v.email.toLowerCase() : null;
    if (email && !EMAIL.test(email)) { warnings.push('The email address is not valid, so the account is created without one.'); email = null; }
    if (email && (seenEmails.has(email) || ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email))) {
      warnings.push('That email already belongs to another account, so this one is created without it.');
      email = null;
    }
    if (email) seenEmails.add(email);

    const rankId = rankFor(ctx, v.rank);
    if (v.rank && !rankId) warnings.push(`“${v.rank}” is not a rank Vantage knows, so none is set.`);

    const role = roleFor(v.role);
    if (!role) problems.push(`“${v.role}” is not a role. Use one of: ${ROLE_TEMPLATE.filter((r) => !r.owner).map((r) => r.name).join(', ')}.`);
    else if (role.key === 'unit-leader') problems.push('Unit Leader goes with ownership of the unit and cannot be imported.');

    if (v.password) {
      const weak = passwordProblem(v.password);
      if (weak) problems.push(`Temporary password: ${weak}`);
    }

    const command = v.command || null;
    const team = v.team || null;
    if (command) noteUnit(command, null);
    if (team) noteUnit(team, command);
    if (!command && !team) warnings.push('No unit is named, so the account is created without a membership.');

    const exists = USERNAME.test(username) && Boolean(ctx.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username));
    accounts.push({
      line, username, name: `${v.last_name}, ${v.first_name}`.trim(), rank_id: rankId, email, command, team,
      role: role?.label || v.role, billet: v.billet || null,
      status: problems.length ? 'error' : exists ? 'exists' : 'create',
      problems, warnings: exists && !problems.length ? ['An account with this username already exists; it is left as it is.'] : warnings,
      generated_password: !v.password,
    });
  }

  const unitList = [...units.values()].map((u) => ({ name: u.name, parent: u.parent, exists: u.exists }));
  return {
    accounts,
    units: unitList,
    counts: {
      create: accounts.filter((a) => a.status === 'create').length,
      exists: accounts.filter((a) => a.status === 'exists').length,
      error: accounts.filter((a) => a.status === 'error').length,
      new_units: unitList.filter((u) => !u.exists).length,
    },
  };
}

const passphrase = () => {
  const words = ['anchor', 'basalt', 'cedar', 'delta', 'ember', 'falcon', 'granite', 'harbor', 'island', 'juniper', 'kestrel', 'lantern', 'meadow', 'north', 'orchard', 'prairie', 'quartz', 'ridge', 'summit', 'timber', 'valley', 'willow'];
  const pick = () => words[randomBytes(1)[0] % words.length];
  return `${pick()}-${pick()}-${pick()}-${randomBytes(2).readUInt16BE(0) % 9000 + 1000}`;
};

/**
 * Creates every account the plan marks for creation, the units they name (owned by the importer), their rank,
 * role and billet. Everyone signs in with a temporary password and must set their own. Rows with a problem are
 * skipped; nothing is written unless the whole batch succeeds.
 */
export function applyAccounts(ctx: AppContext, actor: SessionUser, rows: RosterRow[], ip?: string) {
  const plan = planAccounts(ctx, rows);
  const byLine = new Map(rows.map((r) => [r.line, r.values]));
  const unitIds = new Map<string, string>();
  const generated: Array<{ username: string; password: string }> = [];
  const hashes = new Map<number, string>();
  for (const a of plan.accounts) {
    if (a.status !== 'create') continue;
    const given = byLine.get(a.line)!.password;
    const password = given || passphrase();
    if (!given) generated.push({ username: a.username, password });
    hashes.set(a.line, hashPassword(password));
  }

  const ensureUnit = (name: string, parentId: string | null): string => {
    const cacheKey = `${parentId || ''}/${key(name)}`;
    const cached = unitIds.get(cacheKey);
    if (cached) return cached;
    let id = findUnit(ctx, name, parentId);
    if (!id) {
      const base = slug(name) || 'UNIT';
      id = base;
      for (let n = 2; ctx.db.prepare('SELECT 1 FROM units WHERE id = ?').get(id); n += 1) id = `${base}-${n}`.slice(0, 40);
      const short = name.length <= 16 ? name : null;
      ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, id, name.slice(0, 120), short, parentId ? 'section' : 'command', parentId, now());
      claimUnit(ctx, id, actor.id);
      audit(ctx, { actor_id: actor.id, action: 'create_unit', entity: 'unit', entity_id: id, unit_id: id, detail: `${name}; account import`, ip });
    }
    unitIds.set(cacheKey, id);
    return id;
  };

  let created = 0;
  ctx.db.transaction(() => {
    for (const a of plan.accounts) {
      if (a.status !== 'create') continue;
      const v = byLine.get(a.line)!;
      const commandId = a.command ? ensureUnit(a.command, null) : null;
      const teamId = a.team ? ensureUnit(a.team, commandId) : null;
      const unitId = teamId || commandId;
      const id = newId();
      ctx.db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, rank_id, must_change_password, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, a.username, a.email, hashes.get(a.line), v.first_name, v.last_name, a.rank_id, now(), now());
      if (commandId) addMember(ctx, id, commandId, { invitedBy: actor.id, primary: true, billet: teamId ? null : a.billet });
      if (teamId) addMember(ctx, id, teamId, { invitedBy: actor.id, primary: !commandId, billet: a.billet });
      if (unitId) {
        const role = roleFor(v.role);
        if (role && role.key !== 'marine') {
          ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, `${unitId}:${role.key}`.slice(0, 120), unitId, actor.id, now());
        }
      }
      audit(ctx, { actor_id: actor.id, action: 'account_imported', entity: 'user', entity_id: id, subject_id: id, unit_id: unitId, detail: `${a.username}; ${a.role}`, ip });
      created += 1;
    }
  })();
  return { ...plan, created, generated };
}
