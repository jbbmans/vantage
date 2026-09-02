import { clearSensitiveDrafts } from './drafts';

let sessionState = (() => {

  try { return document.cookie.includes('vantage_signed_in=') ? 'unknown' : 'none'; }
  catch { return 'unknown'; }
})();

function markSignedOut() {
  sessionState = 'none';
  clearSensitiveDrafts();
  try { document.cookie = 'vantage_signed_in=; Max-Age=0; path=/'; } catch {}
}

if (sessionState === 'none') clearSensitiveDrafts();

export function hasSession() {
  return sessionState !== 'none';
}

export class ApiError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;

    this.code = extra.code || null;

    this.fieldErrors = extra.fieldErrors || null;

    this.current = extra.current;
  }
}

export function errorText(err) {
  const fields = err?.fieldErrors ? Object.values(err.fieldErrors).join(' ') : '';
  return [err?.message, fields].filter(Boolean).join(' ') || 'Request failed.';
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-vantage-client': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Vantage server.', 0);
  }

  if (res.status === 401) {
    markSignedOut();
    window.dispatchEvent(new CustomEvent('vantage:signed-out'));
    throw new ApiError('Your session has expired. Sign in again.', 401);
  }

  if (!new Set(['/setup', '/health', '/config', '/register']).has(path)) sessionState = 'active';

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!res.ok) throw new ApiError(payload?.error || `Request failed (${res.status}).`, res.status, payload || {});
  return payload;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p),
};

export const needsSetup = () => api.get('/setup');
export const health = () => api.get('/health');
export const configuration = () => api.get('/config');
export const adminConfiguration = () => api.get('/admin/config');
export const updateConfiguration = (patch) => api.put('/admin/config', patch);
export const runSetup = (payload) => api.post('/setup', payload);
export const registerAccount = (payload) => api.post('/register', payload);
export const cacPivLogin = () => api.post('/auth/cac-piv');

export async function login(username, password) {
  const res = await api.post('/login', { username, password });
  sessionState = 'active';
  return res;
}

export async function logout() {
  try {
    await api.post('/logout');
  } catch (err) {

    if (err?.status !== 401) throw err;
  }
  markSignedOut();
}

export const me = () => api.get('/me');
export const org = () => api.get('/org');

export const team = () => api.get('/team');
export const searchDirectory = (unitId, query) =>
  api.get(`/directory?unit_id=${encodeURIComponent(unitId)}&q=${encodeURIComponent(query)}`);
export const enrollExistingMember = (unitId, payload) =>
  api.post(`/org/units/${encodeURIComponent(unitId)}/members`, payload);
export const member = async (id) => {
  const data = await api.get(`/team/${id}`);
  return { ...data, activities: (data.activities || []).map(toClient) };
};
export const addMember = (payload) => api.post('/team', payload);
export const removeUnitMember = (unitId, userId) =>
  api.del(`/org/units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(userId)}`);
export const reassign = (id, payload) => api.put(`/team/${id}/assignment`, payload);
export const updateMemberProfile = (id, payload) => api.put(`/team/${id}/profile`, payload);
export const manageMember = (id, payload) => api.put(`/team/${id}/manage`, payload);
export const myAudit = () => api.get('/audit');
export const unitAudit = (unitId) => api.get(`/audit/unit?unit_id=${encodeURIComponent(unitId)}`);
export const exportUnit = (unitId) => api.get(`/export?unit_id=${encodeURIComponent(unitId)}`);

export const changePassword = (current_password, new_password) =>
  api.post('/me/password', { current_password, new_password });
export const mySessions = () => api.get('/me/sessions');
export const revokeOtherSessions = () => api.post('/me/sessions/revoke-others');
export const revokeSession = (sid) => api.del(`/me/sessions/${encodeURIComponent(sid)}`);
export const deactivateMember = (id) => api.post(`/team/${id}/deactivate`);
export const reactivateMember = (id) => api.post(`/team/${id}/reactivate`);
export const resetMemberPassword = (id, password) => api.post(`/team/${id}/password`, { password });
export const forceLogoutMember = (id) => api.post(`/team/${id}/logout`);
export const accessReview = (id) => api.get(`/team/${id}/access`);
export const adminDb = () => api.get('/admin/db');
export const adminExperience = (days = 30) => api.get(`/admin/experience?days=${encodeURIComponent(days)}`);
export const adminOverview = () => api.get('/admin/overview');
export const syncMaradmins = () => api.post('/admin/maradmins/sync');
export const adminIntegrations = () => api.get('/admin/integrations');
export const createIntegration = (payload) => api.post('/admin/integrations', payload);
export const revokeIntegration = (id) => api.del(`/admin/integrations/${encodeURIComponent(id)}`);
export const securityIncidents = () => api.get('/security-incidents');
export const submitSecurityIncident = (payload) => api.post('/security-incidents', payload);
export const followUpSecurityIncident = (id, message) =>
  api.post(`/security-incidents/${encodeURIComponent(id)}/follow-up`, { message });
