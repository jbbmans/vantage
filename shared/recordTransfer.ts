import { ACTIVITY_CSV_COLUMNS, applyMapping, activityToCsvRow, toISODate, toNumber, toTime, unprotectCell, STILL_GOING, YES } from './csv.ts';
import {
  ACTIVITY_STATUS, AWARD_STATUS, AWARD_TYPES, COUNSELING_TYPES, DEGREES, GOAL_METRICS, GOAL_STATUS, GOAL_TYPES, MCMAP_BELTS, PME_STATUS,
  PRIORITIES, RIFLE_QUALS, TRAINING_STATUS, TRAINING_TYPES, VISIBILITIES, WORK_STATUS,
} from './constants.ts';
import { CAREER_CATEGORIES, CAREER_STATUSES } from './record.ts';
import { isDrawnFromWork, trainingType } from './recordKinds.ts';
import { timeframeProblems, isTimeframed } from './timeframe.ts';
import { goalSchema } from './schemas.ts';

/**
 * What a person's records look like outside Vantage, and how they come back in (ADR-0019). One registry for the personal
 * export, the import that reads it back, a single record's download and the Your data page: every category the spec names,
 * the store it lives in, whether an import writes it (and why not when it does not), and the spreadsheet columns of each
 * record type. Export, import and the page all read this, so a column the export writes is one the import reads.
 *
 * An import never flattens: an award comes back an award, a course a course, a counseling a counseling, each in its own
 * store, and a row that only reads like one is suggested to its owner, never moved for them (ADR-0015).
 */

export const PERSONAL_FORMAT = 'vantage-personal/1';
/** One record downloaded from its page: the record, and the files on it. */
export const RECORD_FORMAT = 'vantage-record/1';

/** What an import writes, in the order it writes them: projects first, so work filed under one keeps its link. */
export const IMPORT_TABLES = ['projects', 'goals', 'tasks', 'activities', 'trainings', 'awards', 'counselings', 'career_steps'] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];
export const isImportTable = (t: unknown): t is ImportTable => (IMPORT_TABLES as readonly unknown[]).includes(t);

export const TABLE_LABELS: Record<ImportTable, { one: string; many: string }> = {
  projects: { one: 'project', many: 'Projects' },
  goals: { one: 'goal', many: 'Goals' },
  tasks: { one: 'task', many: 'Tasks' },
  activities: { one: 'activity', many: 'Activities' },
  trainings: { one: 'training', many: 'Training' },
  awards: { one: 'award', many: 'Awards' },
  counselings: { one: 'counseling', many: 'Counselings' },
  career_steps: { one: 'career step', many: 'Career plan' },
};

// ——— Categories ———

export type CategoryFilter = { column: 'type' | 'category'; value: string } | { column: 'from_work' };

export interface TransferCategory {
  key: string;
  label: string;
  /** What it holds, in a line. */
  hint: string;
  /** The table its rows are in, or null for one that is not a record type. */
  table: ImportTable | null;
  /** Which of the table's rows, for a category that is one kind among them. */
  filter?: CategoryFilter;
  /** The broader category this one is a part of: exporting both is exporting the broader one. */
  partOf?: string;
  /** True when an import writes it; otherwise why it does not. */
  imports: true | string;
}

export const DUTY_NOT_IMPORTED = 'Vantage does not keep duty records yet, so duty rows are listed and left out. They are never turned into Activities.';

