import { passwordProblem } from './passwordPolicy.js';

export const ENUMS = {
  categories: [
    'Fiscal & Financial', 'Leadership', 'Training & PME', 'Administration', 'Operations',
    'Project Work', 'Recognition', 'Volunteer Service', 'Communications', 'Other',
  ],
  jepesAreas: ['Individual Character', 'MOS / Mission Accomplishment', 'Leadership', 'Unassigned'],
  dollarTypes: ['reconciled', 'obligated', 'saved', 'reviewed', 'impact'],
  activityStatus: ['completed', 'planned'],
  workStatus: ['planned', 'active', 'waiting', 'completed'],
  priorities: ['low', 'medium', 'high', 'critical'],
  goalTypes: ['annual', 'quarterly', 'monthly', 'professional', 'developmental', 'performance'],
  goalStatus: ['active', 'achieved', 'paused', 'missed'],
  recognitionTypes: ['award', 'loa', 'certificate', 'commendation', 'feedback', 'email', 'other'],
  trainingTypes: ['pme', 'course', 'qualification', 'certification', 'education', 'skill', 'training'],
  trainingStatus: ['completed', 'in_progress', 'scheduled'],

  visibilities: ['personal', 'private', 'unit'],
  degrees: ['associate', 'bachelor'],
  pme: ['distance', 'resident'],
  mcmapBelts: ['Tan', 'Grey', 'Green', 'Brown', 'Black 1st', 'Black 2nd', 'Black 3rd'],
  rifleQuals: ['Unqualified', 'Marksman', 'Sharpshooter', 'Expert'],
};

const absent = (v) => v === undefined || v === null || v === '';

const str = (max, { required = false } = {}) => (v) => {
  if (v === undefined) return required ? 'Required.' : null;
  if (absent(v)) return required ? 'Required.' : null;
  if (typeof v !== 'string') return 'Must be text.';
  if (v.length > max) return `Too long (limit ${max} characters).`;
  if (v.includes('\u0000')) return 'Contains a null byte.';
  return null;
};

const num = (lo, hi, { integer = false, required = false } = {}) => (v) => {
  if (absent(v)) return required ? 'Required.' : null;
  const n = typeof v === 'number' ? v : Number(v);
  if (typeof v !== 'number' && typeof v !== 'string') return 'Must be a number.';
  if (!Number.isFinite(n)) return 'Must be a finite number.';
  if (integer && !Number.isInteger(n)) return 'Must be a whole number.';
  if (n < lo) return `Must be at least ${lo}.`;
  if (n > hi) return `Must be at most ${hi}.`;
  return null;
};

const oneOf = (list, { required = false } = {}) => (v) => {
  if (absent(v)) return required ? 'Required.' : null;
  return list.includes(v) ? null : `Must be one of: ${list.join(', ')}.`;
};

const isoDate = ({ required = false } = {}) => (v) => {
  if (absent(v)) return required ? 'Required.' : null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Must be a date (YYYY-MM-DD).';
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return 'Not a real calendar date.';

  const d = new Date(t);
  const [year, month, day] = v.split('-').map(Number);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) {
    return 'Not a real calendar date.';
  }
  if (year < 1940 || year > 2100) return 'Date is outside a plausible range.';
  return null;
};

const bool01 = () => (v) => {
  if (v === undefined) return null;
  return v === 0 || v === 1 || v === true || v === false ? null : 'Must be true or false.';
};

const MAX_EVIDENCE_LINKS = 20;
const badScheme = (s) => /^\s*(javascript|data|vbscript):/i.test(s);
const evidenceLinks = () => (v) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return 'Must be a list of links.';
  if (v.length > MAX_EVIDENCE_LINKS) return `At most ${MAX_EVIDENCE_LINKS} links.`;
  for (const link of v) {

    if (typeof link === 'string') {
      if (link.length > 500) return 'A link is longer than 500 characters.';
      if (badScheme(link)) return 'That link scheme is not allowed.';
      continue;
    }
    if (link && typeof link === 'object' && !Array.isArray(link)) {
      const { label, url } = link;
      if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 200)) {
        return 'A link label is not text or is longer than 200 characters.';
      }

      if (url !== undefined && url !== null && (typeof url !== 'string' || url.length > 500)) {
        return 'A link URL is not text or is longer than 500 characters.';
      }
      if (typeof url === 'string' && badScheme(url)) return 'That link scheme is not allowed.';
      continue;
    }
    return 'Each link must be text or a { label, url } object.';
  }
  return null;
};

