import { titleFingerprint } from '../duplicates.ts';
import { clauseOf, unitIdentity, type Fact } from './facts.ts';
import { plain } from './realize.ts';

const DAY = 86_400_000;
const words = (text: string) => new Set(titleFingerprint(text).split(' ').filter(Boolean));
const within = (small: Set<string>, large: Set<string>) => [...small].every((w) => large.has(w));
/** One set of words holds every word of the other. */
const nested = (a: string, b: string) => {
  const x = words(a); const y = words(b);
  return x.size <= y.size ? within(x, y) : within(y, x);
};
/** Dollars to the cent, the one rule sameWork and its buckets both use. */
const cents = (amount: number) => Math.round(amount * 100);
const sameOrUnset = (a: string | null, b: string | null) => !a || !b || a.toLowerCase() === b.toLowerCase();
/** Days between two entries; with either undated, unknown (Infinity). */
const daysApart = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / DAY : Infinity);

/**
 * Whether two entries are the same work logged twice: the same verb and the same figures (count and unit, dollars and
 * kind), at most a day apart, with no system, organization or outcome that sets them apart, and every word of the
 * shorter title in the longer. "Processed 22 MIPRs for the G-8" and "Processed 22 MIPRs for G-8" the next day are one
 * piece of work; the same 22 MIPRs a week later, 14 ULOs against 9, or DAI against SABRS are two. With no figure at
 * all, or with no date on either, only the same words count (and, with no figure, on the same day), as they always have:
 * nothing says two undated entries were logged a day apart.
 */
export function sameWork(a: Fact, b: Fact): boolean {
  if ((a.verb?.lemma ?? null) !== (b.verb?.lemma ?? null)) return false;
  const qa = a.quantity; const qb = b.quantity;
  if (Boolean(qa) !== Boolean(qb) || (qa && qb && (qa.n !== qb.n || unitIdentity(qa.unit) !== unitIdentity(qb.unit)))) return false;
  const ma = a.money; const mb = b.money;
  if (Boolean(ma) !== Boolean(mb) || (ma && mb && (cents(ma.amount) !== cents(mb.amount) || (ma.type ?? '') !== (mb.type ?? '')))) return false;
  if (!sameOrUnset(a.system, b.system) || !sameOrUnset(a.organization, b.organization)) return false;
  if (a.result && b.result && !nested(a.result, b.result)) return false;
  const sameWords = () => titleFingerprint(clauseOf(a)) === titleFingerprint(clauseOf(b));
  if (!a.date && !b.date) return sameWords();
  const apart = daysApart(a.date, b.date);
  if (!qa && !ma) return apart === 0 && sameWords();
  return apart <= 1 && nested(clauseOf(a), clauseOf(b));
}

/** What sameWork compares before anything else: the verb, the count and its unit, the dollars and their kind. */
const figuresOf = (f: Fact) => [
  f.verb?.lemma ?? '', f.quantity ? `${f.quantity.n}:${unitIdentity(f.quantity.unit)}` : '', f.money ? `${cents(f.money.amount)}:${f.money.type ?? ''}` : '',
].join('|');

/** How much an entry says, to choose which of two copies leads: an outcome, a measured one, a system, a tag, an organization. */
const fullness = (f: Fact) => (f.result ? 4 : 0) + (f.strongResult ? 2 : 0) + (f.system ? 1 : 0) + (f.areaInferred ? 0 : 1) + (f.organization ? 0.5 : 0);

/**
 * Why a copy is held, in what is true of the two: the numbers only when there are some, the day only when both have one.
 * The entry it repeats is quoted in plain characters, as the held text is, so every PDF font prints it.
 */
function heldReason(lead: Fact, copy: Fact): string {
  const what = copy.quantity || copy.money ? (lead.date && copy.date ? 'the same work and numbers' : 'the same words and numbers') : 'the same words';
  const when = lead.date && copy.date ? (lead.date === copy.date ? ', the same day' : ', a day apart') : '';
  return `Looks logged twice: ${what} as “${plain(clauseOf(lead)).replace(/ {2,}/g, ' ').trim()}”${lead.date ? ` (${lead.date})` : ''}${when}. Keep it if it was separate work.`;
}

/**
 * Holds back the second copy of work logged twice (sameWork), so a total counts it once instead of adding it again.
 * The fullest copy leads, and a copy joins only when it is the same work as every entry already there, so a bare
 * "Processed 22 MIPRs" never ties "for the G-8" to "for the G-4". Entries are read fullest first (then by date and
 * key), so the same record holds the same copies whatever order it comes in. Nothing moves from one copy to the other:
 * the lead's sentence says only what the lead says. Keeping (pinning) a held copy is the Marine's word that it was
 * separate work: it is not held, and it adds up again.
 */
export function markRepeats(read: Fact[], pins: ReadonlySet<string>): void {
  const order = read.map((f, i) => ({ f, i })).filter(({ f }) => !f.held)
    .sort((a, b) => fullness(b.f) - fullness(a.f) || String(a.f.date ?? '').localeCompare(String(b.f.date ?? '')) || (a.f.key < b.f.key ? -1 : a.f.key > b.f.key ? 1 : 0) || a.i - b.i);
  // sameWork needs the same verb and the same figures, so only entries that share them are compared: one pass, not
  // every entry against every other.
  const buckets = new Map<string, Fact[][]>();
  for (const { f } of order) {
    const key = figuresOf(f);
    const near = buckets.get(key) ?? [];
    const cluster = near.find((c) => c.every((m) => sameWork(m, f)));
    if (cluster) cluster.push(f);
    else { near.push([f]); buckets.set(key, near); }
  }
  for (const near of buckets.values()) {
    for (const [lead, ...copies] of near) {
      for (const f of copies) if (!pins.has(f.key)) f.held = { reason: heldReason(lead, f), basis: 'data' };
    }
  }
}
