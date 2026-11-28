import { clearDrafts } from './drafts.ts';
import { clearRecentVisits } from './recent.ts';
import { withSudo } from './sudo.ts';
import type { AssignedItem, WorkItemDetail, WorkloadResponse } from '../../shared/caseView';
import type { DirectoryResponse, MemberDetailResponse, OrgResponse, PersonnelBulkResponse, PersonnelPersonRef, PersonnelRecordResponse, PersonnelRosterResponse, RecordRows, RolesResponse, TeamResponse } from '../../shared/types';
import type { OrgMembersPage } from './tenancy';
import type { UnitManagerRole } from '../../shared/permissions';
import type { LineageResponse, LineageTable, MovableTable, MoveCandidatesResponse, TimelineResponse } from '../../shared/recordKinds';
import type { DutyCandidatesResponse, DutyOptionsResponse, DutyStatus } from '../../shared/duty';
import type { AttachmentDetails, AttachmentRow, AttachmentsResponse } from '../../shared/attachments';
import type { TeamAudience, TeamMessageFileUpload, TeamMessageResult, TeamMessageView } from '../../shared/teamMessages';
import type { DutyReviewAction, DutyReviewEntry, DutyReviewQueueResponse } from '../../shared/dutyReview';
import type { CounselingDocument, CounselingField, CounselingRevision } from '../../shared/counseling';
import type { MarineStatistics } from '../../shared/marineStatistics';
import type { ImportPlanBody, ImportReview, ImportSummary } from '../../shared/recordTransfer';
import type { ReportDocument, ReportFileFormat } from '../../shared/reportCatalog';
import type { AnalyticsResponse, AnalyticsSection, DrillResponse } from '../../shared/unitAnalytics';
import type { BulkWorkInput, BulkWorkResponse, HandoffCandidate } from '../../shared/bulkWork';
import type { CourseEntry, CourseLookup, CourseSourceRecord } from '../../shared/courses';
import type { DraftsResponse, FormDraft, FormDraftKind } from '../../shared/drafts';
import type { NoticeGroup, NoticesResponse } from '../../shared/notifications';
import type { DiscussionEntry, RequestKind, RequestSummary, SpeakersResponse, Told } from '../../shared/workflowMessages';
import type {
  ColumnRole, ComparisonResult, Drill, DrillGroup, DrillResult, ErrorReportChoices, ErrorReportLayout, ErrorReportPreview, ErrorReportsOverview, SeriesHistory, SnapshotSummary,
} from '../../shared/errorReports';

/** A saved report as the library lists it: its name and choices, whose it is, and where it is shared. */
export interface ReportDefinitionRow { id: string; user_id: string; name: string; type: string; params: Record<string, string>; visibility: 'private' | 'unit'; unit_id: string | null; owner_name: string | null; mine: boolean; created_at: string; updated_at: string }

/**
 * The signed-in marker: the cookie the page can read (the session's own is httpOnly). Each sign-in sets a value of its
 * own, so the value a request left with says which sign-in it was sent under. `undefined` when the cookie cannot be read.
 */
const signedInMarker = (): string | null | undefined => {
  try { return /(?:^|;\s*)vantage_signed_in=([^;]*)/.exec(document.cookie)?.[1] ?? null; } catch { return undefined; }
};

let sessionState: 'none' | 'unknown' | 'active' = signedInMarker() === null ? 'none' : 'unknown';

export class ApiError extends Error {
  status: number; code: string | null; fieldErrors: Record<string, string> | null; extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = (extra.code as string) || null;
    this.fieldErrors = (extra.fieldErrors as Record<string, string>) || null;
    this.extra = extra;
  }
}

export const errorText = (err: unknown): string => {
  if (err instanceof ApiError) {
    const fields = err.fieldErrors ? Object.values(err.fieldErrors).join(' ') : '';
    return err.fieldErrors && Object.keys(err.fieldErrors).length ? fields : err.message;
  }
  return err instanceof Error ? err.message : 'Request failed.';
};

export const isOffline = (err: unknown) => err instanceof ApiError && err.status === 0;

/** Set when the person accepts the sign-in notice; sent with each sign-in, and forgotten at sign-out so it is shown again. */
let consentAccepted = false;
let sessionExpiry: number | null = null;
/** The latest server deadline, including a response received before IdleGuard mounted. */
export const sessionExpiresAt = () => sessionExpiry;
export const acceptConsent = () => { consentAccepted = true; };
export const consentWasAccepted = () => consentAccepted;

function markSignedOut() {
  sessionExpiry = null;
  sessionState = 'none';
  consentAccepted = false;
  clearDrafts();
  clearRecentVisits();
  try { document.cookie = 'vantage_signed_in=; Max-Age=0; path=/'; } catch {}
}

export const hasSession = () => sessionState !== 'none';
export const markSignedIn = () => { sessionState = 'active'; window.dispatchEvent(new CustomEvent('vantage:signed-in')); };

/**
 * A request was answered 401. If someone signed in again after it left (in this tab or another: a role grant ends a
 * person's sessions, and they sign in anew), the 401 is about the session that sign-in replaced, and the browser is
 * signed in: the page picks up the new session rather than clear the marker that sign-in set. Otherwise the session it
 * was sent with has ended, and the page signs out. A clearing can still land after a sign-in this page could not see
 * yet; the next document served to the live session puts the marker back (restoreSignedInMarker, server/routes/auth.ts).
 */
function sessionEnded(sentWith: string | null | undefined) {
  if (sessionState === 'none') return;
  const current = signedInMarker();
  if (current && sentWith !== undefined && current !== sentWith) { markSignedIn(); return; }
  markSignedOut();
  window.dispatchEvent(new CustomEvent('vantage:signed-out'));
}

async function request<T = any>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  const sentWith = signedInMarker();
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      method,
      credentials: 'same-origin',
      headers: { ...(body instanceof Blob || body instanceof ArrayBuffer ? {} : { 'content-type': 'application/json' }), ...(init.headers as Record<string, string> | undefined), 'x-vantage-client': '1', ...(consentAccepted ? { 'x-vantage-consent': '1' } : {}) },
      body: body === undefined ? undefined : body instanceof Blob || body instanceof ArrayBuffer ? (body as BodyInit) : JSON.stringify(body),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('Cannot reach the Vantage server. Check your connection.', 0, { code: 'offline' });
  }
  if (res.status === 401) {
    sessionEnded(sentWith);
    const text = await res.text().catch(() => '');
    let payload: any = null; try { payload = JSON.parse(text); } catch {}
    throw new ApiError(payload?.error || 'Your session has expired. Sign in again.', 401, payload || {});
  }
  const expires = res.headers.get('x-session-expires');
  if (expires && Number.isFinite(Date.parse(expires))) {
    sessionExpiry = Date.parse(expires);
    window.dispatchEvent(new CustomEvent('vantage:session-expires', { detail: sessionExpiry }));
  }
  const text = await res.text();
  let payload: any = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch {
      if (res.ok) throw new ApiError('The server returned an unreadable response. Refresh to check whether your change was applied before submitting it again.', 502, { code: 'invalid_response' });
    }
  }
  if (!res.ok) throw new ApiError(payload?.error || `Request failed (${res.status}).`, res.status, payload || {});
  if (!/^\/auth\/(setup|forgot|reset|invite|passkey)/.test(path) && path !== '/health') sessionState = 'active';
  return payload as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
};

export const setupStatus = () => api.get('/auth/setup');
export const runSetup = (payload: unknown) => api.post('/auth/setup', payload).then((r) => { markSignedIn(); return r; });
export const register = (payload: unknown) => api.post('/auth/register', payload).then((r) => { markSignedIn(); return r; });
export const login = (username: string, password: string) => api.post('/auth/login', { username, password }).then((r) => { if (r.ok) markSignedIn(); return r; });
/** The browser presents the card's certificate during the TLS handshake; there is nothing to send but the request. */
export const cacLogin = () => api.post('/auth/cac').then((r) => { markSignedIn(); return r; });
export const loginMfa = (challenge: string, code: string) => api.post('/auth/login/mfa', { challenge, code }).then((r) => { markSignedIn(); return r; });
export const passkeyOptions = (username?: string) => api.post('/auth/passkey/options', { username });
export const passkeyVerify = (key: string, response: unknown) => api.post('/auth/passkey/verify', { key, response }).then((r) => { markSignedIn(); return r; });
/** Signs out. Unsaved text in this browser goes whatever the server answers: the person asked to sign out. */
export const logout = async () => {
  try { await api.post('/auth/logout'); } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; } finally { clearDrafts(); }
  markSignedOut();
};
export const sudo = (password: string) => api.post('/auth/sudo', { password });
export const cacStepUp = () => api.post('/auth/cac/step-up');
/** Accepts an invitation into the account already signed in: the same record, a new unit. */
export const claimInvite = (token: string): Promise<{ ok: true; unit_id: string; unit_name: string; primary: boolean }> => api.post('/auth/invite/claim', { token });
export const forgotPassword = (identifier: string) => api.post('/auth/forgot', { identifier });
export const resetStatus = (token: string) => api.get(`/auth/reset?token=${encodeURIComponent(token)}`);
export const resetPassword = (token: string, password: string) => api.post('/auth/reset', { token, password }).then((r) => { if (r.ok) markSignedIn(); return r; });
export const inviteStatus = (token: string) => api.get(`/auth/invite?token=${encodeURIComponent(token)}`);
export const acceptInvite = (payload: unknown) => api.post('/auth/invite/accept', payload).then((r) => { markSignedIn(); return r; });

