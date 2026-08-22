/**
 * Vantage — org chart. Display only.
 *
 * This module exists so that `parent_id` has somewhere to live that is not
 * `permissions.js`. Under v3.4 Decision 2, hierarchy is a label and not an
 * authority: L1/L2/L3/L4 and `parent_id` describe how a human should read the
 * org chart, and convey no permission, no visibility and no reach.
 *
 * Everything below may be used to DRAW a tree. Nothing below may be used to
 * answer "can this user." That line is held by a static test
 * (tests/static.test.mjs), not by discipline — v3.3 proved discipline is not
 * enough, because the tree walk started as a display helper too.
 *
 * If you find yourself importing this file into permissions.js, roleGuard.js,
 * lifecycle.js or a needs(...) guard, stop: the answer you want is
 * `permissionsIn(db, user, unitId)`, and if that returns zero, the answer is no.
 */

/** Self-declared org levels. Purely descriptive — labels and sort order only. */
export const LEVELS = ['L1', 'L2', 'L3', 'L4'];

export const LEVEL_LABELS = {
  L1: 'L1 — Command',
  L2: 'L2 — Major subordinate',
  L3: 'L3 — Battalion / squadron',
  L4: 'L4 — Section / shop',
};

function unitIndex(db) {
  const units = db.prepare('SELECT id, parent_id FROM units WHERE active = 1').all();
  const byParent = new Map();
  for (const u of units) {
    if (!byParent.has(u.parent_id)) byParent.set(u.parent_id, []);
    byParent.get(u.parent_id).push(u.id);
  }
  return { byParent };
}

/**
 * Every unit id at or beneath the given roots.
 *
 * DISPLAY ONLY. In v3.3 this fed `permissionMap`, and that is precisely the
 * behaviour finding 2 removes.
 */
export function subtreeIds(db, rootIds = []) {
  if (!rootIds.length) return [];
  const { byParent } = unitIndex(db);
  const out = new Set();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift();
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byParent.get(id) || []) queue.push(child);
  }
  return [...out];
}

/** Ancestor chain for a unit, nearest first. DISPLAY ONLY — breadcrumbs. */
export function ancestorChain(db, unitId) {
  const chain = [];
  let current = unitId;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const unit = db
      .prepare('SELECT id, code, name, short_name, echelon, level, parent_id FROM units WHERE id = ?')
      .get(current);
    if (!unit) break;
    chain.push(unit);
    current = unit.parent_id;
  }
  return chain;
}

/** DISPLAY ONLY. */
export function ancestorIds(db, unitIds = []) {
  const out = new Set();
  for (const id of unitIds) for (const u of ancestorChain(db, id)) out.add(u.id);
  return [...out];
}

/**
 * Reparenting guard. A unit may not be made a descendant of itself — the only
 * thing about the tree that still has teeth, and it is a data-integrity rule
 * rather than an authorization one.
 */
export function wouldCycle(db, unitId, newParentId) {
  if (!newParentId) return false;
  if (unitId === newParentId) return true;
  return subtreeIds(db, [unitId]).includes(newParentId);
}