export const TRANSFER_CATEGORIES: readonly TransferCategory[] = [
  { key: 'profile', label: 'Profile and readiness', hint: 'Name, rank, MOS, EAS, PFT and CFT, qualifications, education level, preferences.', table: null, imports: true },
  { key: 'activities', label: 'Activities', hint: 'Work you did, every category.', table: 'activities', imports: true },
  { key: 'volunteer', label: 'Volunteer service', hint: 'Activities in Volunteer Service.', table: 'activities', filter: { column: 'category', value: 'Volunteer Service' }, partOf: 'activities', imports: true },
  { key: 'fm_work', label: 'Financial management work', hint: 'Activities drawn from the financial cases you worked.', table: 'activities', filter: { column: 'from_work' }, partOf: 'activities', imports: true },
  { key: 'awards', label: 'Awards and recognition', hint: 'Personal and unit awards, masts, certificates, letters, coins; recommendations included.', table: 'awards', imports: true },
  { key: 'trainings', label: 'Training, every kind', hint: 'Courses, PME, education, certifications, qualifications, skills.', table: 'trainings', imports: true },
  { key: 'pme', label: 'PME', hint: 'Professional military education.', table: 'trainings', filter: { column: 'type', value: 'pme' }, partOf: 'trainings', imports: true },
  { key: 'education', label: 'Education', hint: 'Degrees, college courses and credits.', table: 'trainings', filter: { column: 'type', value: 'education' }, partOf: 'trainings', imports: true },
  { key: 'certification', label: 'Certifications', hint: 'Credentials from a certifying body.', table: 'trainings', filter: { column: 'type', value: 'certification' }, partOf: 'trainings', imports: true },
  { key: 'qualification', label: 'Qualifications', hint: 'Qualifications you hold.', table: 'trainings', filter: { column: 'type', value: 'qualification' }, partOf: 'trainings', imports: true },
  { key: 'counselings', label: 'Counselings', hint: 'Counselings you received, and your own notes.', table: 'counselings', imports: true },
  { key: 'goals', label: 'Goals', hint: 'Your goals and their progress.', table: 'goals', imports: true },
  { key: 'projects', label: 'Projects', hint: 'Projects you own.', table: 'projects', imports: true },
  { key: 'tasks', label: 'Tasks', hint: 'Tasks you own.', table: 'tasks', imports: true },
  { key: 'career', label: 'Career plan', hint: 'Your military goal, civilian interests and planned steps.', table: 'career_steps', imports: true },
  { key: 'duty', label: 'Duty', hint: 'Duty stood. Not recorded in Vantage yet.', table: null, imports: DUTY_NOT_IMPORTED },
  { key: 'personnel', label: 'Personnel history', hint: 'Units served in, billets, responsibilities and every change to them.', table: null, imports: 'Those who manage your membership in each Unit Instance keep it; an import cannot write it.' },
  { key: 'attachments', label: 'Attachments', hint: 'The files on the records exported (ZIP only).', table: null, imports: true },
  { key: 'account', label: 'Account history', hint: 'Memberships, roles, notifications, comments, your audit trail, AI use, email log, drafts, case contributions, moves, sign-in security.', table: null, imports: 'It is the record of what happened in Vantage: kept in the export, never written back.' },
];

export const CATEGORY_KEYS = TRANSFER_CATEGORIES.map((c) => c.key);
export const categoryOf = (key: string) => TRANSFER_CATEGORIES.find((c) => c.key === key) ?? null;

/** Whether a row of the category's table is in the category. */
export function inCategory(category: TransferCategory, row: Record<string, unknown>): boolean {
  const f = category.filter;
  if (!f) return true;
  if (f.column === 'from_work') return isDrawnFromWork(row.fingerprint) || row.from_work === true;
  return row[f.column] === f.value;
}

/**
 * What a choice of categories exports: each record table and which of its rows (all of them, or those of the categories
 * named), and the other datasets. No choice is everything.
 */
export interface SectionSelection {
  all: boolean;
  tables: Map<ImportTable, TransferCategory[] | 'all'>;
  profile: boolean; personnel: boolean; attachments: boolean; account: boolean; duty: boolean;
  keys: string[];
}

export function selectSections(keys: readonly string[] | null | undefined): SectionSelection {
  const chosen = keys?.length ? [...new Set(keys)].filter((k) => CATEGORY_KEYS.includes(k)) : [...CATEGORY_KEYS];
  const all = chosen.length === CATEGORY_KEYS.length;
  const tables = new Map<ImportTable, TransferCategory[] | 'all'>();
  for (const key of chosen) {
    const c = categoryOf(key)!;
    if (!c.table) continue;
    const whole = !c.filter || chosen.includes(c.partOf!);
    if (whole) { tables.set(c.table, 'all'); continue; }
    const have = tables.get(c.table);
    if (have === 'all') continue;
    tables.set(c.table, [...(have ?? []), c]);
  }
  // Career is a profile and its steps: the steps are the table, the profile goes with them.
  return {
    all, tables, keys: chosen,
    profile: chosen.includes('profile'), personnel: chosen.includes('personnel'), attachments: chosen.includes('attachments'),
    account: chosen.includes('account'), duty: chosen.includes('duty'),
  };
}

// ——— Spreadsheet columns ———

export type ColumnKind = 'text' | 'date' | 'time' | 'number' | 'flag' | 'enum' | 'links' | 'json';
export interface TransferColumn {
  key: string; header: string; aliases?: string[]; kind?: ColumnKind;
  /** The values an enum column takes, and what an unknown one becomes (none: it is a problem to correct). */
  values?: readonly string[]; fallback?: string;
  /** Other words for some of its values: "letter of appreciation" for loa. */
  synonyms?: Record<string, string>;
}

