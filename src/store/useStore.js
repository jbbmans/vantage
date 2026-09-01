import { useSyncExternalStore, useCallback } from 'react';
import * as api from '@/lib/api';
import { trackForGrade } from '@/lib/evaluation';

const cache = new Map();
const listeners = new Set();
let identity = null;
let prefsState = {};
let prefsTimer = null;
let orgData = { ranks: [], billets: [], units: [] };
let ready = false;
let loadError = null;

const EMPTY = Object.freeze([]);
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function clearUserState() {
  identity = null;
  prefsState = {};
  pendingPrefs = {};
  orgData = { ranks: [], billets: [], units: [] };
  cache.clear();
  loadError = null;
}

export async function signIn(username, password) {
  clearUserState();
  ready = false;
  emit();
  try {
    await api.login(username, password);
    await hydrate();
    return identity;
  } catch (err) {
    ready = true;
    emit();
    throw err;
  }
}

export async function signInWithCac() {
  clearUserState();
  ready = false;
  emit();
  try {
    await api.cacPivLogin();
    await hydrate();
    return identity;
  } catch (err) {
    ready = true;
    emit();
    throw err;
  }
}

export async function signOut() {
  try {
    await api.logout();
  } catch {
    return false;
  }
  clearUserState();
  ready = true;
  emit();
  return true;
}

export async function hydrate() {

  if (!api.hasSession()) {
    clearUserState();
    ready = true;
    emit();
    return null;
  }
  try {
    loadError = null;
    const nextIdentity = await api.me();
    if (identity?.user?.id && identity.user.id !== nextIdentity?.user?.id) clearUserState();
    identity = nextIdentity;
    const [orgResult, nextPrefs] = await Promise.all([

      api.org().then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      ),
      api.prefs().catch(() => ({})),
      Promise.all(api.STORES.map((name) => reloadStore(name))),
    ]);
    if (orgResult.error) throw orgResult.error;
    orgData = orgResult.value;
    prefsState = nextPrefs;
  } catch (err) {
    if (err.status === 401) clearUserState();
    else loadError = err;
  } finally {
    ready = true;
    emit();
  }
  return identity;
}

async function reloadStore(name) {
  try {
    cache.set(name, await api.list(name));
  } catch (err) {

    loadError = err;
    if (!cache.has(name)) cache.set(name, []);
  }
}

export const useIdentity = () => useSyncExternalStore(subscribe, () => identity, () => null);

export const useEvalTrack = () =>
  useSyncExternalStore(
    subscribe,
    () => trackForGrade(identity?.user?.rank?.grade),
    () => 'jepes'
  );

export const usePrefs = () => useSyncExternalStore(subscribe, () => prefsState, () => ({}));

let pendingPrefs = {};

export function setPref(key, value) {
  prefsState = { ...prefsState, [key]: value };
  pendingPrefs = { ...pendingPrefs, [key]: value };
  emit();
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(flushPrefs, 400);
}

export function flushPrefs() {
  if (prefsTimer) {
    clearTimeout(prefsTimer);
    prefsTimer = null;
  }
  if (!Object.keys(pendingPrefs).length) return Promise.resolve();
  const patch = pendingPrefs;
  pendingPrefs = {};
  return api.savePrefs(patch).catch(() => {

    pendingPrefs = { ...patch, ...pendingPrefs };
  });
}

if (typeof window !== 'undefined') {

  window.addEventListener('pagehide', flushPrefs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPrefs();
  });
}
export const useOrg = () => useSyncExternalStore(subscribe, () => orgData, () => orgData);
export const useReady = () => useSyncExternalStore(subscribe, () => ready, () => false);
export const useLoadError = () => useSyncExternalStore(subscribe, () => loadError, () => null);

export const useCanLead = () => useSyncExternalStore(subscribe, () => Boolean(identity?.canLead), () => false);

export const PERMISSIONS = {
  VIEW_UNIT: 1 << 0,
  VIEW_RECORDS: 1 << 1,
  VIEW_MEMBER_DETAIL: 1 << 2,
  MANAGE_RECORDS: 1 << 3,
  CREATE_SHARED_WORK: 1 << 4,
  CREATE_SHARED_GOALS: 1 << 5,
  MANAGE_MEMBERS: 1 << 6,
  MANAGE_ROLES: 1 << 7,
  MANAGE_UNITS: 1 << 8,
  VIEW_AUDIT: 1 << 9,
  EXPORT_DATA: 1 << 10,
  ADMINISTRATOR: 1 << 11,
};

