/**
 * What kind of thing a record is, and the questions that fit it.
 *
 * A record used to be shaped like financial work: an action count, a transaction value, a value
 * type, a system of record. That fits "reconciled 30 ULOs in DAI" and nothing else, so a degree, a
 * certification, a season as team captain or a Saturday at the food pantry had to be forced into
 * fields that did not mean anything for it. Each kind below asks its own questions and saves its
 * own answers. The kind is the record's category, so nothing new has to be chosen and every record
 * saved before this still reads the way it did.
 *
 * The shared columns (organization, quantity with its unit, result) carry most of it. The few facts
 * no column fits live in `details`, a small object with a fixed set of keys: nothing outside that
 * list is ever stored there.
 */

export const RECORD_DETAIL_KEYS = ['level', 'role', 'credential_id', 'expires_on'] as const;
export type RecordDetailKey = (typeof RECORD_DETAIL_KEYS)[number];

export type KindFieldName = 'organization' | 'quantity' | 'result' | RecordDetailKey;

export interface KindField {
  name: KindFieldName;
  label: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'number' | 'date';
}

export interface RecordKind {
  /** The category this kind is saved under. */
  category: string;
  /** What the kind picker calls it. */
  label: string;
  blurb: string;
  titleLabel: string;
  titlePlaceholder: string;
  dateLabel: string;
  /** Written as the quantity's unit when this kind has a count (credits, hours). */
  unit?: string;
  fields: KindField[];
  /**
   * Work: the original shape, with the action count and unit, the transaction value and its type,
   * the system of record and the project. Only work records carry money.
   */
  work: boolean;
}

export const WORK_KIND: RecordKind = {
  category: '',
  label: 'Work',
  blurb: 'Something you did on the job: a document, a reconciliation, a brief, a fix.',
  titleLabel: 'What you did',
  titlePlaceholder: 'Reconciled 30 ULOs in DAI',
  dateLabel: 'Date',
  fields: [],
  work: true,
};

