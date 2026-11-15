/**
 * What Vantage tells a person, and what they may turn off (Task 24, ADR-0031). Every notice has a kind, and every kind is
 * in one group here: the server refuses a kind this catalogue does not name, and the settings page lists the groups a
 * person may turn off from it. A notice never carries anybody's words: it names the event, who did it and the record,
 * and the record's own name is read when the notice is read, after checking that its reader may still open it.
 */

export const NOTICE_GROUPS = ['asked', 'decisions', 'mentions', 'discussion', 'work', 'unit', 'announcements', 'security', 'operations'] as const;
export type NoticeGroup = (typeof NOTICE_GROUPS)[number];

/** The groups a person may turn off. Everything else is something they are asked to do, or must know. */
export const MUTABLE_GROUPS = ['discussion', 'work', 'announcements'] as const satisfies readonly NoticeGroup[];
export type MutableGroup = (typeof MUTABLE_GROUPS)[number];
export const isMutableGroup = (group: string): group is MutableGroup => (MUTABLE_GROUPS as readonly string[]).includes(group);

export const GROUP_LABELS: Record<NoticeGroup, string> = {
  asked: 'Asked of you',
  decisions: 'Decisions on your records',
  mentions: 'Mentions',
  discussion: 'Discussion',
  work: 'Work updates',
  unit: 'Your unit',
  announcements: 'Announcements',
  security: 'Security',
  operations: 'Operations',
};

export const GROUP_HINTS: Record<NoticeGroup, string> = {
  asked: 'Questions and review requests for you, answers to yours, work and tasks handed to you or returned for correction, and support.',
  decisions: 'Duty, counseling and award decisions on your records, and what your counselor or Marine says on a counseling.',
  mentions: 'Somebody named you in a discussion.',
  discussion: 'New comments on records you are part of. One notice per record until you open it.',
  work: 'A claim you held lapsed or was released, work you held went to someone else or was closed, a task you set was done.',
  unit: 'Joining, leaving and moving units, your roles, and messages from your leaders.',
  announcements: 'New MARADMINs.',
  security: 'Your sign-in, second factor and CAC.',
  operations: 'Unit Instance and service operations, for those who run them.',
};

interface KindSpec {
  group: NoticeGroup;
  /**
   * One unread notice per person, kind and record: while it is unread the next one adds to it ("3 new comments")
   * instead of adding a row. A kind that coalesces is never deduplicated by a key, and a record is always named.
   */
  coalesce?: true;
  /** What a coalesced notice says when it stands for more than one event. */
  many?: string;
}

export const NOTICE_KINDS = {
  review_request: { group: 'asked' },
  clarification_request: { group: 'asked' },
  request_answered: { group: 'asked' },
  assignment: { group: 'asked' },
  work_assigned: { group: 'asked' },
  work_returned: { group: 'asked' },
  support_ticket: { group: 'asked' },
  support_reply: { group: 'asked' },
  support_assigned: { group: 'asked' },
  support_resolved: { group: 'asked' },
  duty: { group: 'decisions' },
  counseling: { group: 'decisions' },
  counseling_comment: { group: 'decisions', coalesce: true, many: 'new comments on a counseling' },
  award: { group: 'decisions' },
  comment_mention: { group: 'mentions' },
  comment_added: { group: 'discussion', coalesce: true, many: 'new comments' },
  work_released: { group: 'work' },
  work_moved: { group: 'work' },
  task_done: { group: 'work' },
  unit: { group: 'unit' },
  profile: { group: 'unit' },
  maradmin: { group: 'announcements' },
  security: { group: 'security' },
  system: { group: 'operations' },
} as const satisfies Record<string, KindSpec>;

export type NoticeKind = keyof typeof NOTICE_KINDS;
export const NOTICE_KIND_NAMES = Object.keys(NOTICE_KINDS) as NoticeKind[];
export const isNoticeKind = (kind: string): kind is NoticeKind => Object.hasOwn(NOTICE_KINDS, kind);
export const groupOf = (kind: string): NoticeGroup => (isNoticeKind(kind) ? NOTICE_KINDS[kind].group : 'operations');
export const kindsIn = (group: NoticeGroup): NoticeKind[] => NOTICE_KIND_NAMES.filter((k) => NOTICE_KINDS[k].group === group);
export const coalesces = (kind: NoticeKind): boolean => 'coalesce' in NOTICE_KINDS[kind];

/** How long a notice is kept, read or not, before the sweep removes it (unless a legal hold keeps it). */
export const NOTICE_RETENTION_DAYS = 180;

/** One notice as GET /api/me/notifications gives it. */
export interface NoticeRow {
  id: string;
  kind: string;
  group: NoticeGroup;
  title: string;
  /** Only on a notice about no record: a leader's message, a MARADMIN's title, an operations note. */
  message: string | null;
  /** What the record is called now, read after checking its reader may still open it. */
  label: string | null;
  action_url: string | null;
  /** How many events this unread notice stands for, when its kind coalesces. */
  count: number | null;
  /** The Unit Instance it is about, by name, when it is about one. */
  org_name: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NoticesResponse {
  rows: NoticeRow[];
  /** Unread notices this person may still open, counted as the list is filtered. */
  unread: number;
  next_cursor: string | null;
}