export const RECORD_SCHEMAS = {
  activities: {
    title: str(300, { required: true }),
    date: isoDate(),
    category: oneOf(ENUMS.categories),
    jepes_area: oneOf(ENUMS.jepesAreas),
    quantity: num(0, 1_000_000_000),
    unit_label: str(60),
    dollar_amount: num(0, 1_000_000_000_000),
    dollar_type: oneOf(ENUMS.dollarTypes),
    result: str(2000),
    organization: str(200),
    system: str(120),
    project_id: str(64),
    status: oneOf(ENUMS.activityStatus),
    notes: str(8000),
    evidence_links: evidenceLinks(),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
  projects: {
    name: str(200, { required: true }),
    description: str(4000),
    status: oneOf(ENUMS.workStatus),
    priority: oneOf(ENUMS.priorities),
    progress: num(0, 100),
    start_date: isoDate(),
    target_date: isoDate(),
    organization: str(200),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
  tasks: {
    title: str(300, { required: true }),
    notes: str(4000),
    status: oneOf(ENUMS.workStatus),
    priority: oneOf(ENUMS.priorities),
    due_date: isoDate(),
    project_id: str(64),
    assignee_id: str(64),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
  goals: {
    title: str(300, { required: true }),
    description: str(4000),
    type: oneOf(ENUMS.goalTypes),
    category: oneOf(ENUMS.categories),
    current_value: num(-1_000_000_000, 1_000_000_000_000),
    target_value: num(-1_000_000_000, 1_000_000_000_000),
    unit_label: str(60),
    status: oneOf(ENUMS.goalStatus),
    period_start: isoDate(),
    period_end: isoDate(),
    assignee_id: str(64),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
  recognitions: {
    title: str(300, { required: true }),
    date: isoDate(),
    type: oneOf(ENUMS.recognitionTypes),
    from_whom: str(200),
    organization: str(200),
    notes: str(4000),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
  trainings: {
    title: str(300, { required: true }),
    date: isoDate(),
    type: oneOf(ENUMS.trainingTypes),
    hours: num(0, 10_000),
    provider: str(200),
    status: oneOf(ENUMS.trainingStatus),
    notes: str(4000),
    visibility: oneOf(ENUMS.visibilities),
    unit_id: str(64),
  },
};

export const READINESS_SCHEMA = {
  pft_score: num(0, 300, { integer: true }),
  cft_score: num(0, 300, { integer: true }),

  rifle_score: num(0, 350, { integer: true }),
  rifle_qual: oneOf(ENUMS.rifleQuals),
  mcmap_belt: oneOf(ENUMS.mcmapBelts),
  ceus: num(0, 10_000),
  college_credits: num(0, 1_000),
  degree: oneOf(ENUMS.degrees),
  pme_complete: oneOf(ENUMS.pme),
  cmd_character: num(0, 5),
  cmd_mos: num(0, 5),
  cmd_leadership: num(0, 5),
};

export const USER_SCHEMA = {
  username: (v) => {
    if (absent(v)) return 'Required.';
    if (typeof v !== 'string') return 'Must be text.';
    const t = v.trim();
    if (t.length < 3 || t.length > 40) return '3–40 characters.';
    if (!/^[a-zA-Z0-9._-]+$/.test(t)) return 'Letters, numbers, dot, dash and underscore only.';
    return null;
  },
  password: (v) => {
    return passwordProblem(v);
  },
  first_name: str(80, { required: true }),
  last_name: str(80, { required: true }),
  middle_initial: str(4),
  rank_id: str(12),
  mos: str(12),
  email: (v) => {
    if (absent(v)) return null;
    if (typeof v !== 'string' || v.length > 254) return 'Not a valid email.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Not a valid email.';
  },
  eas: isoDate(),
  unit_id: str(64),
  billet_id: str(120),
};

export function validate(schema, body = {}, { partial = false } = {}) {
  const fieldErrors = {};
  for (const [field, check] of Object.entries(schema)) {
    const sent = Object.prototype.hasOwnProperty.call(body, field);
    if (partial && !sent) continue;
    const err = check(sent ? body[field] : undefined);
    if (err) fieldErrors[field] = err;
  }
  return Object.keys(fieldErrors).length ? { fieldErrors } : null;
}

export function pick(schema, body = {}) {
  const out = {};
  for (const field of Object.keys(schema)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = body[field];
  }
  return out;
}

export function fieldErrorMessage(fieldErrors) {
  return Object.entries(fieldErrors)
    .map(([field, msg]) => `${field}: ${msg}`)
    .join(' ');
}

export const BULK_LIMITS = {

  maxRows: 500,
  maxBodyBytes: 2 * 1024 * 1024,
};
