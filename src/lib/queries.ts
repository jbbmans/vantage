import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api.ts';
import type { Store } from './api.ts';
import type { Prefs } from '../../shared/schemas.ts';
import { applyAccent, applyDensity, applyTheme } from './theme.ts';
import { trackForGrade, type Track } from '../../shared/evaluation.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: (count, error) => (error as api.ApiError)?.status === 0 ? count < 1 : false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

export interface Identity {
  user: { id: string; username: string; email: string | null; first_name: string; last_name: string; middle_initial: string | null; rank_id: string | null; mos: string | null; eas: string | null; is_operator: number; totp_enabled: number; must_change_password: number; last_login_at: string | null; created_at: string; passkeys: number; rank: { id: string; grade: string; abbr: string; name: string } | null };
  prefs: Prefs;
  memberships: Array<{ unit_id: string; is_primary: number; billet: string | null; joined_at: string; unit_name: string; unit_short: string | null; unit_code: string; parent_id: string | null }>;
  primaryUnitId: string | null; unitIds: string[]; readableUnitIds: string[]; ownedUnitIds: string[];
  permissions: Record<string, number>; positions: Record<string, number>;
  roles: Array<{ unit_id: string; id: string; name: string; color: string | null; position: number; permissions: number }>;
  canLead: boolean; manageableUnits: string[]; counselUnits: string[]; exportUnits: string[];
  session: { id: string; method: string; sudoUntil: string | null };
  instance: { displayName: string; organizationName: string; announcement: string; emailEnabled: boolean; attachmentsEnabled: boolean; aiEnabled: boolean; maradminsEnabled: boolean };
}

export const keys = {
  me: ['me'] as const,
  org: ['org'] as const,
  records: (store: Store, params?: Record<string, unknown>) => ['records', store, params || {}] as const,
  record: (store: Store, id: string) => ['record', store, id] as const,
  team: ['team'] as const,
  member: (id: string) => ['member', id] as const,
  roles: ['roles'] as const,
  notifications: ['notifications'] as const,
  readiness: ['readiness'] as const,
  aiStatus: ['ai-status'] as const,
  maradmins: ['maradmins'] as const,
  report: (params: Record<string, unknown>) => ['report', params] as const,
  delta: (params: Record<string, unknown>) => ['delta', params] as const,
  dashboard: (unitId: string, from?: string, to?: string) => ['dashboard', unitId, from, to] as const,
};

export function useIdentity() {
  return useQuery<Identity>({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000, enabled: api.hasSession(), retry: false });
}
export function useOrg() {
  return useQuery({ queryKey: keys.org, queryFn: api.org, staleTime: 5 * 60_000 });
}
export function useRecords(store: Store, params?: Record<string, string | undefined>, enabled = true) {
  return useQuery<any[]>({ queryKey: keys.records(store, params), queryFn: () => api.listRecords(store, params), enabled });
}
export const useActivities = () => useRecords('activities');
export const useTasks = () => useRecords('tasks');
export const useProjects = () => useRecords('projects');
export const useGoals = () => useRecords('goals');
export const useTrainings = () => useRecords('trainings');
export const useAwards = () => useRecords('awards');
export const useCounselings = () => useRecords('counselings');

export function invalidateRecords(qc: QueryClient, store: Store) {
  qc.invalidateQueries({ queryKey: ['records', store] });
  qc.invalidateQueries({ queryKey: ['record', store] });
  qc.invalidateQueries({ queryKey: ['report'] });
  qc.invalidateQueries({ queryKey: ['delta'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
  if (store === 'projects') { qc.invalidateQueries({ queryKey: ['records', 'tasks'] }); qc.invalidateQueries({ queryKey: ['records', 'activities'] }); }
}

export function useCreateRecord(store: Store) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data: unknown) => api.createRecord(store, data), onSuccess: () => invalidateRecords(qc, store) });
}
export function useUpdateRecord(store: Store) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, patch }: { id: string; patch: unknown }) => api.updateRecord(store, id, patch), onSuccess: () => invalidateRecords(qc, store) });
}
export function useDeleteRecord(store: Store) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteRecord(store, id), onSuccess: () => invalidateRecords(qc, store) });
}
export function useRestoreRecord(store: Store) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.restoreRecord(store, id), onSuccess: () => invalidateRecords(qc, store) });
}

export function usePrefs(): Prefs {
  const { data } = useIdentity();
  return data?.prefs || {};
}

export function useSavePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Prefs>) => api.savePrefs(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.me });
      const previous = qc.getQueryData<Identity>(keys.me);
      if (previous) qc.setQueryData<Identity>(keys.me, { ...previous, prefs: { ...previous.prefs, ...patch } });
      if (patch.theme) applyTheme(patch.theme);
      if (patch.accent) applyAccent(patch.accent);
      if (patch.density) applyDensity(patch.density);
      return { previous };
    },
    onError: (_e, _p, ctx) => { if (ctx?.previous) qc.setQueryData(keys.me, ctx.previous); },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useTrack(): Track {
  const { data } = useIdentity();
  return trackForGrade(data?.user.rank?.grade);
}

export const useReadiness = () => useQuery({ queryKey: keys.readiness, queryFn: api.readiness, staleTime: 60_000 });
export const useAiStatus = () => useQuery({ queryKey: keys.aiStatus, queryFn: api.aiStatus, staleTime: 5 * 60_000 });
export const useNotifications = (enabled = true) => useQuery({ queryKey: keys.notifications, queryFn: () => api.notifications(40), refetchInterval: 60_000, enabled });
export const useTeam = (enabled = true) => useQuery({ queryKey: keys.team, queryFn: api.team, enabled });
export const useRoles = (enabled = true) => useQuery({ queryKey: keys.roles, queryFn: api.roles, enabled });

export function can(identity: Identity | undefined, flag: number, unitId?: string | null): boolean {
  if (!identity || !unitId) return false;
  const bits = identity.permissions[unitId] || 0;
  return Boolean(bits & (1 << 12)) || Boolean(bits & flag);
}
export const canAnywhere = (identity: Identity | undefined, flag: number) => Boolean(identity && Object.values(identity.permissions).some((bits) => Boolean(bits & (1 << 12)) || Boolean(bits & flag)));
export const unitsWith = (identity: Identity | undefined, flag: number) => identity ? Object.entries(identity.permissions).filter(([, bits]) => Boolean(bits & (1 << 12)) || Boolean(bits & flag)).map(([id]) => id) : [];

export function unitName(identity: Identity | undefined, unitId?: string | null, org?: { units?: Array<{ id: string; name: string; short_name: string | null }> }) {
  if (!unitId) return '';
  const m = identity?.memberships.find((x) => x.unit_id === unitId);
  if (m) return m.unit_short || m.unit_name;
  const u = org?.units?.find((x) => x.id === unitId);
  return u ? u.short_name || u.name : unitId;
}

export async function signOutEverywhere() {
  try { await api.logout(); } catch {}
  queryClient.clear();
  window.dispatchEvent(new CustomEvent('vantage:signed-out'));
}
