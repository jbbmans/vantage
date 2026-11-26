/**
 * A leader's message to a unit, kept in Vantage, and the files it carries as email attachments (ADR-0049). What the
 * server checks and the dialog and the page show, in one place. Pure: nothing here reads the database.
 */

/** A message carries at most this many files; together they fit the deployment's attachment limit. */
export const TEAM_MESSAGE_MAX_FILES = 5;
/** A message and its files are kept this many days from the send, unless a legal hold keeps them longer. */
export const TEAM_MESSAGE_RETENTION_DAYS = 180;

/** How a Marine was reached: by email (sent, waiting on their mail server, or not delivered), or in Vantage only. */
export type TeamMessageDelivery = 'pending' | 'emailed' | 'queued' | 'failed' | 'refused' | 'app_only';
export const TEAM_MESSAGE_DELIVERIES: readonly TeamMessageDelivery[] = ['pending', 'emailed', 'queued', 'failed', 'refused', 'app_only'];

/** Who a message to a unit would reach, and whether files can go with it now. */
export interface TeamAudience {
  members: number;
  withEmail: number;
  refused: number;
  appOnly: number;
  emailEnabled: boolean;
  limit: number;
  files: {
    /** Why files cannot go with a message to this unit now, or null when they can. */
    refusal: string | null;
    /** Files go to each Marine as attachments to the email; with email off they stay in Vantage. */
    byEmail: boolean;
    maxFiles: number;
    maxBytes: number;
    allowedTypes: string[];
  };
}

/** A file as the dialog sends it: its name and type as the browser gives them, and its bytes in base64. */
export interface TeamMessageFileUpload { name: string; type: string; content: string }

export interface TeamMessageResult {
  id: string;
  recipients: number;
  emailed: number;
  queued: number;
  failed: number;
  refused: number;
  appOnly: number;
  files: number;
}

export interface TeamMessageFileView { id: string; name: string; mime: string; size: number; sha256: string; scanStatus: 'clean'; position: number }

/** A kept message as its page shows it. */
export interface TeamMessageView {
  id: string;
  subject: string;
  body: string;
  senderName: string;
  unitLabel: string;
  unitName: string;
  marking: string;
  sentAt: string;
  /** The day it is removed, unless a legal hold keeps it. */
  keptUntil: string;
  files: TeamMessageFileView[];
  /** Set for the sender only: how the Marines it went to were reached. */
  delivery: Record<TeamMessageDelivery, number> | null;
}
