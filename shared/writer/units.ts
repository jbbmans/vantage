/** A unit for its count: "1 ULO", "2 ULOs", "1 discrepancy", "1 box". */
export function unitFor(unit = 'items', n: number | string | null | undefined): string {
  if (Number(n) !== 1) return unit;
  if (/ies$/i.test(unit)) return unit.replace(/ies$/i, 'y');
  if (/(ch|sh|ss|x|z)es$/i.test(unit)) return unit.replace(/es$/i, '');
  if (/s$/.test(unit) && !/ss$/i.test(unit)) return unit.slice(0, -1);
  return unit;
}
