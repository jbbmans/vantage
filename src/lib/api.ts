import { clearDrafts } from './drafts.ts';

let sessionState: 'none' | 'unknown' | 'active' = (() => {
  try { return document.cookie.includes('vantage_signed_in=') ? 'unknown' : 'none'; } catch { return 'unknown'; }
})();

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

function markSignedOut() {
  sessionState = 'none';
  clearDrafts();
  try { document.cookie = 'vantage_signed_in=; Max-Age=0; path=/'; } catch {}
}

export const hasSession = () => sessionState !== 'none';
export const markSignedIn = () => { sessionState = 'active'; window.dispatchEvent(new CustomEvent('vantage:signed-in')); };

async function request<T = any>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { ...(body instanceof Blob || body instanceof ArrayBuffer ? {} : { 'content-type': 'application/json' }), 'x-vantage-client': '1', ...(init.headers as Record<string, string> | undefined) },
      body: body === undefined ? undefined : body instanceof Blob || body instanceof ArrayBuffer ? (body as BodyInit) : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError('Cannot reach the Vantage server. Check your connection.', 0, { code: 'offline' });
  }
  if (res.status === 401) {
    if (sessionState !== 'none') { markSignedOut(); window.dispatchEvent(new CustomEvent('vantage:signed-out')); }
    const text = await res.text().catch(() => '');
    let payload: any = null; try { payload = JSON.parse(text); } catch {}
    throw new ApiError(payload?.error || 'Your session has expired. Sign in again.', 401, payload || {});
  }
  const text = await res.text();
  let payload: any = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (!res.ok) throw new ApiError(payload?.error || `Request failed (${res.status}).`, res.status, payload || {});
  if (!/^\/auth\/(setup|forgot|reset|invite|passkey)/.test(path) && path !== '/health') sessionState = 'active';
  return payload as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
};

// Auth ---------------------------------------------------------------
export const setupStatus = () => api.get('/auth/setup');
export const runSetup = (payload: unknown) => api.post('/auth/setup', payload).then((r) => { markSignedIn(); return r; });
export const register = (payload: unknown) => api.post('/auth/register', payload).then((r) => { markSignedIn(); return r; });
export const login = (username: string, password: string) => api.post('/auth/login', { username, password }).then((r) => { if (r.ok) markSignedIn(); return r; });
export const loginMfa = (challenge: string, code: string) => api.post('/auth/login/mfa', { challenge, code }).then((r) => { markSignedIn(); return r; });
export const passkeyOptions = (username?: string) => api.post('/auth/passkey/options', { username });
export const passkeyVerify = (key: string, response: unknown) => api.post('/auth/passkey/verify', { key, response }).then((r) => { markSignedIn(); return r; });
export const logout = async () => { try { await api.post('/auth/logout'); } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; } markSignedOut(); };
export const sudo = (password: string) => api.post('/auth/sudo', { password });
export const forgotPassword = (identifier: string) => api.post('/auth/forgot', { identifier });
export const resetStatus = (token: string) => api.get(`/auth/reset?token=${encodeURIComponent(token)}`);
export const resetPassword = (token: string, password: string) => api.post('/auth/reset', { token, password }).then((r) => { markSignedIn(); return r; });
export const inviteStatus = (token: string) => api.get(`/auth/invite?token=${encodeURIComponent(token)}`);
export const acceptInvite = (payload: unknown) => api.post('/auth/invite/accept', payload).then((r) => { markSignedIn(); return r; });

// Me -----------------------------------------------------------------
export const me = () => api.get('/me');
export const org = () => api.get('/me/org');
export const updateProfile = (payload: unknown) => api.put('/me/profile', payload);
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
export const notifications = (limit = 40) => api.get(`/me/notifications?limit=${limit}`);
export const markRead = (id: string) => api.put(`/me/notifications/${encodeURIComponent(id)}/read`);
export const markAllRead = () => api.post('/me/notifications/read-all');
export const myAudit = () => api.get('/me/audit');
export const digestPreview = () => api.get('/me/digest/preview');
export const digestSendNow = () => api.post('/me/digest/send-now');
export const emailVerify = (email: string) => api.post('/me/email/verify', { email });
export const emailConfirm = (token: string) => api.post('/me/email/confirm', { token });

