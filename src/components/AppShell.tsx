import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { installTelemetry, track } from '@/lib/telemetry';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Bell, Building2, Check, ChevronDown, ChevronsLeft, ChevronsRight, ChevronsUpDown, CloudOff, FlaskConical, KeyRound, Keyboard, LifeBuoy, LogOut, Menu as MenuIcon, Moon,
  Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Sun, Users, WifiOff, X,
} from 'lucide-react';
import { FOOTER, GROUPS, HOME, groupFor, pageFor, type Count, type NavGroup, type NavPage, type Requirement } from '@/config/nav';
import { teamSections } from '@/lib/teamAccess';
import { cn, initials, timeAgo } from '@/lib/utils';
import { Tooltip, Kbd } from '@/components/ui/primitives';
import Logo, { Mark } from '@/components/Logo';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import * as Popover from '@radix-ui/react-popover';
import QuickLog from '@/components/QuickLog';
import OutboxDialog from '@/components/OutboxDialog';
import CommandPalette, { type PaletteAction } from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import { ActivityBar } from '@/components/ui/motion';
import SudoDialog, { type SudoRequest } from '@/components/SudoDialog';
import IdleGuard from '@/components/IdleGuard';
import ErrorBoundary from '@/components/ErrorBoundary';
import TabBar from '@/components/TabBar';
import { useIdentity, useNotifications, useSavePrefs, signOutEverywhere, keys, invalidateDomains, useTasks, useThreads, useRecordDrafts } from '@/lib/queries';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { flushOutbox, onOutboxChange, outbox } from '@/lib/outbox';
import { resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';
import WhatsNewDialog, { useWhatsNew } from '@/components/WhatsNewDialog';
import { useBuildWatch } from '@/lib/build';
import { useView, roleLine, viewLabel } from '@/lib/view';

/** What the header says about where you are: the group and the page, or a page and what it is for. */
// A page about one thing (a case, an entry) is named for what it is, under its group, not "Vantage".
const DETAIL_PAGES: Array<[RegExp, string]> = [[/^\/work\/items\/[^/]+/, 'Case'], [/^\/records\/[^/]+\/[^/]+/, 'Item'], [/^\/records\/[^/]+/, 'Entry'], [/^\/support\/[^/]+/, 'Request']];

function placeOf(pathname: string): { title: string; detail: string; group?: string } {
  const page = pageFor(pathname);
  const group = groupFor(pathname);
  const detail = DETAIL_PAGES.find(([re]) => re.test(pathname));
  if (detail) return { title: detail[1], detail: '', group: group?.label };
  if (page && group && group.pages.length > 1) return { title: page.label, detail: page.hint, group: group.label };
  if (page) return { title: page.label, detail: page.hint };
  if (group) return { title: group.label, detail: group.hint };
  return { title: 'Vantage', detail: '' };
}

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true); const down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

function useOutboxCount(userId: string | undefined) {
  const [count, setCount] = useState(0);
  useEffect(() => { if (!userId) { setCount(0); return; } const refresh = () => outbox.count(userId).then(setCount); refresh(); return onOutboxChange(refresh); }, [userId]);
  return count;
}