export const RECORD_KINDS: RecordKind[] = [
  {
    category: 'Education', label: 'Education', work: false,
    blurb: 'College courses, degrees and off-duty education.',
    titleLabel: 'Course or degree', titlePlaceholder: 'ACCT 201: Principles of Accounting', dateLabel: 'Completed', unit: 'credits',
    fields: [
      { name: 'organization', label: 'School or institution', placeholder: 'University of Maryland Global Campus' },
      { name: 'level', label: 'Level', placeholder: 'Single course, Associate, Bachelor’s, Master’s' },
      { name: 'quantity', label: 'Credits', type: 'number', placeholder: '3' },
      { name: 'result', label: 'Grade or outcome', placeholder: 'A, or degree conferred' },
    ],
  },
  {
    category: 'Certifications & Licenses', label: 'Certification', work: false,
    blurb: 'Professional credentials and licenses you earned.',
    titleLabel: 'Credential', titlePlaceholder: 'CompTIA Security+', dateLabel: 'Earned',
    fields: [
      { name: 'organization', label: 'Issued by', placeholder: 'CompTIA' },
      { name: 'credential_id', label: 'Credential ID', placeholder: 'COMP001022334455' },
      { name: 'expires_on', label: 'Expires', type: 'date' },
      { name: 'result', label: 'Score or outcome', placeholder: 'Passed, 812' },
    ],
  },
  {
    category: 'Training & PME', label: 'Training or PME', work: false,
    blurb: 'Courses, schools and professional military education.',
    titleLabel: 'Course', titlePlaceholder: 'Corporals Course DEP', dateLabel: 'Completed', unit: 'hours',
    fields: [
      { name: 'organization', label: 'Provider', placeholder: 'MarineNet' },
      { name: 'quantity', label: 'Hours', type: 'number', placeholder: '40' },
      { name: 'result', label: 'Outcome', placeholder: 'Completed, 94%' },
    ],
  },
  {
    category: 'Volunteer Service', label: 'Volunteer', work: false,
    blurb: 'Time given to your community, a charity or a cause.',
    titleLabel: 'What you did', titlePlaceholder: 'Food pantry distribution', dateLabel: 'Date', unit: 'hours',
    fields: [
      { name: 'organization', label: 'Organization', placeholder: 'Onslow County food bank' },
      { name: 'role', label: 'Your role', placeholder: 'Shift lead' },
      { name: 'quantity', label: 'Hours', type: 'number', placeholder: '6' },
      { name: 'result', label: 'Impact', placeholder: 'Served 120 families' },
    ],
  },
  {
    category: 'Extracurricular', label: 'Extracurricular', work: false,
    blurb: 'Teams, clubs, groups and activities outside your job.',
    titleLabel: 'Activity', titlePlaceholder: 'Base intramural soccer', dateLabel: 'Date', unit: 'hours',
    fields: [
      { name: 'organization', label: 'Club, team or group', placeholder: 'MCB Camp Lejeune intramurals' },
      { name: 'role', label: 'Role or position', placeholder: 'Team captain' },
      { name: 'quantity', label: 'Hours', type: 'number', placeholder: '20' },
      { name: 'result', label: 'Achievement', placeholder: 'League champions' },
    ],
  },
  {
    category: 'Physical Fitness', label: 'Physical fitness', work: false,
    blurb: 'Tests, events and fitness milestones.',
    titleLabel: 'Event', titlePlaceholder: 'Physical Fitness Test', dateLabel: 'Date',
    fields: [
      { name: 'result', label: 'Score or time', placeholder: '285, first class' },
      { name: 'organization', label: 'Where', placeholder: 'MCB Camp Lejeune' },
    ],
  },
  {
    category: 'Recognition', label: 'Award or recognition', work: false,
    blurb: 'Awards, letters and recognition you received.',
    titleLabel: 'Award or recognition', titlePlaceholder: 'Navy and Marine Corps Achievement Medal', dateLabel: 'Received',
    fields: [
      { name: 'organization', label: 'Awarded by', placeholder: 'CO, 2d Marine Logistics Group' },
      { name: 'result', label: 'What it was for', placeholder: 'Led the section through the FY26 close-out' },
    ],
  },
];

/** The kind a category belongs to. Any category not listed above, including one an instance invents, is work. */
export function kindFor(category: string | null | undefined): RecordKind {
  return RECORD_KINDS.find((k) => k.category === category) ?? WORK_KIND;
}

/**
 * Keeps only the fields a record's kind asks for, so switching a draft from work to education does
 * not quietly save a transaction value on a college course.
 */
export function shapeForKind<T extends Record<string, unknown>>(category: string | null | undefined, data: T, { partial = false }: { partial?: boolean } = {}): T {
  const kind = kindFor(category);
  const out: Record<string, unknown> = { ...data };
  const asked = new Set(kind.fields.map((f) => f.name));
  if (!kind.work) {
    out.dollar_amount = null;
    out.dollar_type = null;
    out.system = null;
    if (!asked.has('quantity')) { out.quantity = null; out.unit_label = null; } else if (kind.unit && out.quantity != null) out.unit_label = kind.unit;
    if (!asked.has('organization')) out.organization = null;
    if (!asked.has('result')) out.result = null;
  }
  // A partial update that does not touch the details leaves the stored ones alone.
  if (partial && data.details === undefined) { delete out.details; return out as T; }
  const details = (out.details && typeof out.details === 'object' ? out.details : {}) as Record<string, unknown>;
  const kept: Record<string, string> = {};
  for (const key of RECORD_DETAIL_KEYS) {
    if (kind.work || !asked.has(key)) continue;
    const value = details[key];
    if (typeof value === 'string' && value.trim()) kept[key] = value.trim();
  }
  out.details = kept;
  return out as T;
}
