import { policyOn } from './dutyScoring.ts';

/**
 * Tables that change by publication (ADR-0046). Each version takes effect on a date, says where it was published, and
 * is never edited once released: a change is a new version with its own date and source, so an estimate can always say
 * which rules it read and an old one can be read again under the rules of its day.
 */

/** Where a version's numbers were published: the document, the place in it, and a link to it. */
export interface Citation { source: string; where: string; url: string }

export interface TableVersion<T> {
  /** Stable name of this version, used in the fingerprint register and on screen. */
  id: string;
  /** The first day the version applies, YYYY-MM-DD. */
  effective_from: string;
  cites: readonly Citation[];
  /** A reading the source leaves open, said plainly where the version applies it. */
  notes?: readonly string[];
  data: T;
}

export interface VersionedTable<T> {
  name: string;
  versions: readonly TableVersion<T>[];
  /** The version in effect on a day: the newest that took effect on or before it, or null before the first. */
  inForce(on: string): TableVersion<T> | null;
  byId(id: string): TableVersion<T> | undefined;
}

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A versioned table, checked and frozen. A malformed one is a programming error, so it throws as the module loads. */
export function versioned<T>(name: string, versions: Array<TableVersion<T>>): VersionedTable<T> {
  if (!versions.length) throw new Error(`${name}: a versioned table needs at least one version.`);
  const ids = new Set<string>();
  versions.forEach((v, i) => {
    if (!v.id || ids.has(v.id)) throw new Error(`${name}: version ids must be present and unique (${v.id || 'blank'}).`);
    ids.add(v.id);
    if (!ISO_DAY.test(v.effective_from)) throw new Error(`${name}: ${v.id} needs an effective date as YYYY-MM-DD.`);
    if (i > 0 && v.effective_from <= versions[i - 1].effective_from) throw new Error(`${name}: ${v.id} must take effect after ${versions[i - 1].id}.`);
    if (!v.cites.length || v.cites.some((c) => !c.source || !c.where || !c.url)) throw new Error(`${name}: ${v.id} must cite its source.`);
  });
  const frozen = deepFreeze(versions);
  // A published version is never withdrawn: one that stops applying is followed by the version that replaces it.
  const dated = frozen.map((v) => ({ v, effective_from: v.effective_from, withdrawn_at: null }));
  return {
    name,
    versions: frozen,
    inForce(on: string) {
      if (!ISO_DAY.test(on)) throw new Error(`${name}: ${on} is not a YYYY-MM-DD day.`);
      return policyOn(dated, on)?.v ?? null;
    },
    byId: (id: string) => frozen.find((v) => v.id === id),
  };
}

/** JSON with every object's keys in order, so the same version always reads the same and its fingerprint is stable. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