const ID: TransferColumn = { key: 'id', header: 'Vantage ID' };
const VISIBILITY: TransferColumn = { key: 'visibility', header: 'Visibility', kind: 'enum', values: VISIBILITIES, synonyms: { shared: 'unit', unitshared: 'unit', me: 'private', onlyme: 'private' } };
const UNIT: TransferColumn = { key: 'unit_id', header: 'Unit ID' };
const NOTES: TransferColumn = { key: 'notes', header: 'Notes', aliases: ['Comments', 'Remarks'] };
const STARTS: TransferColumn[] = [
  { key: 'date', header: 'Date', aliases: ['Start Date', 'Start', 'Date Completed', 'Completed', 'Completion Date'], kind: 'date' },
  { key: 'end_date', header: 'End Date', aliases: ['Through', 'Until', 'End'], kind: 'date' },
  { key: 'start_time', header: 'Start Time', kind: 'time' },
  { key: 'end_time', header: 'End Time', kind: 'time' },
  { key: 'ongoing', header: 'Ongoing', aliases: ['Present'], kind: 'flag' },
];

/** Activities keep the columns their CSV import and export have always had. */
const activityColumns: TransferColumn[] = ACTIVITY_CSV_COLUMNS.map((c) => ({
  ...c,
  kind: (['date', 'end_date'].includes(c.key) ? 'date' : ['start_time', 'end_time'].includes(c.key) ? 'time' : ['quantity', 'dollar_amount'].includes(c.key) ? 'number'
    : c.key === 'ongoing' ? 'flag' : c.key === 'evidence_links' ? 'links' : c.key === 'status' ? 'enum' : c.key === 'visibility' ? 'enum' : 'text') as ColumnKind,
  ...(c.key === 'status' ? { values: ACTIVITY_STATUS, fallback: 'completed' } : c.key === 'visibility' ? { values: VISIBILITIES, synonyms: VISIBILITY.synonyms } : {}),
}));

