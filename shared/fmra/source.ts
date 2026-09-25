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
  | 'editorial'
  /** The book conflicts with itself or is incomplete here. */
  | 'discrepancy';

export const STATEMENT_LABEL: Record<StatementKind, string> = {
  source: 'Source',
  editorial: 'Editorial guidance',
  discrepancy: 'Source discrepancy',
};

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
