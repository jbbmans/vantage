/**
 * Where the financial-management knowledge in Vantage comes from, and how sure it is.
 *
 * Everything under shared/fmra/ is drawn from one training reference: the rewritten FMRAC
 * (Financial Management Resource Analyst Course) study guide for the 3451 FMRA. That book says
 * plainly what kind of source it is, and Vantage repeats it wherever the knowledge appears:
 *
 *   - It is a conceptual and workflow reference, not a screen-by-screen DAI manual.
 *   - Thresholds, permissions, routing and timing examples are what the book printed, not
 *     independently verified current requirements.
 *   - Where the book disagrees with itself, the disagreement is recorded (see discrepancies.ts)
 *     instead of quietly picking an answer.
 *
 * Each fact carries a citation to the original 118-page guide's page numbers and to the chapter of
 * the rewritten edition, and says whether it restates the source or is editorial guidance the
 * rewrite added to make a verification step explicit. A reader can always tell which is which.
 */

export const FMRAC_SOURCE = {
  key: 'fmrac',
  title: 'FMRAC Financial Management Reference',
  subtitle: 'Rewritten study guide for the 3451 Financial Management Resource Analyst',
  basis: 'Based on the 118-page FMRAC Combined Study Guide.',
  edition: 'Rewritten edition, 24 September 2026',
  marking: 'DoD community only (source marking retained)',
  scope: 'Conceptual and workflow training reference. Not a DAI operating manual, not current policy, and not a delegation of authority.',
  limits: [
    'Thresholds, permissions, local routing and timing examples are the book’s printed values, not verified current requirements.',
    'Classroom numerical examples are illustrations, never live balances.',
    'Where the book conflicts with itself, both readings are kept and the conflict is recorded.',
    'Operational authority remains with applicable policy, approved procedures, appointments and system controls.',
  ],
} as const;

/** What kind of statement a piece of knowledge is. */
export type StatementKind =
  /** Restates the supplied book. */
  | 'source'
  /** Added by the rewrite to make a relationship or verification step explicit. */
  | 'editorial'
  /** The book conflicts with itself or is incomplete here. */
  | 'discrepancy';

export const STATEMENT_LABEL: Record<StatementKind, string> = {
  source: 'Source',
  editorial: 'Editorial guidance',
  discrepancy: 'Source discrepancy',
};

/** A citation: original-guide pages, and the chapter of the rewritten reference. */
export interface Cite {
  /** Pages of the original 118-page guide, e.g. "99-102". */
  pages?: string;
  /** Chapter or section of the rewritten reference, e.g. "8.3". */
  chapter: string;
  kind?: StatementKind;
}

export const cite = (chapter: string, pages?: string, kind: StatementKind = 'source'): Cite => ({ chapter, pages, kind });

/** "FMRAC 8.3 · orig. pp. 99-102". */
export function citeText(c: Cite): string {
  const pages = c.pages ? ` · orig. ${c.pages.includes('-') || c.pages.includes(',') ? 'pp.' : 'p.'} ${c.pages}` : '';
  return `FMRAC ${c.chapter}${pages}`;
}