function ViewSwitcher({ mobile }: { mobile: boolean }) {
  const { data: identity } = useIdentity();
  const { view, views, setView } = useView(identity);
  const [open, setOpen] = useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLUListElement>(null);
  const step = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const navigate = useNavigate();
  useEffect(() => {
    const show = () => { if (trigger.current?.offsetParent) setOpen(true); };
    window.addEventListener('vantage:open-views', show);
    return () => window.removeEventListener('vantage:open-views', show);
  }, []);
  const childCount = (id: string) => views.find((v) => v.id === id)?.teams || 0;
  const parent = view?.parent_id ? views.find((v) => v.id === view.parent_id) : null;
  const caption = !view ? identity?.instance.organizationName || 'Workspace' : childCount(view.id) ? `Command · ${childCount(view.id)} ${childCount(view.id) === 1 ? 'team' : 'teams'}` : parent ? viewLabel(parent) : identity?.instance.organizationName || 'Workspace';
  const badge = (viewLabel(view) || identity?.instance.organizationName || 'V').replace(/^the\s+/i, '').slice(0, 3).toUpperCase();
  if (!views.length) {
    return (
      <div className="mx-3 mb-2 mt-1 rounded-[14px] bg-white/[.04] p-1 ring-1 ring-white/[.07]">
        <button type="button" onClick={() => navigate('/settings')} className="flex w-full items-center gap-2.5 rounded-[10px] bg-white/[.05] px-2.5 py-2 text-left hover:bg-white/[.08]">
          <span className="min-w-0 flex-1"><span className="block truncate text-[11px] leading-tight text-white/55">{identity?.instance.organizationName || 'Workspace'}</span><span className="block truncate text-sm font-medium leading-tight text-white">No unit yet</span></span>
        </button>
      </div>
    );
  }
  return (
    <div className="mx-3 mb-2 mt-1 rounded-[14px] bg-white/[.04] p-1 ring-1 ring-white/[.07]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button ref={trigger} type="button" aria-label={`Viewing ${viewLabel(view)}. Switch view`} aria-keyshortcuts="v" data-testid="view-switcher"
            className="group flex w-full items-center gap-2.5 rounded-[10px] bg-white/[.05] px-2.5 py-2 text-left shadow-[inset_0_1px_0_rgb(255_255_255/.06)] transition-colors hover:bg-white/[.08]">
            <span key={view?.id} className="view-badge flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rail-active [background-image:linear-gradient(to_bottom,rgb(255_255_255/.14),rgb(255_255_255/0))] text-2xs font-semibold tracking-wide text-white ring-1 ring-white/10">{badge}</span>
            <span key={`${view?.id}-label`} className="view-label min-w-0 flex-1">
              <span className="block truncate text-[11px] leading-tight text-white/55">{caption}</span>
              <span className="block truncate text-sm font-medium leading-tight text-white">{viewLabel(view)}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-white/40 transition-transform duration-300 group-hover:scale-110" aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side={mobile ? 'bottom' : 'right'} align="start" sideOffset={mobile ? 6 : 14} collisionPadding={12} onOpenAutoFocus={(e) => { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); }}
            className="z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-1.5 shadow-modal animate-scale-in focus:outline-none">
            <p className="px-2.5 pb-1.5 pt-1 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-3">Views</p>
            <ul ref={list} onKeyDown={step} className="stagger max-h-[60vh] space-y-0.5 overflow-y-auto p-0.5" role="listbox" aria-label="Views">
              {views.map((v, i) => {
                const kids = childCount(v.id);
                const selected = v.id === view?.id;
                return (
                  <li key={v.id} style={{ '--i': i } as React.CSSProperties}>
                    <button type="button" role="option" aria-selected={selected} onClick={() => { setView(v.id); setOpen(false); track('view.switched', { depth: Math.min(v.depth, 3), whole: kids > 0 }); }}
                      className={cn('flex w-full items-center gap-2.5 rounded-lg py-2 pr-2.5 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', selected && 'bg-accent-soft')}
                      style={{ paddingLeft: `${10 + v.depth * 18}px` }}>
                      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', kids ? 'bg-deep text-white' : 'bg-surface-3 text-ink-2')}>
                        {kids ? <Building2 className="h-3.5 w-3.5" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{v.short_name || v.name}</span>
                        <span className="block truncate text-2xs text-ink-3">{kids ? `Whole command · ${kids} ${kids === 1 ? 'team' : 'teams'}` : v.member ? 'Your team' : 'Team'}{v.level === 'full' ? ' · leading' : ''}</span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export const OutboxContext = React.createContext<{ pending: number; flush: () => Promise<void> }>({ pending: 0, flush: async () => {} });

function NotificationBell({ onNavigate }: { onNavigate: (to: string) => void }) {
  const { data, refetch } = useNotifications();
  const qc = useQueryClient();
  const unread = data?.unread || 0;
  const rows: Array<{ id: string; kind: string; title: string; message: string | null; action_url: string | null; read_at: string | null; created_at: string }> = data?.rows || [];
  const open = async (n: typeof rows[number]) => {
    if (!n.read_at) { await api.markRead(n.id).catch(() => undefined); qc.invalidateQueries({ queryKey: keys.notifications }); }
    if (n.action_url && n.action_url.startsWith('/') && !n.action_url.startsWith('//')) onNavigate(n.action_url);
  };
  return (
    <Popover.Root onOpenChange={(o) => { if (o) refetch(); }}>
      <Popover.Trigger asChild>
        <button type="button" className="relative flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell className="h-[18px] w-[18px]" strokeWidth={1.7} />
          {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink ring-2 ring-surface">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={10} className="z-50 w-[min(92vw,400px)] overflow-hidden rounded-2xl bg-surface shadow-pop animate-scale-in">
          <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
            <p className="text-md font-semibold text-ink">Notifications</p>
            {unread > 0 && <button type="button" onClick={async () => { await api.markAllRead(); qc.invalidateQueries({ queryKey: keys.notifications }); }} className="text-xs font-medium text-accent hover:underline">Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto px-1.5 pb-1.5">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink-3"><Bell className="h-4 w-4" /></span>
                <p className="text-sm font-medium text-ink">You are caught up</p>
                <p className="mt-0.5 text-xs text-ink-3">Handoffs, mentions and resolved work land here.</p>
              </div>
            ) : rows.map((n) => (
              <button key={n.id} type="button" onClick={() => open(n)} className={cn('flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2', !n.read_at && 'bg-accent-soft/50')}>
                <span className={cn('mt-1.5 badge-dot', n.read_at ? 'bg-line-strong' : 'bg-accent')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{n.title}</span>
                  {n.message && <span className="mt-0.5 block text-xs leading-snug text-ink-2">{n.message}</span>}
                  <span className="mt-1 block text-2xs text-ink-3">{timeAgo(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function surfaceOf(pathname: string, search: string): string {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (under('/work/correspondence')) return 'correspondence';
  if (under('/work/tasks') || under('/work/projects')) return 'tasks';
  if (under('/work')) return 'queue';
  if (under('/reports/analysis')) return 'reports';
  if (under('/reports')) return 'studio';
  if (under('/career/readiness')) return 'readiness';
  if (under('/reference')) { const tab = new URLSearchParams(search).get('tab'); return tab === 'diagnose' || !tab ? 'diagnose' : 'reference'; }
  const map: Record<string, string> = {
    '': 'dashboard', records: 'records', record: 'records', goals: 'goals', career: 'career',
    maradmins: 'maradmins', team: 'team', settings: 'settings', operator: 'operator', console: 'operator', admin: 'operator', help: 'help', support: 'help',
  };
  return map[pathname.split('/')[1] || ''] || 'dashboard';
}

/** The figures beside a group's pages, fetched only while you are in that group (its pages fetch them anyway). */
function useCounts(group: string | undefined): Record<Count, number> {
  const tasks = useTasks(group === 'work');
  const threads = useThreads({ state: 'awaiting_reply' }, group === 'work');
  const drafts = useRecordDrafts(group === 'record');
  return {
    tasks: (tasks.data || []).filter((t: { status: string }) => t.status !== 'completed').length,
    mail: threads.data?.length ?? 0,
    drafts: (drafts.data || []).filter((d: { activity_id: string | null }) => !d.activity_id).length,
  };
}

export default function AppShell() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const savePrefs = useSavePrefs();
  const location = useLocation();

  useEffect(() => { installTelemetry(); track('session.started', { returning: document.referrer.includes(window.location.host) }); }, []);
  useEffect(() => { track('surface.viewed', { surface: surfaceOf(location.pathname, location.search) }); }, [location.pathname, location.search]);
  const navigate = useNavigate();
  const online = useOnline();
  const userId = identity?.user.id;
  const pending = useOutboxCount(userId);
  const [queueOpen, setQueueOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('vantage.rail') === 'collapsed'; } catch { return false; } });
  const [quickLog, setQuickLog] = useState(false);
  const [quickLogSeed, setQuickLogSeed] = useState('');
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [whatsNew, setWhatsNew] = useState(false);
  const news = useWhatsNew(identity?.user?.created_at);
  const openWhatsNew = () => { setWhatsNew(true); news.markSeen(); };
  const [sudoOpen, setSudoOpen] = useState<null | SudoRequest>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(identity?.prefs.theme || storedTheme()));
  const updateReady = useBuildWatch();

  useEffect(() => { setTheme(resolveTheme(identity?.prefs.theme || storedTheme())); }, [identity?.prefs.theme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll reset on path change only
  useEffect(() => { setDrawer(false); if (!location.hash) window.scrollTo({ top: 0 }); }, [location.pathname]);
  const place = placeOf(location.pathname);
  useEffect(() => { document.title = `${place.title} · Vantage`; }, [place.title]);

  const flush = useCallback(async () => {
    if (!userId) return;
    const result = await flushOutbox((payload) => api.createRecord('activities', payload), userId);
    if (result.sent) {
      invalidateDomains(qc, 'activity');
      toast.success(`${result.sent} queued ${result.sent === 1 ? 'entry' : 'entries'} synced.`);
    }
  }, [qc, toast, userId]);
  useEffect(() => { if (online) flush(); }, [online, flush]);

  const openQuickLog = useCallback((seed = '') => { setQuickLogSeed(seed); setQuickLog(true); }, []);
  useEffect(() => {
    const h = (e: Event) => openQuickLog((e as CustomEvent<string>).detail || '');
    window.addEventListener('vantage:open-quick-log', h);
    const sudoHandler = (e: Event) => setSudoOpen((e as CustomEvent<SudoRequest>).detail);
    window.addEventListener('vantage:sudo-required', sudoHandler);
    return () => { window.removeEventListener('vantage:open-quick-log', h); window.removeEventListener('vantage:sudo-required', sudoHandler); };
  }, [openQuickLog]);

  const demo = identity?.demo || null;
  const idleSignOut = useCallback(() => { api.logout().catch(() => {}).finally(() => window.dispatchEvent(new CustomEvent('vantage:signed-out'))); }, []);
  // What this person may open, and so what the sidebar, the palette and the shortcuts offer.
  const { view } = useView(identity);
  const teams = useMemo(() => teamSections(identity, view), [identity, view]);
  const allowed = useCallback((when?: Requirement) => {
    if (!when) return true;
    if (when.notDemo && identity?.demo) return false;
    if (when.demo && !identity?.demo) return false;
    if (when.unit && !identity?.views?.length) return false;
    if (when.orgRole && !identity?.orgs?.some((o) => o.status === 'active' && o.permissions.includes('org.view'))) return false;
    if (when.staff && !identity?.platform?.roles.length) return false;
    if (when.maradmins && !identity?.instance.maradminsEnabled) return false;
    if (when.team && !teams.has(when.team)) return false;
    return true;
  }, [identity, teams]);
  const groups = useMemo(() => GROUPS.filter((g) => allowed(g.when)).map((g) => ({ ...g, pages: g.pages.filter((p) => allowed(p.when)) })).filter((g) => g.pages.length), [allowed]);
  const footer = useMemo(() => FOOTER.filter((p) => allowed(p.when)), [allowed]);
  const activeGroup = groupFor(location.pathname);
  /** Every page offered, titled with its group where the label alone is ambiguous ("Overview"). */
  const visibleNav = useMemo(() => [
    HOME,
    ...groups.flatMap((g) => g.pages.map((p) => ({ ...p, label: g.pages.length > 1 && !p.key ? `${g.label}: ${p.label}` : p.label }))),
    ...footer,
  ], [groups, footer]);
  const goKeys = useMemo(() => [
    ...visibleNav.filter((p) => p.key).map((p) => ({ key: p.key!, to: p.to })),
    ...groups.map((g) => ({ key: g.key, to: g.pages[0].to })),
  ], [visibleNav, groups]);
  const counts = useCounts(activeGroup?.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (event.target as HTMLElement)?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette((v) => !v); return; }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'n') { event.preventDefault(); openQuickLog(''); }
      else if (event.key === '/') { event.preventDefault(); setPalette(true); }
      else if (event.key === '?') { event.preventDefault(); setShortcuts((v) => !v); }
      else if (event.key === '[') { event.preventDefault(); toggleRail(); }
      else if (event.key === 'v' && identity?.views && identity.views.length > 1) {
        event.preventDefault();
        if (!window.matchMedia('(min-width: 1024px)').matches) setDrawer(true);
        else if (collapsed) toggleRail();
        window.setTimeout(() => window.dispatchEvent(new Event('vantage:open-views')), 80);
      }
      else if (event.key === 'g') {
        const second = (next: KeyboardEvent) => { const hit = goKeys.find((i) => i.key === next.key); if (hit) { next.preventDefault(); navigate(hit.to); } window.removeEventListener('keydown', second, true); };
        window.addEventListener('keydown', second, true);
        window.setTimeout(() => window.removeEventListener('keydown', second, true), 1200);
      }
    };
    const openPalette = () => setPalette(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('vantage:open-palette', openPalette);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('vantage:open-palette', openPalette); };
  }, [navigate, openQuickLog, goKeys, identity?.views, collapsed]);

  const switchPersona = async (persona: 'marine' | 'leader') => {
    try { await api.demoPersona(persona); qc.clear(); navigate('/'); qc.invalidateQueries(); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const startOver = async () => {
    try { await api.demoReset(); qc.clear(); navigate('/'); qc.invalidateQueries(); toast.success('A fresh synthetic workspace is ready.'); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); savePrefs.mutate({ theme: next }); };
  // What ⌘K can do besides go somewhere: the things people otherwise hunt through menus for.
  const paletteActions: PaletteAction[] = [
    { id: 'theme', title: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', keywords: 'theme dark light mode appearance', run: toggleTheme },
    { id: 'shortcuts', title: 'Keyboard shortcuts', subtitle: 'Press ? anywhere', keywords: 'keys hotkeys help', run: () => setShortcuts(true) },
    { id: 'whats-new', title: 'What’s new in Vantage', subtitle: `v${VERSION}`, keywords: 'changes changelog release notes updates version', run: openWhatsNew },
    { id: 'import-activities', title: 'Import activities from a CSV', keywords: 'upload spreadsheet csv entries', run: () => navigate('/record/activities?import=1') },
    { id: 'export-pdf', title: 'Download my record as a PDF', subtitle: 'The last 12 months, ready for a reporting senior', keywords: 'export pdf report jepes fitrep print', run: () => { api.downloadFile(api.reportPdfUrl({ period: 'last12', limit: 12 }), 'vantage-report.pdf').then((name) => toast.success(`Downloaded ${name}.`)).catch((e) => toast.error(api.errorText(e))); } },
  ];
  function toggleRail() { setCollapsed((c) => { const n = !c; try { localStorage.setItem('vantage.rail', n ? 'collapsed' : 'open'); } catch {} return n; }); }
  const user = identity?.user;
  const who = [user?.rank?.abbr, user?.first_name, user?.last_name].filter(Boolean).join(' ');

  const accountMenu = (trigger: React.ReactNode) => (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent>
        <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2.5 pb-2.5 pt-1.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-rail-active text-xs font-semibold text-white">{initials(user?.first_name, user?.last_name)}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">{who}</span>
            <span className="block truncate text-xs text-ink-3">{view ? `${roleLine(identity, view)} · ${viewLabel(view)}` : 'No unit yet'}</span>
          </span>
        </div>
        <MenuItem icon={Settings2} onSelect={() => navigate('/settings')}>Settings</MenuItem>
        {!demo && identity?.orgs?.some((o) => o.status === 'active' && o.permissions.includes('org.view')) ? <MenuItem icon={ShieldCheck} onSelect={() => navigate('/console')}>Owner console</MenuItem> : null}
        {!demo && identity?.platform?.roles.length ? <MenuItem icon={KeyRound} onSelect={() => navigate('/admin')}>Vantage admin</MenuItem> : null}
        <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? Sun : Moon}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</MenuItem>
        <MenuItem icon={Keyboard} onSelect={() => setShortcuts(true)}>Keyboard shortcuts</MenuItem>
        <MenuItem icon={Sparkles} onSelect={openWhatsNew}>What’s new{news.unseen && <><span className="sr-only"> (new)</span><span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /></>}</MenuItem>
        {!demo && <MenuItem icon={LifeBuoy} onSelect={() => navigate('/support')}>Ask for help</MenuItem>}
        <MenuSeparator />
        {demo
          ? <MenuItem icon={RefreshCw} onSelect={() => startOver()}>Start the demo over</MenuItem>
          : <MenuItem danger icon={LogOut} onSelect={() => signOutEverywhere()}>Sign out</MenuItem>}
      </MenuContent>
    </Menu>
  );

  // Which groups are open: the one you are in, and any you opened yourself. Your choices are remembered.
  const [opened, setOpened] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('vantage.nav') || '{}'); } catch { return {}; } });
  const setGroupOpen = (id: string, open: boolean) => setOpened((current) => {
    const next = { ...current, [id]: open };
    try { localStorage.setItem('vantage.nav', JSON.stringify(next)); } catch {}
    return next;
  });
  const isOpen = (g: NavGroup) => opened[g.id] ?? g.id === activeGroup?.id;

  const badge = (count?: Count) => {
    const n = count ? counts[count] : 0;
    return n ? <span className="ml-auto rounded-full bg-white/10 px-1.5 py-px font-mono text-[10px] text-white/80">{n}</span> : null;
  };
  const hint = (page: NavPage | NavGroup, wide: boolean, mobile: boolean) => (wide && !mobile && page.key
    ? <span className="ml-auto hidden font-mono text-[10px] text-white/35 group-hover:inline" aria-hidden>G {page.key.toUpperCase()}</span> : null);
  const isCurrent = (page: NavPage) => (page.end || page.to === '/' ? location.pathname === page.to : location.pathname === page.to || location.pathname.startsWith(`${page.to}/`));
  const topItem = (page: NavPage, wide: boolean, mobile: boolean) => (
    <Tooltip key={page.to} content={!wide ? page.label : null} side="right">
      <NavLink to={page.to} end={page.end} className={cn('nav-item group', !wide && 'justify-center px-0')} aria-current={isCurrent(page) ? 'page' : undefined}>
        <page.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />
        {wide && <span className="truncate">{page.label}</span>}
        {hint(page, wide, mobile)}
      </NavLink>
    </Tooltip>
  );

  const navList = (mobile: boolean) => {
    const wide = !collapsed || mobile;
    return (
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-2" aria-label="Primary">
        <div className="space-y-0.5">
          {topItem(HOME, wide, mobile)}
          {groups.map((g) => {
            const here = g.id === activeGroup?.id;
            // A narrow rail has room for the group alone; its pages are the strip at the top of the page.
            if (!wide) {
              return (
                <Tooltip key={g.id} content={g.label} side="right">
                  <NavLink to={g.pages[0].to} className="nav-item justify-center px-0" aria-current={here ? 'page' : undefined} aria-label={g.label}>
                    <g.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />
                  </NavLink>
                </Tooltip>
              );
            }
            const open = isOpen(g);
            const single = g.pages.length === 1;
            return (
              <div key={g.id} className="pt-0.5">
                <div className={cn('nav-item group pr-1', here && 'text-white')}>
                  <g.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />
                  <NavLink to={g.pages[0].to} onClick={() => setGroupOpen(g.id, true)} className="min-w-0 flex-1 truncate after:absolute after:inset-0 after:content-['']" aria-current={single && isCurrent(g.pages[0]) ? 'page' : undefined}>{g.label}</NavLink>
                  {hint(g, wide, mobile)}
                  {!single && (
                    <button type="button" onClick={() => setGroupOpen(g.id, !open)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the ${g.label} pages`}
                      className="relative z-10 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/45 hover:bg-white/10 hover:text-white">
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', !open && '-rotate-90')} />
                    </button>
                  )}
                </div>
                {!single && open && (
                  <ul className="relative mb-1 mt-0.5 space-y-px before:absolute before:bottom-1.5 before:left-[20px] before:top-1.5 before:w-px before:bg-white/10" aria-label={`${g.label} pages`}>
                    {g.pages.map((p) => (
                      <li key={p.to}>
                        <NavLink to={p.to} end={p.end} className="nav-item nav-sub group" aria-current={isCurrent(p) ? 'page' : undefined}>
                          <span className="truncate">{p.label}</span>
                          {badge(p.count) || hint(p, wide, mobile)}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-auto space-y-0.5 pt-5">{footer.map((p) => topItem(p, wide, mobile))}</div>
      </nav>
    );
  };

  // The pages of the group you are in, along the top of the page, where the sidebar does not list them.
  const strip = activeGroup ? groups.find((g) => g.id === activeGroup.id)?.pages ?? [] : [];
  const sectionStrip = strip.length > 1 ? (
    <nav data-strip aria-label={`${activeGroup!.label} pages`} className={cn('no-print page -mt-3 mb-6 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]', !collapsed && 'lg:hidden')}>
      {strip.map((p) => (
        <NavLink key={p.to} to={p.to} end={p.end} aria-current={isCurrent(p) ? 'page' : undefined}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition-colors', isCurrent(p) ? 'bg-ink text-surface ring-ink' : 'bg-surface text-ink-2 ring-line hover:text-ink hover:ring-line-strong')}>
          {p.label}
          {p.count && counts[p.count] ? <span className={cn('rounded-full px-1.5 font-mono text-[10px]', isCurrent(p) ? 'bg-surface/20' : 'bg-surface-2 text-ink-3')}>{counts[p.count]}</span> : null}
        </NavLink>
      ))}
    </nav>
  ) : null;
  useEffect(() => { document.querySelector('[data-strip] a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [location.pathname]);

  const workspace = (wide: boolean, mobile = false) => wide ? <ViewSwitcher mobile={mobile} /> : null;

  const railBackground = 'bg-rail [background-image:radial-gradient(120%_60%_at_0%_0%,rgb(var(--accent)/.16),transparent_60%),radial-gradient(80%_40%_at_100%_100%,rgb(var(--marker)/.1),transparent_70%)]';

  return (
    <OutboxContext.Provider value={{ pending, flush }}>
      <div className="flex min-h-[100dvh] bg-canvas">
        <a href="#main" className="skip-link">Skip to content</a>
        <ActivityBar />
        <aside className={cn('no-print sticky top-0 hidden h-[100dvh] shrink-0 flex-col border-r border-white/[.06] transition-[width] duration-300 [transition-timing-function:var(--ease-spring)] lg:flex', railBackground, collapsed ? 'w-[72px]' : 'w-[248px]')}>
          <div className={cn('flex h-[60px] shrink-0 items-center px-5', collapsed && 'justify-center px-0')}>
            {collapsed ? <Mark size={26} reversed /> : <Logo size={24} reversed />}
          </div>
          {workspace(!collapsed)}
          {navList(false)}
          <div className="border-t border-white/[.06] p-3">
            {!collapsed ? (
              <div className="flex items-center gap-1">
                {accountMenu(
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-white/[.06]" aria-label={news.unseen ? 'Account menu. Something new in Vantage' : 'Account menu'}>
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white/10 text-2xs font-semibold text-white ring-1 ring-white/10">{initials(user?.first_name, user?.last_name)}{news.unseen && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-rail" aria-hidden />}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-white">{who}</span>
                      <span className="block truncate text-2xs text-white/50">{roleLine(identity, view)}</span>
                    </span>
                  </button>,
                )}
                <Tooltip content="Collapse  [" side="right">
                  <button type="button" onClick={toggleRail} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[.06] hover:text-white" aria-label="Collapse navigation"><ChevronsLeft className="h-4 w-4" /></button>
                </Tooltip>
              </div>
            ) : (
              <Tooltip content="Expand  [" side="right">
                <button type="button" onClick={toggleRail} className="flex h-9 w-full items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[.06] hover:text-white" aria-label="Expand navigation"><ChevronsRight className="h-4 w-4" /></button>
              </Tooltip>
            )}
          </div>
        </aside>

        {drawer && (
          <div className="no-print fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-deep/60 backdrop-blur-sm animate-fade-in" onClick={() => setDrawer(false)} aria-label="Close menu" />
            <aside className={cn('absolute inset-y-0 left-0 flex w-[min(86vw,292px)] flex-col shadow-modal animate-slide-in-left', railBackground)}>
              <div className="flex h-[60px] shrink-0 items-center gap-2 px-5">
                <Logo size={24} reversed />
                <button type="button" onClick={() => setDrawer(false)} className="ml-auto rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close menu"><X className="h-4 w-4" /></button>
              </div>
              {workspace(true, true)}
              {navList(true)}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-[60px] items-center gap-3 border-b border-line/80 bg-surface/80 px-3 backdrop-blur-xl backdrop-saturate-150 sm:px-5 lg:px-8">
            <button type="button" className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
            <p className="flex min-w-0 items-baseline gap-2">
              {place.group && <><span className="hidden shrink-0 text-[15px] text-ink-3 sm:inline">{place.group}</span><span className="hidden shrink-0 text-line-strong sm:inline" aria-hidden>/</span></>}
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{place.title}</span>
              {!place.group && place.detail && <><span className="hidden shrink-0 text-line-strong sm:inline" aria-hidden>/</span><span className="hidden truncate text-sm text-ink-3 sm:inline">{place.detail}</span></>}
            </p>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!online && <Tooltip content="Offline. New entries queue on this device."><span className="flex h-8 items-center gap-1.5 rounded-full bg-warn/10 px-3 text-xs font-medium text-warn ring-1 ring-warn/20"><WifiOff className="h-3.5 w-3.5" /><span className="hidden sm:inline">Offline</span></span></Tooltip>}
              {online && pending > 0 && <button type="button" onClick={() => setQueueOpen(true)} title="Entries waiting to sync" className="flex h-8 items-center gap-1.5 rounded-full bg-info/10 px-3 text-xs font-medium text-info ring-1 ring-info/20 hover:bg-info/15"><CloudOff className="h-3.5 w-3.5" />{pending} queued</button>}
              <button type="button" onClick={() => setPalette(true)} className="flex h-9 items-center gap-2 rounded-full bg-surface-2 px-3 text-sm text-ink-3 ring-1 ring-line transition-[box-shadow,color,background-color] hover:bg-surface hover:text-ink-2 hover:ring-line-strong md:w-64 lg:w-80" aria-label="Search">
                <Search className="h-4 w-4 shrink-0" aria-hidden /><span className="hidden md:inline">Search work, records, reference…</span><span className="ml-auto hidden lg:inline"><Kbd>⌘K</Kbd></span>
              </button>
              {/* Below the large breakpoint the tab bar carries this, in reach of a thumb. */}
              <button type="button" onClick={() => openQuickLog('')} aria-label="Log activity"
                className="group hidden h-9 items-center gap-2 rounded-full bg-accent pl-3 pr-1 lg:flex text-sm font-medium text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/.2),0_1px_2px_rgb(var(--accent)/.35),0_6px_16px_-6px_rgb(var(--accent)/.55)] transition-[filter,transform] hover:brightness-[1.06] xl:pl-4">
                <span className="hidden xl:inline">Log activity</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 transition-transform duration-200 group-hover:rotate-90"><Plus className="h-4 w-4" /></span>
              </button>
              <NotificationBell onNavigate={(to) => navigate(to)} />
              {accountMenu(
                <button type="button" className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-rail-active text-xs font-semibold text-white ring-1 ring-black/5 transition-[filter] hover:brightness-125 lg:hidden" aria-label={news.unseen ? 'Account menu. Something new in Vantage' : 'Account menu'}>{initials(user?.first_name, user?.last_name)}{news.unseen && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-surface" aria-hidden />}</button>,
              )}
            </div>
          </header>

          {demo && (
            <div role="region" aria-label="Synthetic demo" className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-accent/15 bg-gradient-to-r from-accent-soft/80 via-accent-soft/40 to-transparent px-4 py-2 text-sm text-ink sm:px-6 lg:px-8">
              {/* One row on a phone: what this is, whose eyes, and a way to start again. The sentence is for wider screens. */}
              <span className="flex items-center gap-2 font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent"><FlaskConical className="h-3.5 w-3.5" aria-hidden /></span><span className="sm:hidden">Demo</span><span className="hidden sm:inline">Synthetic demo</span></span>
              <span className="hidden text-ink-2 sm:inline">
                You are {who}, {demo.workspace?.persona === 'leader' ? 'the section lead' : 'a budget analyst'}.
                <span className="hidden md:inline"> Everything here is invented; changes last {demo.ttl_hours} hours.</span>
              </span>
              <span className="ml-auto flex items-center gap-1">
                <span className="flex rounded-full bg-surface p-0.5 ring-1 ring-line">
                  <button type="button" onClick={() => demo.workspace?.persona === 'leader' && switchPersona('marine')} aria-pressed={demo.workspace?.persona !== 'leader'}
                    aria-label={demo.workspace?.persona === 'leader' ? 'View as the Marine' : 'The Marine'}
                    className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', demo.workspace?.persona !== 'leader' ? 'bg-rail-active text-white' : 'text-ink-2 hover:text-ink')}>
                    <span className="sm:hidden">Marine</span><span className="hidden sm:inline">{demo.workspace?.persona === 'leader' ? 'View as the Marine' : 'The Marine'}</span>
                  </button>
                  <button type="button" onClick={() => demo.workspace?.persona !== 'leader' && switchPersona('leader')} aria-pressed={demo.workspace?.persona === 'leader'}
                    aria-label={demo.workspace?.persona === 'leader' ? 'The section lead' : 'View as the section lead'}
                    className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', demo.workspace?.persona === 'leader' ? 'bg-rail-active text-white' : 'text-ink-2 hover:text-ink')}>
                    <span className="sm:hidden">Section lead</span><span className="hidden sm:inline">{demo.workspace?.persona === 'leader' ? 'The section lead' : 'View as the section lead'}</span>
                  </button>
                </span>
                <button type="button" onClick={startOver} className="ml-1 rounded-full px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-surface hover:text-ink sm:px-3">Start over</button>
              </span>
            </div>
          )}
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-7 outline-none sm:px-6 lg:px-10 lg:pb-16 lg:pt-10">
            {updateReady && (
              <div role="status" className="no-print page card mb-5 flex items-center gap-3 px-4 py-3 text-base text-ink">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-info/10 text-info"><RefreshCw className="h-4 w-4" /></span>
                <span className="flex-1">A new version of Vantage is ready.</span>
                <button type="button" className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-surface hover:brightness-125" onClick={() => { navigator.serviceWorker?.getRegistration().then((r) => r?.waiting?.postMessage('skip-waiting')); setTimeout(() => window.location.reload(), 300); }}>Reload</button>
              </div>
            )}
            {identity?.instance.announcement && (
              <div role="status" className="no-print page card mb-5 flex items-start gap-3 px-4 py-3 text-base text-ink">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><AlertTriangle className="h-4 w-4" /></span><span className="pt-0.5">{identity.instance.announcement}</span>
              </div>
            )}
            {sectionStrip}
            <ErrorBoundary resetKey={location.pathname + location.search}><div key={location.pathname} className="animate-fade-up"><Outlet /></div></ErrorBoundary>
          </main>
          <footer className="no-print flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-[calc(1.25rem+var(--tabbar,0px))] pt-5 text-xs text-ink-3 sm:px-6 lg:px-10">
            <button type="button" onClick={openWhatsNew} className="flex items-center gap-1.5 rounded transition-colors hover:text-ink" aria-label={`Vantage v${VERSION}. What’s new`} title="What’s new"><Mark size={12} />Vantage v{VERSION}</button>
            <span>Your Unit Instance’s records are kept apart from every other’s.</span>
            <span className="hidden sm:inline">Not an official DoD or USMC system of record.</span>
          </footer>
        </div>

        <TabBar hidden={drawer || quickLog || palette} leads={teams.has('workload')} onLog={() => openQuickLog('')} onMore={() => setDrawer(true)} />
        <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
        {userId && <OutboxDialog open={queueOpen} onOpenChange={setQueueOpen} userId={userId} onRetry={flush} />}
        <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} nav={visibleNav} extra={paletteActions} />
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <WhatsNewDialog open={whatsNew} onOpenChange={setWhatsNew} />
        {!demo && <IdleGuard onSignOut={idleSignOut} />}
        <SudoDialog open={Boolean(sudoOpen)} onOpenChange={(o) => { if (!o) { sudoOpen?.cancel(); setSudoOpen(null); } }} onConfirmed={() => { const req = sudoOpen; setSudoOpen(null); req?.confirm(); }} />
      </div>
    </OutboxContext.Provider>
  );
}