export const me = () => api.get('/me');
export const org = () => api.get<OrgResponse>('/me/org');
export const updateProfile = (payload: unknown) => api.put('/me/profile', payload);
/** The EDIPI one's own counseling worksheets print, typed by oneself; null removes it (ADR-0033). */
export const saveFormEdipi = (edipi: string | null) => api.put('/me/edipi', { edipi }) as Promise<{ ok: true; changed: boolean; on_file: boolean }>;
export const savePrefs = (patch: unknown) => api.put('/me/prefs', patch);
export const changePassword = (current_password: string, new_password: string) => api.post('/me/password', { current_password, new_password });
export const mySessions = () => api.get('/me/sessions');
export const revokeOtherSessions = () => api.post('/me/sessions/revoke-others');
export const revokeSession = (id: string) => api.del(`/me/sessions/${encodeURIComponent(id)}`);
export const totpStart = () => api.post('/me/mfa/totp/start');
export const totpConfirm = (code: string) => api.post('/me/mfa/totp/confirm', { code });
export const totpDisable = () => api.post('/me/mfa/totp/disable');
export const regenerateRecovery = () => api.post('/me/mfa/recovery/regenerate');
export const passkeys = () => api.get('/me/passkeys');
export const passkeyRegisterOptions = () => api.post('/me/passkeys/options');
export const passkeyRegister = (response: unknown, name: string) => api.post('/me/passkeys', { response, name });
export const passkeyDelete = (id: string) => api.del(`/me/passkeys/${encodeURIComponent(id)}`);
export const readiness = () => api.get('/me/readiness');
export const saveReadiness = (payload: unknown) => api.put('/me/readiness', payload);
export const memberReadiness = (id: string) => api.get(`/me/readiness/${encodeURIComponent(id)}`);
/** The fitness reports the person received (ADR-0047): theirs alone, a leader reads only the ones shared. */
export interface FitnessReport {
  id: string; user_id: string; version: number; created_at: string; updated_at: string;
  period_from: string; period_to: string; occasion: string; report_type: string; grade: string; rs_label: string | null;
  marks: string | null; rpt_avg: number | null; rs_avg: number | null; rs_high: number | null;
  reports_at_processing: number | null; reports_cumulative: number | null; rv_at_processing: number | null; cum_rv_printed: number | null; shared: number;
}
export const fitnessReports = () => api.get<{ reports: FitnessReport[] }>('/me/fitness-reports');
export const saveFitnessReport = (id: string | null, body: Record<string, unknown>) => (id
  ? api.put<FitnessReport>(`/me/fitness-reports/${encodeURIComponent(id)}`, body)
  : api.post<FitnessReport>('/me/fitness-reports', body));
export const deleteFitnessReport = (id: string) => api.del(`/me/fitness-reports/${encodeURIComponent(id)}`);
export const memberFitnessReports = (id: string) => api.get<{ reports: FitnessReport[]; shared_only: boolean }>(`/me/readiness/${encodeURIComponent(id)}/fitness-reports`);
/**
 * Notices (ADR-0031), newest first, `limit` at a time; `cursor` is the previous page's `next_cursor`. Polled in the
 * background, so it is marked as such: a poll must not keep an idle session alive.
 */
export interface NoticeQuery { limit?: number; cursor?: string | null; filter?: 'all' | 'unread'; group?: NoticeGroup | null }
export const notifications = (q: NoticeQuery | number = {}) => {
  const o: NoticeQuery = typeof q === 'number' ? { limit: q } : q;
  const qs = new URLSearchParams({ limit: String(o.limit ?? 40) });
  if (o.cursor) qs.set('cursor', o.cursor);
  if (o.filter === 'unread') qs.set('filter', 'unread');
  if (o.group) qs.set('group', o.group);
  return request<NoticesResponse>('GET', `/me/notifications?${qs}`, undefined, { headers: { 'x-vantage-background': '1' } });
};
export const markRead = (id: string) => api.put(`/me/notifications/${encodeURIComponent(id)}/read`);
export const markAllRead = (group?: NoticeGroup | null) => api.post<{ ok: true; updated: number }>('/me/notifications/read-all', group ? { group } : {});
/** Questions and review requests asked of the reader, and those they asked (ADR-0031). */
export const myRequests = () => request<{ asked_of_you: RequestSummary[]; you_asked: RequestSummary[] }>('GET', '/me/requests', undefined, { headers: { 'x-vantage-background': '1' } });
/** An access log a page at a time, newest first: `next` is the `before` of the page after it, null on the last. */
export interface AccessLogPage<Row> { rows: Row[]; next: number | null }
export interface MyAccessRow { seq: number; id: string; action: string; entity: string | null; entity_id: string | null; detail: string | null; at: string; first_name: string | null; last_name: string | null; rank_abbr: string | null }
export const myAudit = (before?: number | null) => api.get<AccessLogPage<MyAccessRow>>(`/me/audit${before ? `?before=${before}` : ''}`);
/**
 * The reader's own activity: what they did, and what happened on their account with nobody signed in (`by: 'account'`).
 * Filtered by category, action and UTC days as the audit trails are. No address, no unit or Unit Instance field and no
 * id of anyone is in it; an entry's words may still name a unit.
 */
export interface MyActivityRow { seq: number; id: string; at: string; action: string; category: string | null; entity: string | null; detail: string | null; by: 'you' | 'account' }
export interface MyActivityFilter { category?: string; action?: string; from?: string; to?: string }
export const myActivity = (filter: MyActivityFilter = {}, before?: number | null) => {
  const qs = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])));
  if (before) qs.set('before', String(before));
  const query = qs.toString();
  return api.get<AccessLogPage<MyActivityRow>>(`/me/activity${query ? `?${query}` : ''}`);
};
export const digestPreview = () => api.get('/me/digest/preview');
export const digestSendNow = () => api.post('/me/digest/send-now');
export const emailVerify = (email: string) => api.post('/me/email/verify', { email });
export const emailConfirm = (token: string) => api.post('/me/email/confirm', { token });

export const STORES = ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards', 'counselings', 'duties'] as const;
export type Store = (typeof STORES)[number];
export const listRecords = <S extends Store>(store: S, params: Record<string, string | undefined> = {}) => {
  const qs = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
  return api.get<Array<RecordRows[S]>>(`/records/${store}${qs ? `?${qs}` : ''}`);
};
export const getRecord = (store: Store, id: string) => api.get(`/records/${store}/${encodeURIComponent(id)}`);
/** A form sent from its saved draft names it, and the version its sender read, so its route removes it (ADR-0030). */
export type DraftRef = { id: string; version: number };
const fromDraft = (d?: DraftRef | null) => (d ? `?draft=${encodeURIComponent(d.id)}&draft_version=${d.version}` : '');
export const createRecord = (store: Store, data: unknown, draft?: DraftRef | null) => api.post(`/records/${store}${fromDraft(draft)}`, data);
export const updateRecord = (store: Store, id: string, patch: unknown) => api.put(`/records/${store}/${encodeURIComponent(id)}`, patch);
export const deleteRecord = (store: Store, id: string) => api.del(`/records/${store}/${encodeURIComponent(id)}`);
export const restoreRecord = (store: Store, id: string) => api.post(`/records/${store}/${encodeURIComponent(id)}/restore`);
export const importActivities = (rows: unknown[]) => api.post('/records/activities/import', { rows });
// A counseling's workflow (ADR-0027): each step against the version its reader saw. The Marine acknowledges the text they
// read; an amendment says why; its history and worksheet are read from what is stored, and the PDF is drawn from it.
export type CounselingStep = 'share' | 'withdraw' | 'finalize' | 'acknowledge';
export const counselingStep = (id: string, step: CounselingStep, version: number) => api.post<RecordRows['counselings']>(`/records/counselings/${encodeURIComponent(id)}/${step}`, { version });
export const acknowledgeCounseling = (id: string, version: number) => counselingStep(id, 'acknowledge', version);
export type CounselingAmendment = Partial<Record<CounselingField, string | null>> & { version: number; reason: string };
export const amendCounseling = (id: string, body: CounselingAmendment) => api.post<RecordRows['counselings']>(`/records/counselings/${encodeURIComponent(id)}/amend`, body);
export const counselingRevisions = (id: string) => api.get<{ revision: number; revisions: CounselingRevision[] }>(`/records/counselings/${encodeURIComponent(id)}/revisions`);
export const counselingWorksheet = (id: string, opts: { revision?: number | null; purpose?: 'view' | 'print' } = {}) =>
  api.get<CounselingDocument>(`/records/counselings/${encodeURIComponent(id)}/worksheet${opts.revision || opts.purpose === 'print' ? `?${[opts.revision ? `revision=${opts.revision}` : '', opts.purpose === 'print' ? 'purpose=print' : ''].filter(Boolean).join('&')}` : ''}`);