const bitsIn = (unitId) => {
  if (!identity || !unitId) return 0;
  return identity.permissions?.[unitId] || 0;
};

const hasBit = (bits, flag) => Boolean(bits & PERMISSIONS.ADMINISTRATOR) || Boolean(bits & flag);

export const can = (flag, unitId) => hasBit(bitsIn(unitId), flag);

export function canAnywhereForNav(flag) {
  if (!identity) return false;
  return Object.values(identity.permissions || {}).some((bits) => hasBit(bits, flag));
}
export const canAnywhere = canAnywhereForNav;

export function unitsWith(flag) {
  if (!identity) return [];

  return Object.entries(identity.permissions || {})
    .filter(([, bits]) => hasBit(bits, flag))
    .map(([unitId]) => unitId);
}

export const usePermission = (flag, unitId) =>
  useSyncExternalStore(subscribe, () => can(flag, unitId), () => false);

export const usePermissionAnywhere = (flag) =>
  useSyncExternalStore(subscribe, () => canAnywhere(flag), () => false);

export function useCollection(name) {
  const snapshot = useCallback(() => cache.get(name) || EMPTY, [name]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export const useActivities = () => useCollection('activities');
export const useProjects = () => useCollection('projects');
export const useTasks = () => useCollection('tasks');
export const useGoals = () => useCollection('goals');
export const useRecognitions = () => useCollection('recognitions');
export const useTrainings = () => useCollection('trainings');

export async function createRecord(name, data) {
  const rec = await api.create(name, data);
  await reloadStore(name);
  emit();
  return rec;
}

export async function updateRecord(name, id, patch) {
  const rec = await api.update(name, id, patch);
  await reloadStore(name);
  emit();
  return rec;
}

export async function deleteRecord(name, id) {
  await api.remove(name, id);

  await reloadStore(name);
  if (name === 'projects') await Promise.all([reloadStore('tasks'), reloadStore('activities')]);
  emit();
  return { store: name, id };
}

export async function restoreDeleted(undo) {
  if (!undo?.id) return null;
  const rec = await api.restore(undo.store, undo.id);
  await reloadStore(undo.store);
  emit();
  return rec;
}

export async function createMany(name, rows) {
  const res = await api.bulkCreate(name, rows);
  await reloadStore(name);
  emit();
  return res;
}

export async function refreshAll() {
  loadError = null;
  await Promise.all(api.STORES.map((name) => reloadStore(name)));
  emit();
}

export const reload = hydrate;

export function unitById(id) {
  return orgData.units.find((u) => u.id === id) || null;
}

export function preferredUnitId(candidateIds = []) {
  const allowed = new Set(candidateIds.filter(Boolean));
  const inScope = (id) => id && (!allowed.size || allowed.has(id));
  const primary = identity?.assignments?.find((assignment) => assignment.is_primary && inScope(assignment.unit_id));
  if (primary) return primary.unit_id;
  const owned = (identity?.ownedUnitIds || []).find(inScope);
  if (owned) return owned;
  const assignment = (identity?.assignments || []).find((item) => inScope(item.unit_id));
  if (assignment) return assignment.unit_id;
  const membership = (identity?.memberships || []).find((item) => inScope(item.unit_id));
  return membership?.unit_id || candidateIds.find(Boolean) || '';
}

export function unitPath(id) {
  const chain = [];
  let current = id;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const unit = unitById(current);
    if (!unit) break;
    chain.unshift(unit);
    current = unit.parent_id;
  }
  return chain;
}

export function unitOptions(units = orgData.units) {
  const byParent = new Map();
  for (const u of units) {
    const key = u.parent_id || '__root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(u);
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const u of (byParent.get(parent) || []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ ...u, depth });
      walk(u.id, depth + 1);
    }
  };
  walk('__root', 0);
  return out;
}

export function displayName(person, { withFirst = false } = {}) {
  if (!person) return '';
  const rank = person.rank_abbr || person.rank?.abbr || '';
  const first = withFirst && person.first_name ? `${person.first_name.charAt(0)}. ` : '';
  return `${rank} ${first}${person.last_name || ''}`.trim();
}
