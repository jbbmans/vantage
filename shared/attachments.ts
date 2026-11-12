/**
 * Files on records, and what a file on a training is evidence of (VANTAGE_CLAUDE_MASTER Task 19, ADR-0025). A training
 * holds its evidence as files: the certificate, the transcript, the completion or qualification document, the roster.
 * Each file says what it is and, in a line, what it shows, beside its name, its type, who added it and when.
 *
 * One place for what the server checks and a page offers: the record types that take files, the ones whose files carry
 * an evidence type, the types themselves, and the shape of a file as the API returns it. Pure: nothing here reads the
 * database. Who may open, add, correct or remove a file is decided by the record it hangs on (server/authz/records.ts).
 */

/** The record types that take files. The routes and the record import both read this list. */
export const ATTACHABLE_TABLES = ['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals', 'duties'] as const;
export type AttachableTable = (typeof ATTACHABLE_TABLES)[number];
export const isAttachable = (table: string): table is AttachableTable => (ATTACHABLE_TABLES as readonly string[]).includes(table);

/**
 * What a file on a training is evidence of. The database holds the same list as a check on `attachments.kind`
 * (server/db/schema.sql, migration 033); tests/server/trainingEvidence.test.ts keeps the two from drifting.
 */
export const EVIDENCE_KINDS = ['certificate', 'transcript', 'completion', 'qualification', 'roster', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  certificate: 'Certificate', transcript: 'Transcript', completion: 'Completion document', qualification: 'Qualification document', roster: 'Roster', other: 'Other evidence',
};
export const isEvidenceKind = (value: unknown): value is EvidenceKind => typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value);

/**
 * The record types whose files say what they are evidence of. A file on any other record type has no evidence type; one
 * that arrived on a training by a move or an import may have none yet, and whoever may edit the training sets it.
 */
export const EVIDENCE_TABLES = ['trainings'] as const;
export const takesEvidenceKind = (table: string): boolean => (EVIDENCE_TABLES as readonly string[]).includes(table);

/** The bounds on what is written about a file: its description's length, and its name's. */
export const ATTACHMENT_LIMITS = { description: 500, filename: 120 } as const;

/**
 * Characters that hide in a line of text or reorder it on screen: zero-width marks, the soft hyphen, and the
 * direction overrides and isolates. Stripped from a file's name and its description, so neither reads as something it
 * is not.
 */
const HIDDEN = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export const stripHidden = (value: string): string => value.replace(HIDDEN, '');

/**
 * A file's description as it is kept: one line of plain text, or nothing. Control characters are refused rather than
 * dropped, so what was typed is what is kept or the person is told; line breaks and runs of space become one space.
 */
export function cleanDescription(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'The description must be text.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value) || /\p{Cs}/u.test(value)) return { ok: false, error: 'The description holds characters that cannot be kept. Type it as plain text.' };
  const line = stripHidden(value).replace(/\s+/g, ' ').trim();
  if (line.length > ATTACHMENT_LIMITS.description) return { ok: false, error: `Too long (limit ${ATTACHMENT_LIMITS.description} characters).` };
  return { ok: true, value: line || null };
}

/**
 * The file types Vantage knows how to prove, with the filename extensions of each and the name a page gives it. Which of
 * them a service allows is its configuration (VANTAGE_ATTACHMENT_TYPES); the server checks a file's name and content
 * against this list, and a page builds its file chooser and its hint from it.
 */
export const ATTACHMENT_EXTENSIONS: Record<string, string[]> = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'text/plain': ['txt'], 'text/csv': ['csv'] };
export const ATTACHMENT_TYPE_NAMES: Record<string, string> = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'text/plain': 'TXT', 'text/csv': 'CSV' };

/** A file on a record, as the API lists it. Never its content: that is the download. */
export interface AttachmentRow {
  id: string;
  record_table: string;
  record_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  /** What it is evidence of; null on a record type that takes no evidence type, and on a training's file not yet typed. */
  kind: EvidenceKind | null;
  description: string | null;
  uploaded_by: string;
  /** Who added it, by rank and name, for anyone who may read the record. */
  uploader_name: string | null;
}

export interface AttachmentsResponse {
  attachments: AttachmentRow[];
  /** Whether a file can be added to this record now: attachments on for the service and not withheld from its Unit Instance. */
  enabled: boolean;
  maxBytes: number;
  maxPerRecord: number;
  allowedTypes: string[];
}

/** What a file's details may be changed to: its evidence type and its description. The file itself never changes. */
export interface AttachmentDetails { kind?: EvidenceKind | null; description?: string | null }

/** The file's size as a page shows it. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
