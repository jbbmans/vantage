/* DISPLAY ONLY: organization hierarchy never grants authorization. */

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

export function ancestorIds(db, unitIds = []) {
  const out = new Set();
  for (const id of unitIds) for (const u of ancestorChain(db, id)) out.add(u.id);
  return [...out];
}

export function wouldCycle(db, unitId, newParentId) {
  if (!newParentId) return false;
  if (unitId === newParentId) return true;
  return subtreeIds(db, [unitId]).includes(newParentId);
}
