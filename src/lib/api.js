/**
 * Vantage — API client.
 *
 * Replaces the IndexedDB layer. Same shape as before on purpose, so the pages
 * didn't all have to be rewritten around a new data-access idiom.
 *
 * Authentication is the HttpOnly session cookie and nothing else (finding 3).
 * v3.2 also parked the bearer token in sessionStorage, which meant the
 * credential was readable by any script on the page and the app carried two
 * session mechanisms with different lifetimes. Now the browser never stores
 * the token: the server's cookie — a true session cookie — is the credential,
 * so closing the browser on a shared duty computer ends the sign-in, and the
 * server's inactivity/absolute deadlines bound it even when the browser stays
 * open. The token returned by /api/login is kept in memory only, for the life
 * of this page, purely so in-flight code paths keep working.
 *
 * Every request carries the `x-vantage-client` header: cookie-authenticated
 * writes are refused without it (CSRF defense in depth on the server).
 */

let token = null;

/**
 * unknown → this page hasn't asked the server yet (a cookie may exist);
 * active  → a request succeeded as somebody;
 * none    → the server said 401, so stop asking until the next sign-in.
 * The tri-state matters: it lets a fresh page load try the cookie, while a
 * confirmed 401 short-circuits instead of looping through /api/me forever.
 */
let sessionState = (() => {
  // The presence cookie is set beside the HttpOnly credential at sign-in and
  // cleared at sign-out. Reading it costs nothing and lets a signed-out page
  // skip the /api/me probe entirely — no spurious 401 in the console, no
  // wasted round trip. If it's stale (session revoked elsewhere), the probe
  // simply comes back 401 once and we land in 'none' as before.
  try { return document.cookie.includes('vantage_signed_in=') ? 'unknown' : 'none'; }
  catch { return 'unknown'; }
})();

export function getToken() {
  return token;
}

export function setToken(value) {
  token = value;
  if (!value) {
    sessionState = 'none';
    try { document.cookie = 'vantage_signed_in=; Max-Age=0; path=/'; } catch { /* non-browser */ }
  }
}

/** False only after the server has actually said 401 (or after sign-out). */
export function hasSession() {
  return sessionState !== 'none';
}

export class ApiError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    /** Machine code from the server envelope, e.g. 'stale', 'csrf', 'scope'. */
    this.code = extra.code || null;
    /** Per-field messages from server validation (finding 34). */
    this.fieldErrors = extra.fieldErrors || null;
    /** On 409 stale: the winning copy, so the UI can offer a real choice. */
    this.current = extra.current;
  }
}

/** One user-grade line from a refusal: the message plus its field details. */
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
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Vantage server.', 0);
  }

  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent('vantage:signed-out'));
    throw new ApiError('Your session has expired. Sign in again.', 401);
  }
  sessionState = 'active';

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

/* ── auth ─────────────────────────────────────────────────────────── */

export const needsSetup = () => api.get('/setup');
export const health = () => api.get('/health');
export const runSetup = (payload) => api.post('/setup', payload);

export async function login(username, password) {
  const res = await api.post('/login', { username, password });
  setToken(res.token);
  return res;
}

export async function logout() {
  try { await api.post('/logout'); } catch { /* already gone */ }
  setToken(null);
}

export const me = () => api.get('/me');
export const org = () => api.get('/org');

/* ── team ─────────────────────────────────────────────────────────── */

export const team = () => api.get('/team');
export const member = async (id) => {
  const data = await api.get(`/team/${id}`);
  return { ...data, activities: (data.activities || []).map(toClient) };
};
export const addMember = (payload) => api.post('/team', payload);
export const reassign = (id, payload) => api.put(`/team/${id}/assignment`, payload);
export const myAudit = () => api.get('/audit');
export const unitAudit = (unitId) => api.get(`/audit/unit?unit_id=${encodeURIComponent(unitId)}`);
export const exportUnit = (unitId) => api.get(`/export?unit_id=${encodeURIComponent(unitId)}`);

/* ── account lifecycle (v3.3) ─────────────────────────────────────── */

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

/* ── roles ────────────────────────────────────────────────────────── */

export const roles = () => api.get('/roles');
export const createRole = (payload) => api.post('/roles', payload);
export const updateRole = (id, payload) => api.put(`/roles/${id}`, payload);
export const deleteRole = (id) => api.del(`/roles/${id}`);
export const grantRole = (userId, payload) => api.post(`/team/${userId}/roles`, payload);
export const revokeRole = (userId, roleId, unitId) =>
  api.del(`/team/${userId}/roles/${roleId}?unit_id=${encodeURIComponent(unitId)}`);

/* ── units ────────────────────────────────────────────────────────── */

export const createUnit = (payload) => api.post('/org/units', payload);
export const updateUnit = (id, payload) => api.put(`/org/units/${id}`, payload);
export const archiveUnit = (id) => api.del(`/org/units/${id}`);

/* ── readiness ────────────────────────────────────────────────────── */

export const prefs = () => api.get('/prefs');
export const savePrefs = (patch) => api.put('/prefs', patch);

export const readiness = () => api.get('/readiness');
export const saveReadiness = (payload) => api.put('/readiness', payload);
export const memberReadiness = (id) => api.get(`/readiness/${id}`);

/* ── records ──────────────────────────────────────────────────────── */

export const STORES = ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings'];

/**
 * `unit` is a reserved-ish word in SQL contexts and the column is `unit_label`,
 * but the UI has said `unit` since the first version. Translating here keeps a
 * storage detail out of every page.
 */
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
