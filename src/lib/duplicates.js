const NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'with', 'in', 'on', 'at',
  'by', 'from', 'via', 'per', 'totaling', 'totalling', 'across', 'over',
]);

export function titleFingerprint(title = '') {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .sort()
    .join(' ');
}

export function signature(a = {}) {
  const date = String(a.date || '').slice(0, 10);
  const money = a.dollar_amount == null || a.dollar_amount === '' ? '' : Number(a.dollar_amount).toFixed(2);
  const qty = a.quantity == null || a.quantity === '' ? '' : String(Number(a.quantity));
  return [date, money, qty, titleFingerprint(a.title)].join('|');
}

export function titleSimilarity(a = '', b = '') {
  const setA = new Set(titleFingerprint(a).split(' ').filter(Boolean));
  const setB = new Set(titleFingerprint(b).split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

export function screenImport(incoming = [], existing = []) {
  const index = new Map();
  for (const rec of existing) index.set(signature(rec), rec);

  const fresh = [];
  const exact = [];
  const near = [];
  const seenThisBatch = new Set();

  for (const row of incoming) {
    const sig = signature(row);

    if (index.has(sig) || seenThisBatch.has(sig)) {
      exact.push(row);
      continue;
    }

    const sameDay = existing.filter((e) => String(e.date || '').slice(0, 10) === String(row.date || '').slice(0, 10));
    let best = null;
    for (const candidate of sameDay) {
      const score = titleSimilarity(row.title, candidate.title);
      if (score >= 0.7 && (!best || score > best.score)) best = { row, match: candidate, score };
    }
    if (best) near.push(best);

    seenThisBatch.add(sig);
    fresh.push(row);
  }

  return { fresh, exact, near };
}

export function findDuplicates(records = []) {
  const groups = new Map();
  for (const rec of records) {
    const sig = signature(rec);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(rec);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      signature: signature(group[0]),
      records: [...group].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')),

      inflatedBy: (group.length - 1) * (Number(group[0].dollar_amount) || 0),
    }))
    .sort((a, b) => b.inflatedBy - a.inflatedBy || b.records.length - a.records.length);
}