export const RECORD_COLUMNS: Record<ImportTable, TransferColumn[]> = {
  activities: [...activityColumns, UNIT],
  trainings: [
    ID, { key: 'type', header: 'Type', aliases: ['Training Type', 'Kind'], kind: 'enum', values: TRAINING_TYPES, synonyms: { professionalmilitaryeducation: 'pme', degree: 'education', college: 'education', cert: 'certification', qual: 'qualification' } },
    { key: 'title', header: 'Title', aliases: ['Course', 'Course Title', 'Name', 'Training'] }, ...STARTS,
    { key: 'hours', header: 'Hours', aliases: ['Credit Hours', 'Duration (hours)'], kind: 'number' },
    { key: 'provider', header: 'Provider', aliases: ['School', 'Institution', 'Issuer', 'Issued By', 'Organization'] },
    { key: 'status', header: 'Status', kind: 'enum', values: TRAINING_STATUS, synonyms: { done: 'completed', complete: 'completed', inprogress: 'in_progress', enrolled: 'in_progress', planned: 'scheduled' } },
    VISIBILITY, NOTES, UNIT,
  ],
  awards: [
    ID, { key: 'name', header: 'Name', aliases: ['Award', 'Award Name', 'Title'] },
    { key: 'type', header: 'Type', aliases: ['Award Type'], kind: 'enum', values: AWARD_TYPES, fallback: 'other', synonyms: { personal: 'personal_award', unit: 'unit_award', mast: 'meritorious_mast', letterofappreciation: 'loa', challengecoin: 'coin' } },
    { key: 'status', header: 'Status', kind: 'enum', values: AWARD_STATUS, synonyms: { awarded: 'presented', received: 'presented', pending: 'submitted' } },
    { key: 'period_start', header: 'Period Start', kind: 'date' },
    { key: 'date', header: 'Date', aliases: ['Award Date', 'Period End', 'Date Awarded'], kind: 'date' },
    { key: 'recommending_official', header: 'Recommending Official', aliases: ['Recommended By'] },
    { key: 'approving_authority', header: 'Approving Authority', aliases: ['Approved By'] },
    { key: 'citation', header: 'Citation' },
    { key: 'submitted_at', header: 'Submitted', aliases: ['Submitted On'], kind: 'date' },
    { key: 'approved_at', header: 'Approved', aliases: ['Approved On'], kind: 'date' },
    { key: 'presented_at', header: 'Presented', aliases: ['Presented On'], kind: 'date' },
    VISIBILITY, NOTES, UNIT,
  ],
  counselings: [
    ID, { key: 'date', header: 'Date', kind: 'date' },
    { key: 'type', header: 'Type', aliases: ['Counseling Type'], kind: 'enum', values: COUNSELING_TYPES, fallback: 'other', synonyms: { semiannual: 'semi_annual', initialcounseling: 'initial' } },
    { key: 'counselor_name', header: 'Counselor', aliases: ['Counselor Name', 'Counseled By'] },
    { key: 'summary', header: 'Summary', aliases: ['Discussion'] },
    { key: 'strengths', header: 'Strengths', aliases: ['Sustains'] },
    { key: 'improvements', header: 'Improvements', aliases: ['Improves', 'Areas to Improve'] },
    { key: 'goals_set', header: 'Goals Set', aliases: ['Goals'] },
    { key: 'follow_up_date', header: 'Follow-up Date', aliases: ['Follow Up', 'Next Counseling'], kind: 'date' },
    VISIBILITY, UNIT,
  ],
  goals: [
    ID, { key: 'title', header: 'Title', aliases: ['Goal'] }, { key: 'description', header: 'Description' },
    { key: 'type', header: 'Type', aliases: ['Goal Type'], kind: 'enum', values: GOAL_TYPES },
    { key: 'category', header: 'Category' },
    { key: 'metric', header: 'Metric', kind: 'enum', values: GOAL_METRICS, fallback: 'manual' },
    { key: 'current_value', header: 'Current Value', aliases: ['Current'], kind: 'number' },
    { key: 'target_value', header: 'Target Value', aliases: ['Target'], kind: 'number' },
    { key: 'unit_label', header: 'Measured In', aliases: ['Measure Unit'] },
    { key: 'status', header: 'Status', kind: 'enum', values: GOAL_STATUS, synonyms: { done: 'achieved', complete: 'achieved', completed: 'achieved' } },
    { key: 'period_start', header: 'Period Start', kind: 'date' },
    { key: 'period_end', header: 'Period End', aliases: ['Deadline', 'Due Date'], kind: 'date' },
    // How a typed goal measures its progress: without them it comes back a manual goal that counts up.
    { key: 'metric_id', header: 'Metric ID' },
    { key: 'direction', header: 'Direction', kind: 'enum', values: goalSchema.shape.direction.unwrap().options },
    { key: 'baseline_value', header: 'Baseline', aliases: ['Baseline Value'], kind: 'number' },
    { key: 'aggregation', header: 'Aggregation', kind: 'enum', values: goalSchema.shape.aggregation.unwrap().options },
    { key: 'filters', header: 'Filters', kind: 'json' },
    { key: 'measure_scope', header: 'Measured For', kind: 'enum', values: goalSchema.shape.measure_scope.unwrap().options },
    { key: 'completed_at', header: 'Completed On', kind: 'date' },
    VISIBILITY, UNIT,
  ],
  projects: [
    ID, { key: 'name', header: 'Name', aliases: ['Project', 'Title'] }, { key: 'description', header: 'Description' },
    { key: 'status', header: 'Status', kind: 'enum', values: WORK_STATUS, synonyms: { inprogress: 'active', done: 'completed', complete: 'completed' } },
    { key: 'priority', header: 'Priority', kind: 'enum', values: PRIORITIES },
    { key: 'progress', header: 'Progress', aliases: ['Percent Complete'], kind: 'number' },
    { key: 'start_date', header: 'Start Date', kind: 'date' },
    { key: 'target_date', header: 'Target Date', aliases: ['Due Date', 'Deadline'], kind: 'date' },
    { key: 'organization', header: 'Organization' },
    VISIBILITY, UNIT,
  ],
  tasks: [
    ID, { key: 'title', header: 'Title', aliases: ['Task'] }, NOTES,
    { key: 'status', header: 'Status', kind: 'enum', values: WORK_STATUS, synonyms: { inprogress: 'active', done: 'completed', complete: 'completed', open: 'planned' } },
    { key: 'priority', header: 'Priority', kind: 'enum', values: PRIORITIES },
    { key: 'due_date', header: 'Due Date', aliases: ['Due', 'Deadline'], kind: 'date' },
    VISIBILITY, UNIT,
  ],
  career_steps: [
    ID, { key: 'title', header: 'Title', aliases: ['Step', 'Milestone'] },
    { key: 'category', header: 'Category', kind: 'enum', values: CAREER_CATEGORIES, fallback: 'military' },
    { key: 'status', header: 'Status', kind: 'enum', values: CAREER_STATUSES, synonyms: { completed: 'done', complete: 'done', inprogress: 'in_progress' } },
    { key: 'due_date', header: 'Due Date', aliases: ['Target Date', 'By'], kind: 'date' },
    { key: 'notes', header: 'Notes' },
    { key: 'source_label', header: 'Source' },
    { key: 'source_url', header: 'Source Link', aliases: ['Link', 'URL'] },
    { key: 'source_checked_on', header: 'Source Checked On', kind: 'date' },
  ],
};

