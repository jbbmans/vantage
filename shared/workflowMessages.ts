import { z } from 'zod';
import { REQUEST_KINDS, type RequestKind } from './requestKinds.ts';

export { REQUEST_KINDS, REQUEST_KIND_LABELS, isRequestKind, type RequestKind } from './requestKinds.ts';

/**
 * What is said on a record or a work case (ADR-0031). Nothing here is a chat: every entry hangs on the record it
 * is about, is read by exactly those who read that record, and is one of these kinds.
 */
export const COMMENT_KINDS = ['comment', 'review_request', 'clarification_request', 'answer', 'assignment_note'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/**
 * Where a request stands. A question is answered; a review comes back "looks right" or "needs changes" (with what); its
 * author may withdraw either while it is open; and the workflow it belongs to closes it when it ends: a duty decided, a
 * case resolved, the record deleted.
 */
export const REQUEST_STATES = ['open', 'answered', 'looks_right', 'needs_changes', 'withdrawn', 'closed'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  open: 'Open',
  answered: 'Answered',
  looks_right: 'Looks right',
  needs_changes: 'Needs changes',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
};

export const COMMENT_MAX = 4000;
export const REQUEST_MAX = 2000;
export const ANSWER_MAX = 4000;
export const ASSIGNMENT_NOTE_MAX = 1000;
/** The most people one message may name. More is refused, never quietly cut. */
export const MENTION_MAX = 10;
/** The most people the picker offers at a time. */
export const PEOPLE_MAX = 10;

const text = (max: number, what: string) => z.string().trim().min(1, `Write the ${what} first.`).max(max, `Keep it under ${max} characters.`);

export const commentBodySchema = z.object({ body: text(COMMENT_MAX, 'comment') });

export const requestSchema = z.object({
  kind: z.enum(REQUEST_KINDS),
  addressee_id: z.string().min(1, 'Choose who to ask.').max(64),
  body: text(REQUEST_MAX, 'request'),
});

export const answerSchema = z.object({
  /** A review's outcome. A question is answered, and takes none. */
  outcome: z.enum(['looks_right', 'needs_changes']).optional(),
  body: z.string().trim().max(ANSWER_MAX, `Keep it under ${ANSWER_MAX} characters.`).optional(),
});

export const assignmentNoteSchema = z.string().trim().max(ASSIGNMENT_NOTE_MAX, `Keep the note under ${ASSIGNMENT_NOTE_MAX} characters.`);

/** One person who may be named or asked on a record. */
export interface Speaker { id: string; username: string; name: string; rank: string | null }
/** The picker's answer. `more`: it stopped at its limit before reading every match, so typing more of a name may find others. */
export interface SpeakersResponse { people: Speaker[]; more: boolean }

/** One entry of a record's discussion, as the server gives it. */
export interface DiscussionEntry {
  id: string;
  record_table: string;
  record_id: string;
  kind: CommentKind;
  author_id: string;
  author_username: string;
  author_first_name: string;
  author_last_name: string;
  author_rank: string | null;
  body: string;
  mentions: string[];
  addressee_id: string | null;
  addressee_name: string | null;
  state: RequestState | null;
  reply_to: string | null;
  closed_at: string | null;
  private: boolean;
  edited_at: string | null;
  created_at: string;
  /** On an open request: whether the person asked may still answer it. */
  can_answer?: boolean;
}

/** What a new comment or request did: who was told, and which names were not. */
export interface Told { told: Array<{ id: string; name: string }>; not_told: string[] }

/** A request in someone's lists (GET /api/me/requests). */
export interface RequestSummary {
  id: string;
  kind: RequestKind;
  state: RequestState;
  body: string;
  record_table: string;
  record_id: string;
  label: string;
  url: string;
  author_name: string;
  addressee_name: string;
  can_answer: boolean;
  created_at: string;
  closed_at: string | null;
}
