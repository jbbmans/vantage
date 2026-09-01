import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0;
const failures = [];
const check = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok    ${label}`);
  } catch (err) {
    failures.push(`${label}\n        ${err.message}`);
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
};

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""');
}

const AUTH_MODULES = ['server/permissions.js', 'server/roleGuard.js', 'server/lifecycle.js'];
const FORBIDDEN = ['parent_id', 'subtreeIds', 'ancestorIds', 'ancestorChain'];

for (const mod of AUTH_MODULES) {
  const code = codeOnly(read(mod));
  for (const term of FORBIDDEN) {
    check(`${mod} does not reference ${term}`, () => {
      const hit = code.includes(term);
      assert.equal(hit, false, `${term} appears in executable code in ${mod}. Hierarchy conveys no authority (Decision 2).`);
    });
  }
  check(`${mod} does not import org.js`, () => {
    assert.equal(
      /from\s*''[^']*org\.js''/.test(code) || code.includes('org.js'), false,
      `${mod} imports the display-only org module. If you need to know whether someone may act, call permissionsIn(db, user, unitId).`
    );
  });
}

check('org.js carries its display-only warning', () => {
  const src = read('server/org.js');
  assert.ok(src.includes('DISPLAY ONLY') || src.includes('Display only'),
    'org.js must state that it is display-only, in the file someone edits to break the rule.');
});

check('canAnywhere no longer exists', () => {
  const src = read('server/permissions.js');
  assert.equal(/export\s+function\s+canAnywhere/.test(src), false,
    'canAnywhere answers "anywhere in the database", which under tenancy is a question with no correct answer (finding 8).');
});

check('the ADMINISTRATOR global fan-out is gone', () => {
  const code = codeOnly(read('server/permissions.js'));
  assert.equal(/SELECT\s+id\s+FROM\s+units/i.test(code), false,
    'permissionMap must not enumerate every unit in the database. That was the cross-tenant superuser (finding 4).');
  assert.equal(/\bglobal\s*\|=/.test(code), false, 'the `global` permission accumulator must not return.');
});

for (const mod of ['server/permissions.js', 'server/roleGuard.js', 'server/db.js', 'server/index.js']) {
  check(`${mod} does not use inherits_down`, () => {
    const code = codeOnly(read(mod));
    assert.equal(code.includes('inherits_down'), false,
      `inherits_down survives in ${mod}. A role grants inside the unit it was granted in, full stop (finding 2).`);
  });
}

const VIS_SURFACE = [
  'server/permissions.js', 'server/validate.js', 'server/index.js',
  'src/components/VisibilityPicker.jsx', 'src/components/QuickLog.jsx',
];
for (const mod of VIS_SURFACE) {
  check(`${mod} does not offer 'chain' visibility`, () => {
    const src = read(mod);



    const hit = /['"`]chain['"`]/.test(src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 '));
    assert.equal(hit, false, `'chain' appears as a value in ${mod}. It was deleted in finding 3.`);
  });
}

check("db.js references 'chain' only inside migration 007", () => {
  const src = read('server/db.js');
  const start = src.indexOf("name: '007_retire_chain_visibility'");
  assert.notEqual(start, -1, 'migration 007 is missing');
  const end = src.indexOf('migration_007_report', start);
  const migration = src.slice(start, end);
  assert.ok(/['"`]chain['"`]/.test(migration), 'migration 007 must name the visibility it retires.');

  const rest = (src.slice(0, start) + src.slice(end))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.equal(/['"`]chain['"`]/.test(rest), false,
    "'chain' appears in db.js outside migration 007. Live code must not know the value exists.");
});

check('roles.unit_id is declared NOT NULL', () => {
  const src = read('server/db.js');
  const table = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS roles'));
  const line = table.split('\n').find((l) => l.trim().startsWith('unit_id'));
  assert.ok(line, 'roles table has no unit_id column');
  assert.ok(/NOT NULL/.test(line), `roles.unit_id must be NOT NULL — there is no global role definition (finding 1). Got: ${line.trim()}`);
});

check('no record table defaults to chain visibility', () => {
  const src = read('server/db.js');
  assert.equal(/visibility[^\n]*DEFAULT\s*'chain'/.test(src), false, "a record table still defaults to 'chain'.");
});

check('units.owner_user_id exists', () => {
  const src = read('server/db.js');
  assert.ok(/owner_user_id/.test(src), 'units.owner_user_id is where Unit Owner lives (finding 4).');
});

check('needs(...) guards all resolve a unit id', () => {
  const src = read('server/index.js');
  const guard = src.slice(src.indexOf('const needs ='), src.indexOf('const needs =') + 600);
  assert.ok(/if\s*\(!unitId\)/.test(guard),
    'the needs() guard must refuse when it cannot name a unit, rather than falling through to a global check.');
});

check('instance.js grants no permissions', () => {
  const code = codeOnly(read('server/instance.js'));
  assert.equal(/ALL_PERMISSIONS|PERMISSIONS\./.test(code), false,
    'the Instance Operator must not carry permission bits — it gates a small set of instance routes and nothing else (finding 4).');
});

const serverFiles = readdirSync(join(ROOT, 'server')).filter((f) => f.endsWith('.js'));
for (const f of serverFiles) {
  check(`server/${f} does not import SYSTEM_ROLES`, () => {
    const code = codeOnly(read(`server/${f}`));
    assert.equal(/\bSYSTEM_ROLES\b/.test(code), false,
      'SYSTEM_ROLES is a template set now (ROLE_TEMPLATES), not a seeded row set (finding 1).');
  });
}

console.log(`\n${pass}/${pass + failures.length} static invariants hold`);
assert.equal(failures.length, 0, `static invariants failed:\n${failures.join('\n')}`);
process.exit(0);