/** Columns an export writes after a record's own, which an import reads only to know a row was in the recycle bin. */
export const DELETED_AT_HEADER = 'Deleted at';
/** A column naming each row's record type, for one sheet that holds several. */
export const RECORD_TYPE_COLUMN: TransferColumn = { key: 'record_type', header: 'Record Type', aliases: ['Type of Record', 'Record Kind', 'Kind of Record'] };

/** The profile and readiness as one row of a spreadsheet. Email, username and sign-in never come in this way. */
export const PROFILE_COLUMNS: TransferColumn[] = [
  { key: 'first_name', header: 'First Name' }, { key: 'last_name', header: 'Last Name' }, { key: 'middle_initial', header: 'Middle Initial', aliases: ['MI'] },
  { key: 'rank_id', header: 'Rank' }, { key: 'mos', header: 'MOS', aliases: ['PMOS'] }, { key: 'eas', header: 'EAS', aliases: ['EAS Date'], kind: 'date' },
];
export const READINESS_COLUMNS: TransferColumn[] = [
  { key: 'pft_score', header: 'PFT Score', aliases: ['PFT'], kind: 'number' }, { key: 'cft_score', header: 'CFT Score', aliases: ['CFT'], kind: 'number' },
  { key: 'rifle_qual', header: 'Rifle Qualification', aliases: ['Rifle'], kind: 'enum', values: RIFLE_QUALS },
  { key: 'mcmap_belt', header: 'MCMAP Belt', aliases: ['MCMAP'], kind: 'enum', values: MCMAP_BELTS },
  { key: 'ceus', header: 'CEUs', kind: 'number' }, { key: 'college_credits', header: 'College Credits', kind: 'number' },
  { key: 'degree', header: 'Degree', kind: 'enum', values: DEGREES, synonyms: { associates: 'associate', bachelors: 'bachelor', masters: 'master', phd: 'doctorate' } },
  { key: 'pme_complete', header: 'PME Complete', kind: 'enum', values: PME_STATUS },
  { key: 'cmd_character', header: 'Command Input: Character', kind: 'number' }, { key: 'cmd_mos', header: 'Command Input: MOS', kind: 'number' },
  { key: 'cmd_leadership', header: 'Command Input: Leadership', kind: 'number' },
  { key: 'fitrep_period_end', header: 'FITREP Period End', kind: 'date' },
];

// ——— Routing a sheet or a row to its record type ———

export type RouteTarget = { table: ImportTable; preset?: Record<string, unknown>; label: string } | { table: 'duty' | 'profile'; label: string };

const ROUTES: Array<{ names: string[]; target: RouteTarget }> = [
  { names: ['activity', 'activities', 'work', 'accomplishment', 'accomplishments', 'entry', 'entries', 'log'], target: { table: 'activities', label: 'Activities' } },
  { names: ['volunteer', 'volunteering', 'volunteer service', 'community service'], target: { table: 'activities', preset: { category: 'Volunteer Service' }, label: 'Volunteer service' } },
  { names: ['fm work', 'financial work', 'financial management', 'financial management work', 'fm'], target: { table: 'activities', preset: { category: 'Fiscal & Financial' }, label: 'Financial management work' } },
  { names: ['award', 'awards', 'recognition', 'recognitions', 'decoration', 'decorations', 'awards and recognition'], target: { table: 'awards', label: 'Awards' } },
  { names: ['training', 'trainings', 'course', 'courses', 'class', 'classes'], target: { table: 'trainings', label: 'Training' } },
  { names: ['pme', 'professional military education'], target: { table: 'trainings', preset: { type: 'pme' }, label: 'PME' } },
  { names: ['education', 'degree', 'degrees', 'college', 'schooling'], target: { table: 'trainings', preset: { type: 'education' }, label: 'Education' } },
  { names: ['certification', 'certifications', 'cert', 'certs', 'credential', 'credentials', 'license', 'licenses'], target: { table: 'trainings', preset: { type: 'certification' }, label: 'Certifications' } },
  { names: ['qualification', 'qualifications', 'qual', 'quals'], target: { table: 'trainings', preset: { type: 'qualification' }, label: 'Qualifications' } },
  { names: ['skill', 'skills'], target: { table: 'trainings', preset: { type: 'skill' }, label: 'Skills' } },
  { names: ['counseling', 'counselings', 'counselling', 'counsellings'], target: { table: 'counselings', label: 'Counselings' } },
  { names: ['goal', 'goals'], target: { table: 'goals', label: 'Goals' } },
  { names: ['project', 'projects'], target: { table: 'projects', label: 'Projects' } },
  { names: ['task', 'tasks', 'to do', 'todo'], target: { table: 'tasks', label: 'Tasks' } },
  { names: ['career', 'career plan', 'career step', 'career steps', 'career-steps'], target: { table: 'career_steps', label: 'Career plan' } },
  { names: ['duty', 'duties', 'watch', 'watches', 'duty log', 'duty roster'], target: { table: 'duty', label: 'Duty' } },
  { names: ['profile', 'personal', 'personal data', 'readiness', 'about me'], target: { table: 'profile', label: 'Profile' } },
];

