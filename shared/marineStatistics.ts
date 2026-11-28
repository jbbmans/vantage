import type { Visual } from './unitAnalytics.ts';
import type { ReportFileFormat } from './reportCatalog.ts';
import type { Track } from './evaluation.ts';

/**
 * A Marine's statistics (ADR-0051): one read of their record over a range, in the sections the Statistics tab shows and
 * the Statistics report prints. About oneself it reads every record one keeps, private ones included; about another
 * Marine, what they shared with the units of one Unit Instance where the reader opens their record. Their own history
 * only: no ranking, no comparison with anyone, no composite score.
 */

export const STATISTICS_SECTIONS = ['entries', 'duty', 'training', 'counseling', 'activity'] as const;
export type StatisticsSectionId = (typeof STATISTICS_SECTIONS)[number];

/**
 * When something last happened, named beside a section's figures: the last counseling in the range (a day), the last
 * entry added or the last sign-in (an instant). Null when none was found in what was read; `empty` then says so for what
 * was read, such as the range or the units shared with.
 */
export interface StatisticsFact { key: string; label: string; kind: 'day' | 'instant'; value: string | null; empty: string }

export interface StatisticsSection {
  id: StatisticsSectionId;
  title: string;
  /** What the section counts, in a line. */
  lede: string;
  visuals: Visual[];
  facts: StatisticsFact[];
  notes: string[];
}

export interface StatisticsUnit { id: string; name: string; short_name: string | null }

export interface MarineStatistics {
  user_id: string;
  /** Rank and name, as their record shows them. */
  subject: string;
  /** The reader is the Marine. */
  self: boolean;
  track: Track;
  period: { from: string; to: string; label: string };
  /** The day the figures that stand on a day (awaiting review now) are as of. */
  as_of: string;
  /** About another Marine, the unit asked for or chosen, and every unit read, that one first. None about oneself. */
  unit_id: string | null;
  units: StatisticsUnit[];
  sections: StatisticsSection[];
  notes: string[];
  /** The deployment's Privacy Act statement, shown with the figures; null when the deployment sets none. */
  privacy_act: string | null;
  /** The files the reader may take the Statistics report away as. */
  files: ReportFileFormat[];
}