export const adminSecurityIncidents = () => api.get('/admin/security-incidents');
export const updateSecurityIncident = (id, payload) =>
  api.put(`/admin/security-incidents/${encodeURIComponent(id)}`, payload);

export const notifications = (limit = 40) => api.get(`/notifications?limit=${encodeURIComponent(limit)}`);
export const markNotificationRead = (id) => api.put(`/notifications/${encodeURIComponent(id)}/read`);
export const markAllNotificationsRead = () => api.post('/notifications/read-all');

export const rankRequests = () => api.get('/rank-requests');
export const requestRankChange = (payload) => api.post('/rank-requests', payload);
export const reviewRankChange = (id, payload) => api.put(`/rank-requests/${encodeURIComponent(id)}`, payload);
export const cancelRankChange = (id) => api.post(`/rank-requests/${encodeURIComponent(id)}/cancel`);

export const maradmins = (wait = false) => api.get(`/maradmins${wait ? '?wait=1' : ''}`);
export const updateMaradminState = (id, payload) => api.put(`/maradmins/${encodeURIComponent(id)}/state`, payload);

export const trackExperience = (event) => api.post('/experience', { event }).catch(() => null);

export const roles = () => api.get('/roles');
export const createRole = (payload) => api.post('/roles', payload);
export const updateRole = (id, payload) => api.put(`/roles/${id}`, payload);
export const deleteRole = (id) => api.del(`/roles/${id}`);
export const grantRole = (userId, payload) => api.post(`/team/${userId}/roles`, payload);
export const revokeRole = (userId, roleId, unitId) =>
  api.del(`/team/${userId}/roles/${roleId}?unit_id=${encodeURIComponent(unitId)}`);

export const createUnit = (payload) => api.post('/org/units', payload);
export const updateUnit = (id, payload) => api.put(`/org/units/${id}`, payload);
export const archiveUnit = (id) => api.del(`/org/units/${id}`);
export const transferUnitOwnership = (id, userId) => api.post(`/org/units/${id}/owner`, { user_id: userId });

export const prefs = () => api.get('/prefs');
export const savePrefs = (patch) => api.put('/prefs', patch);

export const readiness = () => api.get('/readiness');
export const saveReadiness = (payload) => api.put('/readiness', payload);
export const memberReadiness = (id) => api.get(`/readiness/${id}`);

export const STORES = ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings'];

const toClient = (row) => {
  if (!row || typeof row !== 'object') return row;
  const { unit_label, ...rest } = row;
  return unit_label === undefined ? row : { ...rest, unit: unit_label };
};

const toServer = (data) => {
  if (!data || typeof data !== 'object') return data;
  const { unit, ...rest } = data;
  return unit === undefined ? data : { ...rest, unit_label: unit };
};

export const list = async (store) => (await api.get(`/${store}`)).map(toClient);
export const create = async (store, data) => toClient(await api.post(`/${store}`, toServer(data)));
export const update = async (store, id, patch) => toClient(await api.put(`/${store}/${id}`, toServer(patch)));
export const remove = (store, id) => api.del(`/${store}/${id}`);
export const restore = async (store, id) => toClient(await api.post(`/${store}/${id}/restore`));
export const bulkCreate = (store, rows) => api.post(`/${store}/bulk`, { rows: rows.map(toServer) });

export const activityAttachments = (activityId) =>
  api.get(`/activities/${encodeURIComponent(activityId)}/attachments`);

export async function uploadActivityAttachment(activityId, file) {
  let res;
  try {
    res = await fetch(`/api/activities/${encodeURIComponent(activityId)}/attachments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-vantage-client': '1',
        'x-vantage-filename': encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch {
    throw new ApiError('Cannot reach the Vantage server.', 0);
  }
  if (res.status === 401) {
    markSignedOut();
    window.dispatchEvent(new CustomEvent('vantage:signed-out'));
    throw new ApiError('Your session has expired. Sign in again.', 401);
  }
  sessionState = 'active';
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new ApiError(payload?.error || `Upload failed (${res.status}).`, res.status, payload || {});
  return payload;
}

export const deleteActivityAttachment = (activityId, attachmentId) =>
  api.del(`/activities/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(attachmentId)}`);

export const activityAttachmentUrl = (activityId, attachmentId) =>
  `/api/activities/${encodeURIComponent(activityId)}/attachments/${encodeURIComponent(attachmentId)}`;