const squash = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The record type a sheet's name, a file's name or a Record Type cell names, if it names one. */
export function routeFor(name: string | null | undefined): RouteTarget | null {
  const key = squash(String(name ?? '').replace(/\.(csv|tsv|txt|xlsx)$/i, '').replace(/^vantage[-_ ]?/i, ''));
  if (!key) return null;
  for (const r of ROUTES) if (r.names.some((n) => squash(n) === key)) return r.target;
  return null;
}

// ——— Reading a row ———

const norm = squash;

/** Which column of the file holds each field, guessed from the headers: the header itself, then its other names, then a near match. */
export function guessColumns(columns: readonly TransferColumn[], headers: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  // Exact names first, for every field, so a near match never takes a column another field names exactly; and a field's
  // own header before its other names, so "Name" is an award's name even when the sheet also has a "Title".
  for (const field of columns) {
    for (const target of [field.header, ...(field.aliases || []), field.key].map(norm)) {
      const hit = headers.find((h) => !used.has(h) && norm(h) === target);
      if (hit) { map[field.key] = hit; used.add(hit); break; }
    }
  }
  for (const field of columns) {
    if (map[field.key]) continue;
    const targets = [field.header, ...(field.aliases || [])].map(norm);
    const hit = headers.find((h) => !used.has(h) && targets.some((t) => t.length > 3 && norm(h).length > 3 && (norm(h).includes(t) || t.includes(norm(h)))));
    if (hit) { map[field.key] = hit; used.add(hit); }
  }
  return map;
}

/** Headers every record type might have, which say nothing about which type a sheet holds. */
const GENERIC_HEADERS = new Set(['id', 'vantageid', 'title', 'name', 'date', 'type', 'kind', 'status', 'notes', 'description', 'category', 'visibility', 'unitid', 'unit', 'start', 'end', 'startdate', 'enddate', 'ongoing', 'starttime', 'endtime']);

/**
 * The record type a sheet's headers fit best, or null when none fits better than another. Only telling headers count:
 * "Award Type" or "Credit Hours" say what a sheet holds, "Title" and "Date" do not; a header named exactly counts twice
 * what a near match does.
 */
export function tableFromHeaders(headers: readonly string[]): ImportTable | null {
  let best: ImportTable | null = null;
  let bestScore = 0;
  let tie = false;
  for (const table of IMPORT_TABLES) {
    const columns = RECORD_COLUMNS[table];
    const map = guessColumns(columns, headers);
    let score = 0;
    for (const [key, header] of Object.entries(map)) {
      if (GENERIC_HEADERS.has(norm(header))) continue;
      const field = columns.find((c) => c.key === key)!;
      score += [field.header, ...(field.aliases || []), field.key].map(norm).includes(norm(header)) ? 2 : 1;
    }
    if (score > bestScore) { best = table; bestScore = score; tie = false; } else if (score && score === bestScore) tie = true;
  }
  return tie ? null : best;
}

/** Whether a header is the column naming each row's record type: by its name exactly, never a near match ("Type"). */
export const isRecordTypeHeader = (header: string) => [RECORD_TYPE_COLUMN.header, ...(RECORD_TYPE_COLUMN.aliases ?? [])].map(norm).includes(norm(header));

/** One value of an enum column: its stored value, or its label ("Personal award", "In progress"), or another word for it. */
export function enumValue(column: TransferColumn, raw: string): { value: string | null; unknown: boolean } {
  const s = norm(raw);
  if (!s) return { value: null, unknown: false };
  const hit = (column.values ?? []).find((v) => norm(v) === s) ?? (column.synonyms?.[s] ?? null);
  if (hit) return { value: hit, unknown: false };
  return column.fallback ? { value: column.fallback, unknown: false } : { value: null, unknown: true };
}

export interface ReadRow { record: Record<string, unknown>; problem: string | null; fieldErrors: Record<string, string> }

/**
 * One spreadsheet row as the fields of its record type, from the columns mapped to them. A field whose column the file does
 * not have is left out, so an update leaves what the record holds. Activities read exactly as their CSV import always has.
 */
