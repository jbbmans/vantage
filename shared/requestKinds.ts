/**
 * The kinds of request one person makes of another on a record, and what each is called (ADR-0031). They are apart from
 * shared/workflowMessages.ts, which holds the message schemas, so a page that only names a kind, as Today does, does not
 * load the schema library.
 */
export const REQUEST_KINDS = ['review_request', 'clarification_request'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const isRequestKind = (kind: string): kind is RequestKind => (REQUEST_KINDS as readonly string[]).includes(kind);

export const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  review_request: 'Review request',
  clarification_request: 'Question',
};
