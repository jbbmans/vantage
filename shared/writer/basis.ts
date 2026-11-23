import type { CaseWork } from './compose.ts';

/** The fields the writer reads from an entry: a change to any of them can change what the narrative says. */
const FIELDS = ['title', 'result', 'quantity', 'unit_label', 'dollar_amount', 'dollar_type', 'system', 'organization', 'eval_area', 'category', 'date', 'end_date', 'ongoing', 'status'] as const;

/** FNV-1a, 32 bits, as hex: short, stable, and enough to tell that a field changed. Not a security measure. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const norm = (v: unknown) => (v == null || v === '' ? '' : String(v).replace(/\s+/g, ' ').trim());

/**
 * What a narrative was written from, kept beside a hand edit: one short hash per entry (its id and the fields the
 * writer reads) and one for the case work. Hashes only, so the browser keeps no second copy of the record.
 */
export interface Basis { entries: Record<string, string>; casework: string | null }

type Row = Record<string, unknown> & { id?: unknown };

export function basisOf(entries: readonly Row[], casework?: CaseWork | null): Basis {
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (!e.id) continue;
    out[String(e.id)] = fnv(FIELDS.map((k) => norm(e[k])).join('\u0001'));
  }
  return { entries: out, casework: casework ? fnv(JSON.stringify([casework.researched, casework.verified, casework.resolved, casework.procedures])) : null };
}

/** What changed since a basis was taken: entries changed, added, or no longer in the period, and the case work. */
export interface Drift { changed: string[]; added: string[]; removed: number; casework: boolean; any: boolean }

export function driftOf(was: Basis, entries: readonly Row[], casework?: CaseWork | null): Drift {
  const now = basisOf(entries, casework);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [id, hash] of Object.entries(now.entries)) {
    if (!Object.hasOwn(was.entries, id)) added.push(id);
    else if (was.entries[id] !== hash) changed.push(id);
  }
  const removed = Object.keys(was.entries).filter((id) => !Object.hasOwn(now.entries, id)).length;
  const caseworkChanged = (was.casework ?? null) !== now.casework;
  return { changed, added, removed, casework: caseworkChanged, any: Boolean(changed.length || added.length || removed || caseworkChanged) };
}