export function readRow(table: ImportTable, row: Record<string, string>, mapping: Record<string, string>): ReadRow {
  if (table === 'activities') {
    const { records, problems } = applyMapping([row], mapping, { undated: true });
    const record = (records[0] ?? {}) as unknown as Record<string, unknown>;
    if (records.length && !record.date) record.date = null;
    if (!mapping.status) delete record.status;
    if (!mapping.visibility || !record.visibility) delete record.visibility;
    for (const key of ['category', 'eval_area', 'quantity', 'unit_label', 'dollar_amount', 'dollar_type', 'result', 'organization', 'system', 'notes', 'evidence_links']) if (!mapping[key]) delete record[key];
    if (mapping.unit_id) record.unit_id = cell(row, mapping.unit_id) || null;
    if (!records.length) {
      // applyMapping refuses the row; read what it could so the row can be corrected.
      const loose: Record<string, unknown> = {};
      for (const [field, column] of Object.entries(mapping)) if (column) loose[field] = cell(row, column);
      return { record: loose, problem: capitalize(problems[0]?.issue ?? 'unreadable row'), fieldErrors: problems[0]?.issue.includes('title') ? { title: 'Required.' } : { date: problems[0]?.issue ?? 'Unreadable.' } };
    }
    return { record, problem: null, fieldErrors: {} };
  }
  const columns = RECORD_COLUMNS[table];
  const record: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const column of columns) {
    const header = mapping[column.key];
    if (!header) continue;
    const raw = cell(row, header);
    const value = readCell(column, raw);
    if (value.error) fieldErrors[column.key] = value.error;
    record[column.key] = value.value;
  }
  // "Present" in the end date, or Yes in Ongoing, is still going (ADR-0018); an end date given is the day it ended.
  if (isTimeframed(table) && mapping.end_date) {
    const end = cell(row, mapping.end_date);
    if (STILL_GOING.test(end)) { record.end_date = null; record.ongoing = 1; delete fieldErrors.end_date; }
  }
  if (mapping.ongoing) record.ongoing = record.ongoing ? 1 : 0;
  else if (record.end_date && table === 'trainings') record.ongoing = 0;
  if (table === 'trainings' && !record.type && record.title) record.type = trainingType(String(record.title));
  if (table === 'trainings' && record.ongoing && record.status === 'completed') record.status = 'in_progress';
  const required = table === 'awards' || table === 'projects' ? 'name' : table === 'counselings' ? 'summary' : 'title';
  if (!String(record[required] ?? '').trim()) fieldErrors[required] = 'Required.';
  if (isTimeframed(table) && !Object.keys(fieldErrors).length) {
    const tf = timeframeProblems(table, record);
    if (tf) Object.assign(fieldErrors, tf.fieldErrors);
    if (tf) return { record, problem: tf.message, fieldErrors };
  }
  const first = Object.entries(fieldErrors)[0];
  return { record, problem: first ? `${columns.find((c) => c.key === first[0])?.header ?? first[0]}: ${first[1]}` : null, fieldErrors };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const cell = (row: Record<string, string>, header: string) => unprotectCell(String(row[header] ?? '').trim());

export function readCell(column: TransferColumn, raw: string): { value: unknown; error?: string } {
  // An empty set of pairs is none (a goal's filters are never null).
  if (!raw) return { value: column.kind === 'flag' ? 0 : column.kind === 'json' ? {} : null };
  switch (column.kind) {
    case 'date': { const d = toISODate(raw); return d ? { value: d } : { value: null, error: 'Not a date this reads (use YYYY-MM-DD or MM/DD/YYYY).' }; }
    case 'time': { const t = toTime(raw); return t ? { value: t } : { value: null, error: 'Not a time (use 0800 or 08:00).' }; }
    case 'number': { const n = toNumber(raw); return n == null ? { value: null, error: 'Not a number.' } : { value: n }; }
    case 'flag': return { value: YES.test(raw) ? 1 : 0 };
    case 'enum': {
      const e = enumValue(column, raw);
      return e.unknown ? { value: null, error: `“${raw.slice(0, 40)}” is not one of: ${(column.values ?? []).join(', ')}.` } : { value: e.value };
    }
    case 'json': {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed };
      } catch { /* below */ }
      return { value: null, error: 'Not what Vantage writes here (a set of {"name": "value"} pairs).' };
    }
    default: return { value: raw };
  }
}

// ——— Writing a row ———

const ongoingOf = (row: Record<string, unknown>) => row.ongoing === 1 || row.ongoing === true;