// Records --------------------------------------------------------------
export const STORES = ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards', 'counselings'] as const;
export type Store = (typeof STORES)[number];
export const listRecords = (store: Store, params: Record<string, string | undefined> = {}) => {
  const qs = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
  return api.get<any[]>(`/records/${store}${qs ? `?${qs}` : ''}`);
};
export const getRecord = (store: Store, id: string) => api.get(`/records/${store}/${encodeURIComponent(id)}`);
export const createRecord = (store: Store, data: unknown) => api.post(`/records/${store}`, data);
export const updateRecord = (store: Store, id: string, patch: unknown) => api.put(`/records/${store}/${encodeURIComponent(id)}`, patch);
export const deleteRecord = (store: Store, id: string) => api.del(`/records/${store}/${encodeURIComponent(id)}`);
export const restoreRecord = (store: Store, id: string) => api.post(`/records/${store}/${encodeURIComponent(id)}/restore`);
export const importActivities = (rows: unknown[]) => api.post('/records/activities/import', { rows });
export const acknowledgeCounseling = (id: string) => api.post(`/records/counselings/${encodeURIComponent(id)}/acknowledge`);
export const attachments = (store: Store, id: string) => api.get(`/records/${store}/${encodeURIComponent(id)}/attachments`);
export const uploadAttachment = (store: Store, id: string, file: File) => request('POST', `/records/${store}/${encodeURIComponent(id)}/attachments`, file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-vantage-filename': encodeURIComponent(file.name) } });
export const deleteAttachment = (store: Store, id: string, attachmentId: string) => api.del(`/records/${store}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`);
export const attachmentUrl = (store: Store, id: string, attachmentId: string) => `/api/records/${store}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;

// Org ----------------------------------------------------------------
export const team = () => api.get('/org/team');
export const member = (id: string) => api.get(`/org/team/${encodeURIComponent(id)}`);
export const updateMemberProfile = (id: string, payload: unknown) => api.put(`/org/team/${encodeURIComponent(id)}/profile`, payload);
export const directory = (unitId: string, q: string) => api.get(`/org/directory?unit_id=${encodeURIComponent(unitId)}&q=${encodeURIComponent(q)}`);
export const addMember = (unitId: string, payload: unknown) => api.post(`/org/units/${encodeURIComponent(unitId)}/members`, payload);
export const updateMembership = (unitId: string, userId: string, payload: unknown) => api.put(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}`, payload);
export const removeMember = (unitId: string, userId: string) => api.del(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}`);
export const createInvite = (unitId: string, payload: unknown) => api.post(`/org/units/${encodeURIComponent(unitId)}/invites`, payload);
export const listInvites = (unitId: string) => api.get(`/org/units/${encodeURIComponent(unitId)}/invites`);
export const revokeInvite = (id: string) => api.del(`/org/invites/${encodeURIComponent(id)}`);
export const roles = () => api.get('/org/roles');
export const createRole = (payload: unknown) => api.post('/org/roles', payload);
export const updateRole = (id: string, payload: unknown) => api.put(`/org/roles/${encodeURIComponent(id)}`, payload);
export const deleteRole = (id: string) => api.del(`/org/roles/${encodeURIComponent(id)}`);
export const grantRole = (userId: string, payload: unknown) => api.post(`/org/team/${encodeURIComponent(userId)}/roles`, payload);
export const revokeRole = (userId: string, roleId: string) => api.del(`/org/team/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`);
export const createUnit = (payload: unknown) => api.post('/org/units', payload);
export const updateUnit = (id: string, payload: unknown) => api.put(`/org/units/${encodeURIComponent(id)}`, payload);
export const archiveUnit = (id: string) => api.del(`/org/units/${encodeURIComponent(id)}`);
export const transferOwnership = (id: string, userId: string) => api.post(`/org/units/${encodeURIComponent(id)}/owner`, { user_id: userId });
export const unitDashboard = (id: string, from?: string, to?: string) => api.get(`/org/units/${encodeURIComponent(id)}/dashboard${from && to ? `?from=${from}&to=${to}` : ''}`);
export const unitAudit = (id: string) => api.get(`/org/units/${encodeURIComponent(id)}/audit`);
export const unitExport = (id: string) => api.get(`/org/units/${encodeURIComponent(id)}/export`);
export const deactivateMember = (id: string) => api.post(`/org/team/${encodeURIComponent(id)}/deactivate`);
export const reactivateMember = (id: string) => api.post(`/org/team/${encodeURIComponent(id)}/reactivate`);
export const resetMemberMfa = (id: string) => api.post(`/org/team/${encodeURIComponent(id)}/reset-mfa`);
export const temporaryPassword = (id: string) => api.post(`/org/team/${encodeURIComponent(id)}/temporary-password`);
export const forceLogout = (id: string) => api.post(`/org/team/${encodeURIComponent(id)}/logout`);
export const setOperator = (id: string, grant: boolean) => api.post(`/org/team/${encodeURIComponent(id)}/operator`, { grant });

// Reports, AI, MARADMINs, search --------------------------------------
const qs = (params: Record<string, string | number | undefined | null>) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
export const report = (params: Record<string, string | number | undefined | null>) => api.get(`/reports?${qs(params)}`);
export const reportDelta = (params: Record<string, string | number | undefined | null>) => api.get(`/reports/delta?${qs(params)}`);
export const reportPdfUrl = (params: Record<string, string | number | undefined | null>) => `/api/reports/pdf?${qs(params)}`;
export const reportCsvUrl = (params: Record<string, string | number | undefined | null>) => `/api/reports/csv?${qs(params)}`;
export const aiStatus = () => api.get('/ai/status');
export const aiAssist = (workflow: string, input: unknown, model?: string) => api.post('/ai/assist', { workflow, input, model });
export const maradmins = (wait = false) => api.get(`/maradmins${wait ? '?wait=1' : ''}`);
export const maradminState = (id: string, payload: unknown) => api.put(`/maradmins/${encodeURIComponent(id)}/state`, payload);
export const search = (q: string) => api.get(`/search?q=${encodeURIComponent(q)}`);

// Operator -----------------------------------------------------------
export const adminOverview = () => api.get('/admin/overview');
export const adminRuntime = (patch: unknown) => api.put('/admin/runtime', patch);
export const adminAi = () => api.get('/admin/ai');
export const adminAiDiscover = () => api.post('/admin/ai/discover');
export const adminAiUnlock = () => api.post('/admin/ai/unlock');
export const adminSyncMaradmins = () => api.post('/admin/maradmins/sync');
export const adminEmailTest = (to?: string) => api.post('/admin/email/test', { to });
export const adminDigestRun = () => api.post('/admin/digest/run');
export const adminUsers = () => api.get('/admin/users');
export const adminUnits = () => api.get('/admin/units');
export const adminClaimUnit = (id: string, ownerId?: string) => api.post(`/admin/units/${encodeURIComponent(id)}/claim`, { owner_user_id: ownerId });
export const adminAudit = (limit = 200) => api.get(`/admin/audit?limit=${limit}`);
export const adminImport = (archive: unknown) => api.post('/admin/import', archive);
export const adminMaintenance = (enabled: boolean) => api.post('/admin/maintenance', { enabled });

export async function downloadFile(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) { markSignedOut(); window.dispatchEvent(new CustomEvent('vantage:signed-out')); throw new ApiError('Your session has expired.', 401); }
  if (!res.ok) { let msg = `Download failed (${res.status}).`; try { msg = (await res.json()).error || msg; } catch {} throw new ApiError(msg, res.status); }
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