export const counselingPdfUrl = (id: string, revision?: number | null) => `/api/records/counselings/${encodeURIComponent(id)}/export?format=pdf${revision ? `&revision=${revision}` : ''}`;
export const counselingPrintUrl = (id: string, opts: { revision?: number | null; autoprint?: boolean } = {}) =>
  `/career/counseling/${encodeURIComponent(id)}/print${opts.revision || opts.autoprint ? `?${[opts.revision ? `revision=${opts.revision}` : '', opts.autoprint ? 'autoprint=1' : ''].filter(Boolean).join('&')}` : ''}`;
export const attachments = (store: Store, id: string) => api.get<AttachmentsResponse>(`/records/${store}/${encodeURIComponent(id)}/attachments`);
/** What a file is and what it shows travel beside its name, as headers: the body is the file itself (ADR-0025). */
export const uploadAttachment = (store: Store, id: string, file: File, details: AttachmentDetails = {}) => request<AttachmentRow>('POST', `/records/${store}/${encodeURIComponent(id)}/attachments`, file, {
  headers: {
    'content-type': file.type || 'application/octet-stream', 'x-vantage-filename': encodeURIComponent(file.name),
    ...(details.kind ? { 'x-vantage-evidence-kind': details.kind } : {}),
    ...(details.description ? { 'x-vantage-description': encodeURIComponent(details.description) } : {}),
  },
});
export const updateAttachment = (store: Store, id: string, attachmentId: string, details: AttachmentDetails) => api.put<AttachmentRow>(`/records/${store}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, details);
export const deleteAttachment = (store: Store, id: string, attachmentId: string) => api.del(`/records/${store}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`);
export const attachmentUrl = (store: Store, id: string, attachmentId: string) => `/api/records/${store}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;

export const comments = (store: Store, id: string) => api.get(`/records/${store}/${encodeURIComponent(id)}/comments`);
// Moving an entry to the record type it belongs in, and back (ADR-0015). Its owner's alone.
export const moveRecord = (store: MovableTable, id: string, body: { to: LineageTable; fields?: Record<string, unknown>; reason?: string | null; version?: number }) =>
  api.post<{ table: LineageTable; id: string; lineage_id: string; record: Record<string, unknown> }>(`/records/${store}/${encodeURIComponent(id)}/move`, body);
export const undoMove = (store: LineageTable, id: string) => api.post<{ table: LineageTable; id: string; record: Record<string, unknown> }>(`/records/${store}/${encodeURIComponent(id)}/undo-move`);
export const recordLineage = (store: LineageTable, id: string) => api.get<LineageResponse>(`/records/${store}/${encodeURIComponent(id)}/lineage`);
export const keepAsActivity = (id: string) => api.post(`/records/activities/${encodeURIComponent(id)}/keep`);
export const addComment = (store: Store, id: string, body: string) => api.post<DiscussionEntry & Told>(`/records/${store}/${encodeURIComponent(id)}/comments`, { body });

/**
 * A discussion's home (ADR-0031): a record, or a work case. A case takes questions and review requests, never free
 * comments; its notes are its own sealed history.
 */
export type DiscussionHost = { kind: 'record'; table: Store; id: string } | { kind: 'work'; id: string };
const discussionBase = (h: DiscussionHost) => (h.kind === 'work' ? `/work/items/${encodeURIComponent(h.id)}` : `/records/${h.table}/${encodeURIComponent(h.id)}`);
export const discussion = (h: DiscussionHost) => api.get<{ comments: DiscussionEntry[] }>(`${discussionBase(h)}/comments`);
export const askRequest = (h: DiscussionHost, body: { kind: RequestKind; addressee_id: string; body: string }) => api.post<DiscussionEntry>(`${discussionBase(h)}/requests`, body);
export const answerRequest = (h: DiscussionHost, requestId: string, body: { outcome?: 'looks_right' | 'needs_changes'; body?: string }) =>
  api.post<{ request: DiscussionEntry; answer: DiscussionEntry | null }>(`${discussionBase(h)}/requests/${encodeURIComponent(requestId)}/answer`, body);
export const withdrawRequest = (h: DiscussionHost, requestId: string) => api.post<DiscussionEntry>(`${discussionBase(h)}/requests/${encodeURIComponent(requestId)}/withdraw`);
/**
 * Who may be named or asked on it: up to ten, by rank and name, matching `q`. With a request kind, only those who may be
 * asked that: on a duty, a review goes only to someone who may decide it, never its Marine.
 */
export const discussionPeople = (h: DiscussionHost, q: string, kind?: RequestKind) =>
  api.get<SpeakersResponse>(`${discussionBase(h)}/people?q=${encodeURIComponent(q)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`);
export const editComment = (store: Store, id: string, commentId: string, body: string) => api.put<DiscussionEntry & Told>(`/records/${store}/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { body });
export const deleteComment = (store: Store, id: string, commentId: string) => api.del(`/records/${store}/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`);

export const team = () => api.get<TeamResponse>('/org/team');
// A unit change made on Unit Instance authority asks the person to confirm it is them, as the console does (ADR-0040).
export const member = (id: string) => api.get<MemberDetailResponse>(`/org/team/${encodeURIComponent(id)}`);
export const updateMemberProfile = (id: string, payload: unknown) => withSudo(() => api.put(`/org/team/${encodeURIComponent(id)}/profile`, payload));
export const directory = (unitId: string, q: string) => api.get<DirectoryResponse>(`/org/directory?unit_id=${encodeURIComponent(unitId)}&q=${encodeURIComponent(q)}`);
export const addMember = (unitId: string, payload: unknown) => withSudo(() => api.post(`/org/units/${encodeURIComponent(unitId)}/members`, payload));
export const updateMembership = (unitId: string, userId: string, payload: unknown, draft?: DraftRef | null) => withSudo(() => api.put<{ ok: boolean; changed: string[] }>(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}${fromDraft(draft)}`, payload));
// Personnel records (ADR-0017).
export const personnelRoster = (unitId: string) => api.get<PersonnelRosterResponse>(`/org/units/${encodeURIComponent(unitId)}/personnel`);
export const personnelRecord = (userId: string) => api.get<PersonnelRecordResponse>(`/org/team/${encodeURIComponent(userId)}/personnel`);
export const supervisorCandidates = (unitId: string, q: string, except?: string) => api.get<{ results: PersonnelPersonRef[]; more: boolean }>(`/org/units/${encodeURIComponent(unitId)}/supervisor-candidates?q=${encodeURIComponent(q)}${except ? `&except=${encodeURIComponent(except)}` : ''}`);
export const addResponsibility = (unitId: string, userId: string, payload: { title: string; starts_on?: string | null; ends_on?: string | null; reason?: string | null }) => withSudo(() => api.post<{ id: string }>(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}/responsibilities`, payload));
export const endResponsibility = (id: string, reason?: string | null) => withSudo(() => api.post(`/org/responsibilities/${encodeURIComponent(id)}/end`, { reason: reason || null }));
export const personnelBulk = (unitId: string, payload: { items: Array<{ user_id: string; unit_id: string }>; action: string; value: string | null; reason?: string | null; dry_run?: boolean }) => withSudo(() => api.post<PersonnelBulkResponse>(`/org/units/${encodeURIComponent(unitId)}/personnel/bulk`, payload));
export const teamAudience = (unitId: string) => api.get<TeamAudience>(`/org/units/${encodeURIComponent(unitId)}/message`);
export const messageTeam = (unitId: string, payload: { subject: string; body: string; files?: TeamMessageFileUpload[]; confirmFiles?: boolean }) => withSudo(() => api.post<TeamMessageResult>(`/org/units/${encodeURIComponent(unitId)}/message`, payload));
// A kept team message and its files (ADR-0049), on a route only the application's host answers.
export const teamMessage = (id: string) => api.get<TeamMessageView>(`/team-messages/${encodeURIComponent(id)}`);
export const teamMessageFileUrl = (id: string, fileId: string) => `/api/team-messages/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`;
export const moveMember = (unitId: string, userId: string, payload: { to: string; entries?: 'stay' | 'move' }) => withSudo(() => api.post(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}/move`, payload));
export const removeMember = (unitId: string, userId: string) => withSudo(() => api.del(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}`));
export const createInvite = (unitId: string, payload: unknown) => withSudo(() => api.post(`/org/units/${encodeURIComponent(unitId)}/invites`, payload));
export const listInvites = (unitId: string) => api.get(`/org/units/${encodeURIComponent(unitId)}/invites`);
export const revokeInvite = (id: string) => withSudo(() => api.del(`/org/invites/${encodeURIComponent(id)}`));
export const supportTickets = (mine = false) => api.get(`/support/tickets${mine ? '?mine=1' : ''}`);
export const supportTicket = (id: string) => api.get(`/support/tickets/${encodeURIComponent(id)}`);
export const raiseSupportTicket = (payload: { subject: string; body: string; category: string; unit_id: string | null }) => api.post('/support/tickets', payload);
export const replySupportTicket = (id: string, payload: { body: string; internal: boolean }) => api.post(`/support/tickets/${encodeURIComponent(id)}/messages`, payload);
export const updateSupportTicket = (id: string, payload: { state?: string; priority?: string; assigned_to?: string | null; version?: number }) => api.patch(`/support/tickets/${encodeURIComponent(id)}`, payload);
/** For someone who cannot sign in: no account needed, and the answer says nothing about whether one exists. */
export const askForHelp = (payload: { subject: string; body: string; category: 'sign_in' | 'bug'; requester_name?: string; requester_email: string }) => api.post('/public-support/tickets', payload);
export const createJoinCode = (unitId: string, payload: { role_id?: string | null; note?: string | null; max_uses?: number | null; expires_in_hours?: number | null }) => withSudo(() => api.post(`/org/units/${encodeURIComponent(unitId)}/join-codes`, payload));
export const listJoinCodes = (unitId: string) => api.get(`/org/units/${encodeURIComponent(unitId)}/join-codes`);
export const revokeJoinCode = (unitId: string, id: string) => withSudo(() => api.del(`/org/units/${encodeURIComponent(unitId)}/join-codes/${encodeURIComponent(id)}`));
export const peekJoinCode = (code: string) => api.get(`/org/join-codes/${encodeURIComponent(code)}`);
export const joinWithCode = (code: string) => api.post(`/org/join-codes/${encodeURIComponent(code)}/join`);
export const roles = () => api.get<RolesResponse>('/org/roles');
export const createRole = (payload: unknown) => withSudo(() => api.post('/org/roles', payload));
export const updateRole = (id: string, payload: unknown) => withSudo(() => api.put(`/org/roles/${encodeURIComponent(id)}`, payload));
export const deleteRole = (id: string) => withSudo(() => api.del(`/org/roles/${encodeURIComponent(id)}`));
export const grantRole = (userId: string, payload: unknown) => withSudo(() => api.post(`/org/team/${encodeURIComponent(userId)}/roles`, payload));
export const revokeRole = (userId: string, roleId: string) => withSudo(() => api.del(`/org/team/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`));
export const createUnit = (payload: unknown) => withSudo(() => api.post('/org/units', payload));
export const updateUnit = (id: string, payload: unknown) => withSudo(() => api.put(`/org/units/${encodeURIComponent(id)}`, payload));
export const archiveUnit = (id: string) => withSudo(() => api.del(`/org/units/${encodeURIComponent(id)}`));
export const transferOwnership = (id: string, userId: string) => withSudo(() => api.post(`/org/units/${encodeURIComponent(id)}/owner`, { user_id: userId }));
export const unitOverview = (id: string, opts: { roster?: boolean } = {}) => api.get(`/org/units/${encodeURIComponent(id)}/overview${opts.roster ? '?roster=1' : ''}`);
export const unitDashboard = (id: string, from?: string, to?: string) => api.get(`/org/units/${encodeURIComponent(id)}/dashboard${from && to ? `?from=${from}&to=${to}` : ''}`);
/** The unit's analytics: one section's figures over a window, and the records behind one of them. */
export const unitAnalytics = (id: string, section: AnalyticsSection, from: string, to: string) =>
  api.get<AnalyticsResponse>(`/org/units/${encodeURIComponent(id)}/analytics/${section}?${qs({ from, to })}`);
export const unitAnalyticsDrill = (id: string, section: AnalyticsSection, q: { from: string; to: string; visual: string; key: string; series?: string | null }) =>
  api.get<DrillResponse>(`/org/units/${encodeURIComponent(id)}/analytics/${section}/drill?${qs({ from: q.from, to: q.to, visual: q.visual, key: q.key, series: q.series || undefined })}`);
export interface UnitAccessRow { seq: number; id: string; action: string; entity: string | null; entity_id: string | null; detail: string | null; at: string; actor_id: string | null; subject_id: string | null; actor_first: string | null; actor_last: string | null; actor_rank: string | null; subject_first: string | null; subject_last: string | null }
/** A unit's access log a page at a time; `person` narrows it to one person's entries in the unit, by their id. */
export const unitAudit = (id: string, before?: number | null, person?: string) => {
  const query = qs({ before: before || undefined, person });
  return api.get<AccessLogPage<UnitAccessRow> & { unit_id: string }>(`/org/units/${encodeURIComponent(id)}/audit${query ? `?${query}` : ''}`);
};
/** A unit's shared work: the records in two days, or every date with none (ADR-0039). */
export const unitExport = (id: string, range?: { from: string; to: string }) => api.get(`/org/units/${encodeURIComponent(id)}/export${range ? `?${qs(range)}` : ''}`);
/** "Why can they?": every grant behind someone's authority, in the units the caller manages. */
export const whyCan = (userId: string) => api.get(`/org/team/${encodeURIComponent(userId)}/why`);

const qs = (params: Record<string, string | number | undefined | null>) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
export const goalContributors = (id: string) => api.get(`/records/goals/${encodeURIComponent(id)}/contributors`);
/** One page of the packages one may open, newest first; next_cursor names the page after it, or null on the last. */
export interface ReportDraftRow { id: string; title: string; period_start: string; period_end: string; subject_id: string | null; updated_at: string | null; latest_revision: number | null }
export interface ReportDraftPage { drafts: ReportDraftRow[]; next_cursor: string | null }
export const listReportDrafts = (before?: string | null) => api.get<ReportDraftPage>(`/studio/reports${before ? `?${qs({ before })}` : ''}`);
export const createReportDraft = (body: Record<string, unknown>) => api.post('/studio/reports', body);
export const reportDraft = (id: string) => api.get(`/studio/reports/${encodeURIComponent(id)}`);
export const saveReportRevision = (id: string, body: Record<string, unknown>) => api.post(`/studio/reports/${encodeURIComponent(id)}/revisions`, body);
export const reportRevisionExportUrl = (id: string, revision: number) => `/api/studio/reports/${encodeURIComponent(id)}/revisions/${revision}/export.txt`;

export const uploadSource = (file: File, opts: { unitId: string | null; visibility: 'private' | 'unit' }) =>
  request('POST', '/work/sources', file, {
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': file.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255),
      'x-unit-id': opts.unitId || '',
      'x-visibility': opts.visibility,
    },
  });
export const inspectSource = (id: string) => api.get(`/work/sources/${encodeURIComponent(id)}`);
export const previewImport = (plan: unknown) => api.post('/work/imports/preview', plan);
export const runImport = (plan: unknown, idempotencyKey: string) => request('POST', '/work/imports', plan, { headers: { 'idempotency-key': idempotencyKey } });
export const listWorkItems = (params: Record<string, string | number | undefined | null>, options: { background?: boolean; signal?: AbortSignal } = {}) =>
  request('GET', `/work/items?${qs(params)}`, undefined, { signal: options.signal, ...(options.background ? { headers: { 'x-vantage-background': '1' } } : {}) });
export const workItem = (id: string) => api.get<WorkItemDetail>(`/work/items/${encodeURIComponent(id)}`);
export const claimWorkItem = (id: string, version: number) => api.post(`/work/items/${encodeURIComponent(id)}/claim`, { version });
export const releaseWorkItem = (id: string, version: number) => api.post(`/work/items/${encodeURIComponent(id)}/release`, { version });
export const previewBulkWork = (body: BulkWorkInput) => api.post<BulkWorkResponse>('/work/bulk/preview', body);
export const runBulkWork = (body: BulkWorkInput, key: string) => request<BulkWorkResponse>('POST', '/work/bulk', body, { headers: { 'idempotency-key': key } });
export const bulkHandoffCandidates = (ids: string[]) => api.post<HandoffCandidate[]>('/work/bulk/candidates', { ids });
export const patchWorkItem = (id: string, patch: Record<string, unknown>) => request('PATCH', `/work/items/${encodeURIComponent(id)}`, patch);
export const createWorkItem = (body: Record<string, unknown>) => api.post('/work/items', body);
export const recordWorkAction = (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
  request('POST', `/work/items/${encodeURIComponent(id)}/actions`, body, { headers: { 'idempotency-key': idempotencyKey } });
export const listWorkViews = () => api.get('/work/views');
export const saveWorkView = (body: Record<string, unknown>) => api.post('/work/views', body);
export const deleteWorkView = (id: string) => request('DELETE', `/work/views/${encodeURIComponent(id)}`);

export const metrics = (params: Record<string, string | number | undefined | null>) => api.get(`/metrics?${qs(params)}`);
export const metricContributors = (params: Record<string, string | number | undefined | null>) => api.get(`/metrics/contributors?${qs(params)}`);
export const report = (params: Record<string, string | number | undefined | null>) => api.get(`/reports?${qs(params)}`);
export const reportAnalysis = (params: Record<string, string | number | undefined | null>) => api.get(`/reports/analysis?${qs(params)}`);
// A Marine's statistics over a range (ADR-0051): one's own with no user_id, or another Marine's through one unit.
export const marineStatistics = (params: Record<string, string | undefined>) => api.get<MarineStatistics>(`/statistics?${qs(params)}`);
export const analysisPdfUrl = (params: Record<string, string | number | undefined | null>) => `/api/reports/analysis.pdf?${qs(params)}`;
export const reportDelta = (params: Record<string, string | number | undefined | null>) => api.get(`/reports/delta?${qs(params)}`);
export const reportPdfUrl = (params: Record<string, string | number | undefined | null>) => `/api/reports/pdf?${qs(params)}`;
export const myExportUrl = (format: 'zip' | 'json' | 'xlsx' | 'csv', sections?: string[]) => `/api/me/export?format=${format}${sections?.length ? `&sections=${sections.map(encodeURIComponent).join(',')}` : ''}`;
// Importing records (ADR-0019): staged, reviewed and corrected, then written in one go, and undone once.
export const stageRecordImport = (file: File) =>
  request<ImportReview>('POST', '/me/imports', file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255) } });
export const recordImports = () => api.get<{ imports: ImportSummary[] }>('/me/imports');
export const recordImport = (id: string) => api.get<ImportReview>(`/me/imports/${encodeURIComponent(id)}`);
export const planRecordImport = (id: string, plan: ImportPlanBody) => api.put<ImportReview>(`/me/imports/${encodeURIComponent(id)}`, plan);
export const commitRecordImport = (id: string, plan: ImportPlanBody & { expected?: { new: number; update: number } }) => api.post<ImportReview>(`/me/imports/${encodeURIComponent(id)}/commit`, plan);
export const undoRecordImport = (id: string) => api.post<ImportReview>(`/me/imports/${encodeURIComponent(id)}/undo`);
export const cancelRecordImport = (id: string) => request('DELETE', `/me/imports/${encodeURIComponent(id)}`);
export const recordExportUrl = (table: string, id: string, format: 'json' | 'csv' | 'zip') => `/api/records/${encodeURIComponent(table)}/${encodeURIComponent(id)}/export?format=${format}`;
export const reportCsvUrl = (params: Record<string, string | number | undefined | null>) => `/api/reports/csv?${qs(params)}`;
// The report center (ADR-0020): one document for the screen, the print page and every file; saved choices, never data.
export const runReport = (params: Record<string, string | undefined>, purpose: 'view' | 'print' = 'view') =>
  api.get<ReportDocument & { files: ReportFileFormat[] }>(`/report-center/run?${qs({ ...params, purpose })}`);
export const reportFileUrl = (params: Record<string, string | undefined>, format: ReportFileFormat) => `/api/report-center/export?${qs({ ...params, format })}`;
export const reportDefinitions = () => api.get<ReportDefinitionRow[]>('/report-center/definitions');
export const saveReportDefinition = (body: { name: string; type: string; params: Record<string, string>; visibility?: 'private' | 'unit'; unit_id?: string | null }, id?: string) =>
  id ? api.put<ReportDefinitionRow>(`/report-center/definitions/${encodeURIComponent(id)}`, body) : api.post<ReportDefinitionRow>('/report-center/definitions', body);
export const deleteReportDefinition = (id: string) => api.del(`/report-center/definitions/${encodeURIComponent(id)}`);
// Financial error reports (ADR-0021): filed from an uploaded report, kept as filed, compared report to report.
export interface ErrorFilingPlan {
  unit_id: string; type_id: string; as_of: string; source_file_id: string; sheet_name: string; header_row: number;
  key_columns: string[]; columns: Record<string, ColumnRole>; closed_statuses: string[] | null; note?: string | null;
}
export interface ErrorComparisonQuery { unit_id: string; type_id: string; snapshot?: string; against?: string }
export const errorReports = (unitId: string) => api.get<ErrorReportsOverview>(`/error-reports?${qs({ unit_id: unitId })}`);
export const errorReportChoices = (unitId: string) => api.get<ErrorReportChoices>(`/error-reports/choices?${qs({ unit_id: unitId })}`);
export const errorReportLayout = (unitId: string, typeId: string) => api.get<{ layout: ErrorReportLayout | null }>(`/error-reports/layout?${qs({ unit_id: unitId, type_id: typeId })}`);
export const previewErrorReport = (plan: ErrorFilingPlan) => api.post<ErrorReportPreview>('/error-reports/preview', plan);
export const fileErrorReport = (plan: ErrorFilingPlan) => api.post<SnapshotSummary & { unit_id: string; type_id: string }>('/error-reports/snapshots', plan);
export const withdrawErrorReport = (id: string, reason: string) => api.post<SnapshotSummary>(`/error-reports/snapshots/${encodeURIComponent(id)}/withdraw`, { reason });
export const errorComparison = (q: ErrorComparisonQuery) => api.get<ComparisonResult | SeriesHistory>(`/error-reports/series?${qs({ ...q })}`);
export const errorDrill = (q: ErrorComparisonQuery & { drill: Drill; group?: DrillGroup; value?: string; offset?: number; limit?: number }) => api.get<DrillResult>(`/error-reports/rows?${qs({ ...q })}`);
export const aiStatus = () => api.get('/ai/status');
export const aiAssist = (workflow: string, input: unknown, model?: string) => api.post('/ai/assist', { workflow, input, model });
export const maradmins = (wait = false) => api.get(`/maradmins${wait ? '?wait=1' : ''}`);
export const maradminState = (id: string, payload: unknown) => api.put(`/maradmins/${encodeURIComponent(id)}/state`, payload);
export const search = (q: string) => api.get(`/search?q=${encodeURIComponent(q)}`);

// Vantage Administrator console (/api/platform): the service, for Vantage staff
const enc = encodeURIComponent;
export const platformMe = () => api.get('/platform/me');
export const platformOverview = () => api.get('/platform/overview');
export const platformRuntime = (patch: unknown) => api.put('/platform/runtime', patch);
/** Controlled maintenance (ADR-0011): starting takes a reason for the audit trail; ending may leave a note. */
export type MaintenanceRequest = { enabled: true; reason: string; message?: string | null; until?: string | null } | { enabled: false; note?: string | null };
export const platformMaintenance = (body: MaintenanceRequest) => api.post('/platform/maintenance', body);
export const platformMaintenanceState = () => api.get('/platform/maintenance');
export const platformMaintenanceTask = (task: string) => api.post(`/platform/maintenance/tasks/${encodeURIComponent(task)}`);
export const platformOperations = () => api.get('/platform/operations');
export const platformSignInHealth = () => api.get('/platform/sign-in-health');
export const platformOidcCheck = () => api.post('/platform/sign-in-health/oidc-check');
export const platformFlags = () => api.get('/platform/flags');
// Official policy and official system guidance the case diagnoser cites for every Unit Instance (ADR-0022).
export const platformCaseGuidance = () => api.get('/platform/case-guidance');
export const platformAddCaseGuidance = (body: unknown) => api.post('/platform/case-guidance', body);
export const platformRetireCaseGuidance = (id: string, reason: string) => api.post(`/platform/case-guidance/${enc(id)}/retire`, { reason });
// Approved course sources and their catalogs (ADR-0029): registered with their authorization, staged, looked at, applied.
export const platformCourseSources = () => api.get<{ sources: CourseSourceRecord[] }>('/platform/course-sources');
export const platformRegisterCourseSource = (body: unknown) => api.post<CourseSourceRecord>('/platform/course-sources', body);
export const platformWithdrawCourseSource = (id: string, reason: string) => api.post<CourseSourceRecord>(`/platform/course-sources/${enc(id)}/withdraw`, { reason });
export const platformStageCatalog = (id: string, file: File, asOf: string) =>
  request<CourseSourceRecord>('POST', `/platform/course-sources/${enc(id)}/import?${qs({ as_of: asOf })}`, file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255) } });
export const platformApplyCatalog = (id: string, loadId: string, fileSha: string) => api.post<CourseSourceRecord>(`/platform/course-sources/${enc(id)}/loads/${enc(loadId)}/apply`, { file_sha256: fileSha });
export const platformDiscardCatalog = (id: string, loadId: string) => api.post<CourseSourceRecord>(`/platform/course-sources/${enc(id)}/loads/${enc(loadId)}/discard`);
export const platformCatalogEntries = (id: string, loadId: string, q: string, offset = 0) =>
  api.get<{ entries: CourseEntry[]; total: number; offset: number; limit: number }>(`/platform/course-sources/${enc(id)}/loads/${enc(loadId)}/entries?${qs({ q, offset })}`);
/** What a course code is listed as in the approved catalogs in use. Vantage fetches nothing to answer. */
export const lookupCourse = (code: string, signal?: AbortSignal) => request<CourseLookup>('GET', `/courses/lookup?${qs({ code })}`, undefined, { signal });
/** Each Unit Instance's version, schema, last upgrade, health, backup and restore (ADR-0014). */
export const platformInstanceOperations = () => api.get('/platform/instances/operations');
export const platformReviewUpgrade = (id: string, note: string) => api.post(`/platform/upgrades/${enc(id)}/review`, { note });
export const platformInstanceFeature = (orgId: string, flag: string, body: { withheld: boolean; reason?: string | null }) => api.put(`/platform/orgs/${enc(orgId)}/features/${enc(flag)}`, body);
export const platformRecovery = () => api.get('/platform/recovery');
export const platformAi = () => api.get('/platform/ai');
export const platformAiDiscover = () => api.post('/platform/ai/discover');
export const platformAiUnlock = () => api.post('/platform/ai/unlock');
export const platformSyncMaradmins = () => api.post('/platform/maradmins/sync');
export const platformIntegrity = () => api.get('/platform/integrity');
/** Accounts whose authority crosses a line the role model draws (ADR-0013). Read-only. */
export const platformSeparationOfDuties = () => api.get('/platform/separation-of-duties');
/** Anchors the case histories and the audit chain's head, written into the chain and so copied off the host. */
export const platformAnchorCases = () => api.post('/platform/integrity/anchor');
/** Checks an anchor kept off the host against the chain (ADR-0013). */
export const platformVerifyAnchor = (body: { seq: number; entry_hash: string }) => api.post('/platform/integrity/verify', body);
export const platformEmail = () => api.get('/platform/email');
export const platformEmailCheck = () => api.post('/platform/email/check', {});
export const platformEmailTest = (to?: string) => api.post('/platform/email/test', { to });
export const platformOrgs = () => api.get('/platform/orgs');
export const platformOrg = (orgId: string) => api.get(`/platform/orgs/${enc(orgId)}`);
export const platformCreateOrg = (body: unknown) => api.post('/platform/orgs', body);
export const platformUpdateOrg = (orgId: string, body: unknown) => api.patch(`/platform/orgs/${enc(orgId)}`, body);
export const platformOrgStatus = (orgId: string, status: string, reason?: string) => api.post(`/platform/orgs/${enc(orgId)}/status`, { status, reason });
export const platformNameOwner = (orgId: string, userId: string) => api.post(`/platform/orgs/${enc(orgId)}/owner`, { user_id: userId });
export const platformAssignManager = (orgId: string, userId: string, role: UnitManagerRole) => api.post(`/platform/orgs/${enc(orgId)}/managers`, { user_id: userId, role });
export const platformRemoveManager = (orgId: string, userId: string, role: UnitManagerRole) => api.del(`/platform/orgs/${enc(orgId)}/managers/${enc(userId)}/${role}`);
export const platformAccounts = (q = '', filter = '') => api.get(`/platform/accounts?${qs({ q, filter })}`);
export const platformAccountAction = (userId: string, action: 'unlock' | 'logout' | 'temporary-password' | 'reset-mfa' | 'deactivate' | 'reactivate', body: unknown = {}) =>
  api.post(`/platform/accounts/${enc(userId)}/${action}`, body);
export const platformSendSignInDetails = (userIds: string[]) => api.post('/platform/accounts/sign-in-details', { userIds });
/** Vantage support corrects the EDIPI a CAC signs in with, saying why (ADR-0009). */
export const platformCorrectEdipi = (userId: string, body: { edipi: string | null; reason: string; approvalId?: string }) => api.post(`/platform/accounts/${enc(userId)}/edipi`, body);
/** A second staff member approves a credential change to an account that holds authority (ADR-0013). */
export const platformCredentialApprovals = () => api.get('/platform/credential-approvals');
export const platformRequestCredentialApproval = (userId: string, body: { action: 'temporary_password' | 'reset_mfa' | 'edipi'; reason: string; edipi?: string | null }) =>
  api.post(`/platform/accounts/${enc(userId)}/credential-approvals`, body);
export const platformDecideCredentialApproval = (id: string, decision: 'approve' | 'deny', note?: string) => api.post(`/platform/credential-approvals/${enc(id)}/${decision}`, { note: note || undefined });
export const platformCancelCredentialApproval = (id: string) => api.post(`/platform/credential-approvals/${enc(id)}/cancel`);
export const platformStaff = () => api.get('/platform/staff');
export const platformGrantStaff = (body: { user_id?: string; username?: string; role: string }) => api.post('/platform/staff', body);
export const platformRevokeStaff = (userId: string, role: string) => api.del(`/platform/staff/${enc(userId)}/${enc(role)}`);
export const platformAccess = (status = '') => api.get(`/platform/access?${qs({ status })}`);
export const platformRequestAccess = (body: { org_id: string; reason: string; minutes?: number }) => api.post('/platform/access', body);
export const platformEndAccess = (id: string) => api.post(`/platform/access/${enc(id)}/end`);
/** `person` is one person's id: the entries they wrote and those about them. */
export interface PlatformAuditFilter { q?: string; action?: string; category?: string; from?: string; to?: string; person?: string; before?: number | null; limit?: number }
export const platformAudit = (filter: PlatformAuditFilter = {}) => api.get(`/platform/audit?${qs({ ...filter })}`);
/** The filtered platform trail as a file; the server records the download. */
export const platformAuditExportUrl = (filter: Omit<PlatformAuditFilter, 'before' | 'limit'>, format: 'csv' | 'json') => `/api/platform/audit/export?${qs({ ...filter, format })}`;
export const platformUsage = (params: Record<string, string | number | undefined | null>) => api.get(`/platform/usage?${qs(params)}`);
export const platformPrivacyInventory = () => api.get('/platform/privacy/inventory');
export const platformHolds = () => api.get('/platform/holds');
export const platformPlaceHold = (body: unknown) => api.post('/platform/holds', body);
export const platformReleaseHold = (id: string) => api.del(`/platform/holds/${enc(id)}`);
export const platformImport = (archive: unknown) => api.post('/platform/import', archive);

// Unit Manager console (/api/orgs/:orgId): one Unit Instance, for the people who hold its roles
const orgPath = (orgId: string, path = '') => `/orgs/${enc(orgId)}${path}`;
export const myOrgs = () => api.get('/orgs');
export const orgOverview = (orgId: string) => api.get(orgPath(orgId, '/overview'));
export const orgOperations = (orgId: string) => api.get(orgPath(orgId, '/operations'));
export const orgUpdate = (orgId: string, body: unknown) => api.patch(orgPath(orgId), body);
export const orgRoles = (orgId: string) => api.get(orgPath(orgId, '/roles'));
export const orgGrantRole = (orgId: string, body: { user_id: string; role: string; expires_at?: string | null }) => api.post(orgPath(orgId, '/roles'), body);
export const orgRevokeRole = (orgId: string, userId: string, role: string) => api.del(orgPath(orgId, `/roles/${enc(userId)}/${enc(role)}`));
/** One page of a Unit Instance's members: `next` (from the page before) starts the one after; `unit` keeps one unit's. */
export const orgMembers = (orgId: string, o: { q?: string; unit?: string | null; cursor?: string | null; limit?: number } = {}) => api.get<OrgMembersPage>(orgPath(orgId, `/members?${qs({ q: o.q, unit: o.unit, cursor: o.cursor, limit: o.limit })}`));
export const orgWhy = (orgId: string, userId: string) => api.get(orgPath(orgId, `/members/${enc(userId)}/why`));
export const orgMemberAction = (orgId: string, userId: string, action: 'unlock' | 'logout') => api.post(orgPath(orgId, `/members/${enc(userId)}/${action}`));
export const orgRemoveMember = (orgId: string, userId: string) => api.del(orgPath(orgId, `/members/${enc(userId)}`));
export const orgUnits = (orgId: string) => api.get(orgPath(orgId, '/units'));
export const orgSetLeader = (orgId: string, unitId: string, userId: string) => api.post(orgPath(orgId, `/units/${enc(unitId)}/leader`), { user_id: userId });
export const orgImportAccounts = (orgId: string, file: File, apply: boolean) =>
  request('POST', orgPath(orgId, `/accounts/import${apply ? '?apply=1' : ''}`), file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-vantage-filename': enc(file.name) } });
export const orgSignInAudience = (orgId: string) => api.get(orgPath(orgId, '/accounts/sign-in-details'));
export const orgSendSignInDetails = (orgId: string, userIds: string[]) => api.post(orgPath(orgId, '/accounts/sign-in-details'), { userIds });
export const orgPersonnel = (orgId: string) => api.get(orgPath(orgId, '/personnel'));
export const orgPersonnelDivergence = (orgId: string) => api.get(orgPath(orgId, '/personnel/divergence'));
export const orgPersonnelSync = (orgId: string, text: string, source: string, opts: { apply?: boolean; confirmSeparations?: boolean } = {}) =>
  request<any>('POST', orgPath(orgId, `/personnel/sync?source=${enc(source)}${opts.apply ? '&apply=1' : ''}${opts.confirmSeparations ? '&confirm_separations=1' : ''}`),
    new Blob([text], { type: 'text/plain' }), { headers: { 'content-type': 'text/plain' } });
export const orgPersonnelLink = (orgId: string, userId: string, edipi: string | null) => api.post(orgPath(orgId, '/personnel/link'), { user_id: userId, edipi });
export const orgRetention = (orgId: string) => api.get(orgPath(orgId, '/retention'));
export const orgSaveSchedule = (orgId: string, body: unknown) => api.put(orgPath(orgId, '/retention/schedule'), body);
export const orgRunDisposition = (orgId: string, apply: boolean) => api.post(orgPath(orgId, `/retention/run${apply ? '?apply=1' : ''}`));
export const orgPlaceHold = (orgId: string, body: unknown) => api.post(orgPath(orgId, '/holds'), body);
export const orgReleaseHold = (orgId: string, id: string) => api.del(orgPath(orgId, `/holds/${enc(id)}`));
export const orgPrivacyInventory = (orgId: string) => api.get(orgPath(orgId, '/privacy/inventory'));
export const orgPrivacyInventoryUrl = (orgId: string) => `/api${orgPath(orgId, '/privacy/inventory?format=markdown')}`;
export interface OrgAuditFilter extends PlatformAuditFilter { unit?: string }
export const orgAudit = (orgId: string, filter: OrgAuditFilter = {}) => api.get(orgPath(orgId, `/audit?${qs({ ...filter })}`));
/** The filtered Unit Instance trail as a file; the server records the download. */
export const orgAuditExportUrl = (orgId: string, filter: Omit<OrgAuditFilter, 'before' | 'limit'>, format: 'csv' | 'json') => `/api${orgPath(orgId, `/audit/export?${qs({ ...filter, format })}`)}`;
export const orgExportUrl = (orgId: string) => `/api${orgPath(orgId, '/export')}`;
export const orgRosterUrl = (orgId: string) => `/api${orgPath(orgId, '/roster.csv')}`;
export const orgUnitRoles = (orgId: string) => api.get(orgPath(orgId, '/unit-roles'));
// Unit configuration (ADR-0012): billets, duty types, training requirements, work and report settings.
export const orgConfiguration = (orgId: string) => api.get(orgPath(orgId, '/configuration'));
export const orgSaveBillet = (orgId: string, body: unknown, id?: string) => (id ? api.patch(orgPath(orgId, `/billets/${enc(id)}`), body) : api.post(orgPath(orgId, '/billets'), body));
export const orgSaveDutyType = (orgId: string, body: unknown, id?: string) => (id ? api.patch(orgPath(orgId, `/duty-types/${enc(id)}`), body) : api.post(orgPath(orgId, '/duty-types'), body));
export const orgAddStandardDutyTypes = (orgId: string) => api.post(orgPath(orgId, '/duty-types/standard'));
export const orgSaveErrorReportType = (orgId: string, body: unknown, id?: string) => (id ? api.patch(orgPath(orgId, `/error-report-types/${enc(id)}`), body) : api.post(orgPath(orgId, '/error-report-types'), body));
export const orgAddStandardErrorReportTypes = (orgId: string) => api.post(orgPath(orgId, '/error-report-types/standard'));
export const orgSaveTrainingRequirement = (orgId: string, body: unknown, id?: string) => (id ? api.patch(orgPath(orgId, `/training-requirements/${enc(id)}`), body) : api.post(orgPath(orgId, '/training-requirements'), body));
export const orgSaveUnitSettings = (orgId: string, body: unknown) => api.patch(orgPath(orgId, '/configuration/settings'), body);
export const orgConfigurationExportUrl = (orgId: string) => `/api${orgPath(orgId, '/configuration/export')}`;
export const orgImportConfiguration = (orgId: string, file: unknown, apply: boolean) => api.post(orgPath(orgId, `/configuration/import${apply ? '?apply=1' : ''}`), file);
// Duty scoring versions (ADR-0012): published once, withdrawn only before they take effect.
export const orgPublishScoringPolicy = (orgId: string, body: unknown) => api.post(orgPath(orgId, '/duty-scoring'), body);
export const orgWithdrawScoringPolicy = (orgId: string, id: string) => api.post(orgPath(orgId, `/duty-scoring/${enc(id)}/withdraw`));
// Guidance on file for the case diagnoser (ADR-0022): the command's SOPs and SME workflows, and its validated examples.
export const orgCaseGuidance = (orgId: string) => api.get(orgPath(orgId, '/case-guidance'));
export const orgAddCaseGuidance = (orgId: string, body: unknown) => api.post(orgPath(orgId, '/case-guidance'), body);
export const orgRetireCaseGuidance = (orgId: string, id: string, reason: string) => api.post(orgPath(orgId, `/case-guidance/${enc(id)}/retire`), { reason });
export const orgAccess = (orgId: string) => api.get(orgPath(orgId, '/access'));
export const orgDecideAccess = (orgId: string, id: string, approve: boolean, note?: string) => api.post(orgPath(orgId, `/access/${enc(id)}/${approve ? 'approve' : 'deny'}`), { note });
export const orgRevokeAccess = (orgId: string, id: string) => api.post(orgPath(orgId, `/access/${enc(id)}/revoke`));
export const demoGovernance = () => api.get('/demo/governance');

export async function downloadFile(url: string, fallbackName: string) {
  const sentWith = signedInMarker();
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) { sessionEnded(sentWith); throw new ApiError('Your session has expired.', 401); }
  if (!res.ok) { let payload: Record<string, unknown> = {}; try { payload = await res.json(); } catch {} throw new ApiError((payload.error as string) || `Download failed (${res.status}).`, res.status, payload); }
  const blob = await res.blob();
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  return name;
}

export const listContacts = () => api.get('/correspondence/contacts');
export const createContact = (body: Record<string, unknown>) => api.post('/correspondence/contacts', body);
export const updateContact = (id: string, body: Record<string, unknown>) => api.put(`/correspondence/contacts/${encodeURIComponent(id)}`, body);
export const listThreads = (params: Record<string, string | number | undefined | null> = {}) => api.get(`/correspondence/threads?${qs(params)}`);
export const createThread = (body: Record<string, unknown>) => api.post('/correspondence/threads', body);
export const threadDetail = (id: string) => api.get(`/correspondence/threads/${encodeURIComponent(id)}`);
export const setThreadState = (id: string, body: Record<string, unknown>) => api.post(`/correspondence/threads/${encodeURIComponent(id)}/state`, body);
export const addThreadMessage = (id: string, body: Record<string, unknown>) => api.post(`/correspondence/threads/${encodeURIComponent(id)}/messages`, body);
export const linkThreadWork = (id: string, workItemIds: string[]) => api.post(`/correspondence/threads/${encodeURIComponent(id)}/links`, { work_item_ids: workItemIds });
export const unlinkThreadWork = (id: string, workItemId: string) => request('DELETE', `/correspondence/threads/${encodeURIComponent(id)}/links/${encodeURIComponent(workItemId)}`);
export const threadsForItem = (workItemId: string) => api.get(`/correspondence/items/${encodeURIComponent(workItemId)}/threads`);
export const importEmail = (file: File, opts: { threadId?: string | null; unitId: string | null; visibility: 'private' | 'unit'; contactId?: string | null; direction?: 'inbound' | 'outbound' }) =>
  request('POST', '/correspondence/messages/import', file, {
    headers: {
      'content-type': 'message/rfc822',
      'x-thread-id': opts.threadId || '',
      'x-unit-id': opts.unitId || '',
      'x-visibility': opts.visibility,
      'x-contact-id': opts.contactId || '',
      'x-direction': opts.direction || 'inbound',
    },
  });
export const listConnectors = () => api.get('/correspondence/connectors');
export const createConnector = (body: Record<string, unknown>) => api.post('/correspondence/connectors', body);
export const connectorAuthorization = (id: string) => api.get(`/correspondence/connectors/${encodeURIComponent(id)}/authorization`);
export const deleteConnector = (id: string) => request('DELETE', `/correspondence/connectors/${encodeURIComponent(id)}`);
export const authorizeConnector = (id: string) => api.post(`/correspondence/connectors/${encodeURIComponent(id)}/authorize`, {});
export const disconnectConnector = (id: string) => api.post(`/correspondence/connectors/${encodeURIComponent(id)}/disconnect`, {});
export const syncConnector = (id: string, body: Record<string, unknown> = {}) => api.post(`/correspondence/connectors/${encodeURIComponent(id)}/sync`, body);

/** Fire-and-forget. keepalive lets a batch finish after the page is gone. */
export const sendEvents = (events: unknown[], keepalive = false) =>
  request('POST', '/events', { events }, keepalive ? { keepalive: true } : {});

const itemPath = (id: string) => `/work/items/${encodeURIComponent(id)}`;
export const recordEntry = (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
  request('POST', `${itemPath(id)}/entries`, body, { headers: { 'idempotency-key': idempotencyKey } });
export const changeStage = (id: string, body: Record<string, unknown>) => api.post(`${itemPath(id)}/stage`, body);
export const handOffWork = (id: string, body: Record<string, unknown>) => api.post(`${itemPath(id)}/handoff`, body);
export const calculateCase = (id: string, step?: string | null) => api.post(`${itemPath(id)}/calculate`, step ? { step } : {});
export const applyProcedure = (id: string, key: string) => api.post(`${itemPath(id)}/procedure`, { key });
export const validateCaseExample = (id: string, body: { text: string; section?: string | null }) => api.post(`${itemPath(id)}/example`, body);
export const withdrawCaseExample = (id: string, reason: string) => api.post(`${itemPath(id)}/example/withdraw`, { reason });
export const procedureSuggestion = (id: string) => api.get(`${itemPath(id)}/suggestion`);
export const workload = (unitId: string, params: Record<string, string | undefined> = {}) => api.get<WorkloadResponse>(`/work/workload?${qs({ unit_id: unitId, ...params })}`);

export const recordPractice = () => api.get('/record/practice');
export const recordSummary = (params: Record<string, string | undefined> = {}) => api.get(`/record/summary?${qs(params)}`);
export const assignedWork = (options: { background?: boolean; signal?: AbortSignal } = {}) =>
  request<AssignedItem[]>('GET', '/record/assigned', undefined, { signal: options.signal, ...(options.background ? { headers: { 'x-vantage-background': '1' } } : {}) });
export const contributions = (params: Record<string, string | undefined> = {}) => api.get(`/record/contributions?${qs(params)}`);
export const recordTimeline = (params: Record<string, string | undefined> = {}) => api.get<TimelineResponse>(`/record/timeline?${qs(params)}`);
export const moveCandidates = () => api.get<MoveCandidatesResponse>('/record/move-candidates');
// Duty (ADR-0023): what the form records it with, for oneself or a Marine one may record it for, and the activities that read like duty.
export const dutyOptions = (forId?: string | null) => api.get<DutyOptionsResponse>(`/record/duty/options${forId ? `?for=${encodeURIComponent(forId)}` : ''}`);
export const dutyCandidates = () => api.get<DutyCandidatesResponse>('/record/duty/candidates');
/** A tab of the Duty page: one's own duty, the duty one recorded for one's Marines, or what one's units hold besides one's own. */
export type DutyTab = 'mine' | 'recorded' | 'units';
/** What narrows a tab. The server ANDs each with what the reader may read, so none of them widens it. */
export interface DutyListFilters { unit_id?: string; from?: string; to?: string; status?: DutyStatus }
/**
 * One page of a tab, newest first; `next` asks for the page after it and is null on the last. The first page also says
 * how many the tab holds with its filters, counted up to a thousand (`total_more` past that).
 */
export interface DutyPage { duties: Array<RecordRows['duties']>; next: string | null; total?: number; total_more?: boolean }
/** What the Duty page adds up from all of the reader's duty, and how many each tab holds, whatever page is open. */
export interface DutySummary {
  mine: { duties: number; hours: number; calculated_points: number; approved_points: number; pending: number; returned: number };
  tabs: { mine: number; recorded: number; units: number; units_more: boolean };
  /** The units a tab may be narrowed to: those whose shared records the reader views, and their own. */
  units: Array<{ id: string; name: string }>;
}
export const dutyList = (who: DutyTab, filters: DutyListFilters, cursor?: string | null) => api.get<DutyPage>(`/record/duty/list?${qs({ who, ...filters, cursor })}`);
export const dutySummary = () => api.get<DutySummary>('/record/duty/summary');
// Reviewing duty (ADR-0024): one decision on one duty as the reader saw it, its review history, and the duty waiting for the reader's decision.
export interface DutyReviewBody { action: DutyReviewAction; version: number; reason?: string | null; points?: number | string | null }
export const reviewDuty = (id: string, body: DutyReviewBody) => api.post<RecordRows['duties']>(`/records/duties/${encodeURIComponent(id)}/review`, body);
export const dutyReviews = (id: string) => api.get<{ reviews: DutyReviewEntry[] }>(`/records/duties/${encodeURIComponent(id)}/reviews`);
export type DutyReviewQueue = DutyReviewQueueResponse<RecordRows['duties']>;
/** The duty waiting for the reader's decision, in one unit they review it in or all of them. */
export const dutyReviewQueue = (unitId?: string | null) => api.get<DutyReviewQueue>(`/record/duty/review-queue${unitId ? `?unit_id=${encodeURIComponent(unitId)}` : ''}`);
export const recordDrafts = () => api.get('/record/drafts');
export const draftFromWork = (workItemId: string) => api.post('/record/drafts/from-work', { work_item_id: workItemId });
export const updateDraft = (id: string, body: Record<string, unknown>) => api.put(`/record/drafts/${encodeURIComponent(id)}`, body);
export const saveDraftToRecord = (id: string) => api.post(`/record/drafts/${encodeURIComponent(id)}/save`);
export const deleteDraft = (id: string) => api.del(`/record/drafts/${encodeURIComponent(id)}`);
// Every draft of the person's, wherever it is kept, and the forms they save to finish later (ADR-0030).
export const allDrafts = () => api.get<DraftsResponse>('/drafts');
export const formDraft = (id: string) => api.get<FormDraft>(`/drafts/forms/${encodeURIComponent(id)}`);
export const createFormDraft = (body: { kind: FormDraftKind; subject_id?: string | null; unit_id?: string | null; payload: Record<string, unknown> }) => api.post<FormDraft>('/drafts/forms', body);
export const updateFormDraft = (id: string, body: { payload: Record<string, unknown>; version: number }) => api.put<FormDraft>(`/drafts/forms/${encodeURIComponent(id)}`, body);
export const discardFormDraft = (id: string) => api.del(`/drafts/forms/${encodeURIComponent(id)}`);
export const career = () => api.get('/record/career');
export const saveCareerProfile = (body: Record<string, unknown>) => api.put('/record/career/profile', body);
export const createCareerStep = (body: Record<string, unknown>) => api.post('/record/career/steps', body);
export const updateCareerStep = (id: string, body: Record<string, unknown>) => api.put(`/record/career/steps/${encodeURIComponent(id)}`, body);
export const deleteCareerStep = (id: string) => api.del(`/record/career/steps/${encodeURIComponent(id)}`);

export const demoStatus = () => api.get('/demo/status');
export const demoStart = () => api.post('/demo/start').then((r) => { markSignedIn(); return r; });
export const demoPersona = (persona: 'marine' | 'leader') => api.post('/demo/persona', { persona }).then((r) => { markSignedIn(); return r; });
export const demoReset = () => api.post('/demo/reset').then((r) => { markSignedIn(); return r; });
export const handoffCandidates = (id: string) => api.get(`${itemPath(id)}/handoff-candidates`);