/** One record as a spreadsheet row, under its type's headers, the way the import reads it back. */
export function sheetRow(table: ImportTable, row: Record<string, unknown>): Record<string, unknown> {
  if (table === 'activities') return { ...activityToCsvRow(row), 'Unit ID': row.unit_id ?? '', [DELETED_AT_HEADER]: row.deleted_at ?? '' };
  const out: Record<string, unknown> = {};
  for (const column of RECORD_COLUMNS[table]) {
    const value = row[column.key];
    out[column.header] = column.kind === 'flag' ? (value ? 'Yes' : '') : column.kind === 'json' ? (value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value) : '') : value ?? '';
  }
  // Still going: "Present" in End Date and Yes in Ongoing, as an activity's (ADR-0018).
  if (table === 'trainings' && ongoingOf(row)) { out['End Date'] = 'Present'; out.Ongoing = 'Yes'; }
  out[DELETED_AT_HEADER] = row.deleted_at ?? '';
  return out;
}

export const sheetHeaders = (table: ImportTable) => [...RECORD_COLUMNS[table].map((c) => c.header), DELETED_AT_HEADER];

// ——— The import's review, as the page reads it ———

export type RowOutcome = 'new' | 'update' | 'unchanged' | 'present' | 'duplicate' | 'problem' | 'excluded' | 'not_imported';

export interface ImportReviewRow {
  ref: string;
  /** Where it is in the file: "Awards, row 4", or the record type in a Vantage export. */
  source: string;
  /** The record type it was read as, and the one it goes into. */
  from: ImportTable | 'duty';
  as: ImportTable | 'duty';
  title: string; date: string | null;
  outcome: RowOutcome;
  /** Why it has that outcome, in a sentence. */
  reason: string | null;
  fieldErrors?: Record<string, string>;
  /** Whether the person has it in or out; whether they may change that. */
  include: boolean; toggle: boolean;
  /** It reads like another record type: offered, never applied for them (ADR-0015). */
  suggestion: { to: ImportTable; why: string } | null;
  /** Where it goes: as the file placed it, or private because the person cannot place it there here. */
  placement: 'kept' | 'private' | null;
  duplicateOf?: { table: ImportTable; id: string; title: string } | null;
  /** Who the file says wrote it, when that is not the person. */
  author?: string | null;
  /** The record as read, for a correction. */
  fields: Record<string, unknown>;
}

export interface ImportReview {
  id: string; status: 'staged' | 'imported' | 'undone' | 'cancelled' | 'expired';
  filename: string | null; source: 'vantage_json' | 'vantage_zip' | 'csv' | 'xlsx'; size_bytes: number; created_at: string;
  committed_at: string | null; undone_at: string | null;
  /** For a Vantage file: whose it says it is, and when it was made. */
  exported: { username: string | null; exported_at: string | null; display_name: string | null } | null;
  notes: string[];
  sheets: Array<{ name: string; table: ImportTable | 'duty' | 'profile' | 'skip' | 'record_type'; routedBy: 'sheet' | 'file' | 'record_type' | 'headers' | 'chosen' | 'none'; headers: string[]; mapping: Record<string, string>; rows: number }>;
  rows: ImportReviewRow[];
  counts: Record<RowOutcome, number>;
  profile: { mode: 'skip' | 'fill' | 'replace'; changes: Array<{ field: string; label: string; current: string | null; incoming: string; action: 'fill' | 'replace' | 'same' | 'kept' | 'refused'; reason?: string }> } | null;
  attachments: { total: number; included: number; problems: Array<{ name: string; reason: string }>; enabled: boolean };
  notImported: Array<{ key: string; label: string; count: number; reason: string }>;
  placement: 'keep' | 'private';
  results: ImportResults | null;
}

export interface ImportResults {
  created: Record<string, number>; updated: Record<string, number>; attachments: number; profile: string[]; skipped: number;
  undone?: { removed: number; restored: number; kept: number } | null;
}

/** One of the person's recent imports, as the list shows it. */
export interface ImportSummary {
  id: string; status: ImportReview['status']; source: ImportReview['source']; filename: string | null; size_bytes: number;
  created_at: string; committed_at: string | null; undone_at: string | null; results: ImportResults | null;
}

/** What the person chose on the review, as the page sends it (the server's importPlanSchema checks it). */
export interface ImportPlanBody {
  sheets?: Record<string, { table?: ImportTable | 'skip' | 'duty' | 'profile'; mapping?: Record<string, string> }>;
  rows?: Record<string, { include?: boolean; as?: ImportTable; fix?: Record<string, unknown> }>;
  placement?: 'keep' | 'private';
  profile?: 'skip' | 'fill' | 'replace';
  attachments?: boolean;
}
