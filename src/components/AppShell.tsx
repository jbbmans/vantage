import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { installTelemetry, track } from '@/lib/telemetry';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Bell, ChevronsLeft, ChevronsRight, ChevronsUpDown, CloudOff, FlaskConical, Keyboard, LogOut, Menu as MenuIcon, Moon,
  Plus, RefreshCw, Search, Settings2, Sun, WifiOff, X,
} from 'lucide-react';
import { NAV, NAV_GROUPS } from '@/config/nav';
import { cn, initials, timeAgo } from '@/lib/utils';
import { Tooltip, Kbd } from '@/components/ui/primitives';
import Logo, { Mark } from '@/components/Logo';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import * as Popover from '@radix-ui/react-popover';
import QuickLog from '@/components/QuickLog';
import CommandPalette from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import SudoDialog, { type SudoRequest } from '@/components/SudoDialog';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useIdentity, useNotifications, useSavePrefs, signOutEverywhere, keys, invalidateDomains } from '@/lib/queries';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { flushOutbox, onOutboxChange, outbox } from '@/lib/outbox';
import { resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';
import { useBuildWatch } from '@/lib/build';

/** Destination name, and the one-line subtitle the breadcrumb shows beside it. */
const TITLES: Array<[string, string, string]> = [
  ['/records', 'Record', 'An activity you recorded'],
  ['/record', 'Record', 'What you did and what backs it up'],
  ['/work', 'Work', 'Taskers, the queue, and what is yours'],
  ['/goals', 'Goals', 'Targets and measurable progress'],
  ['/career', 'Career', 'Next steps, training, readiness'],
  ['/reference', 'Reference', 'The FMRA desk reference'],
  ['/maradmins', 'MARADMINs', 'Messages that change a requirement'],
  ['/reports', 'Reports', 'JEPES and FITREP input from the facts'],
  ['/team', 'Team', 'Workload, people, and units'],
  ['/settings', 'Settings', 'Your preferences'],
  ['/operator', 'Owner console', 'This deployment'],
  ['/help', 'Field guide', 'How Vantage works'],
];
const entryFor = (p: string) => (p === '/' ? (['/', 'Today', 'Your next move'] as const) : TITLES.find(([path]) => p.startsWith(path)));
const titleFor = (p: string) => entryFor(p)?.[1] || 'Vantage';

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

export const OutboxContext = React.createContext<{ pending: number; flush: () => Promise<void> }>({ pending: 0, flush: async () => {} });

function NotificationBell({ onNavigate }: { onNavigate: (to: string) => void }) {
  const { data, refetch } = useNotifications();
  const qc = useQueryClient();
  const unread = data?.unread || 0;
  const rows: Array<{ id: string; kind: string; title: string; message: string | null; action_url: string | null; read_at: string | null; created_at: string }> = data?.rows || [];
  const open = async (n: typeof rows[number]) => {
    if (!n.read_at) { await api.markRead(n.id).catch(() => undefined); qc.invalidateQueries({ queryKey: keys.notifications }); }
    // Notification links are always in-app paths. Anything else is ignored rather than followed.
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

/** Which destination a path belongs to, as one of the words the event catalog allows. */
function surfaceOf(pathname: string, search: string): string {
  const segment = pathname.split('/')[1] || '';
  const tab = new URLSearchParams(search).get('tab') || '';
  // Work and Reports are each one destination with several tabs. Reporting them as one surface
  // would hide which half of the screen people actually use, so the tab decides the name.
  if (segment === 'work') return tab === 'mail' ? 'correspondence' : tab === 'tasks' || tab === 'projects' ? 'tasks' : 'queue';
  if (segment === 'reports') return tab === 'analysis' ? 'reports' : 'studio';
  if (segment === 'career' && tab === 'readiness') return 'readiness';
  if (segment === 'reference') return tab === 'diagnose' || !tab ? 'diagnose' : 'reference';
  const map: Record<string, string> = {
    '': 'dashboard', records: 'records', record: 'records', goals: 'goals', readiness: 'readiness', career: 'career',
    maradmins: 'maradmins', team: 'team', settings: 'settings', operator: 'operator', help: 'help',
  };
  return map[segment] || 'dashboard';
}

export default function AppShell() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const savePrefs = useSavePrefs();
  const location = useLocation();

  // Which destinations get used, and whether people come back. Paths only, never their ids.
  useEffect(() => { installTelemetry(); track('session.started', { returning: document.referrer.includes(window.location.host) }); }, []);
  useEffect(() => { track('surface.viewed', { surface: surfaceOf(location.pathname, location.search) }); }, [location.pathname, location.search]);
  const navigate = useNavigate();
  const online = useOnline();
  const userId = identity?.user.id;
  const pending = useOutboxCount(userId);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('vantage.rail') === 'collapsed'; } catch { return false; } });
  const [quickLog, setQuickLog] = useState(false);
  const [quickLogSeed, setQuickLogSeed] = useState('');
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [sudoOpen, setSudoOpen] = useState<null | SudoRequest>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(identity?.prefs.theme || storedTheme()));
  const updateReady = useBuildWatch();

  useEffect(() => { setTheme(resolveTheme(identity?.prefs.theme || storedTheme())); }, [identity?.prefs.theme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll reset on path change only
  useEffect(() => { setDrawer(false); if (!location.hash) window.scrollTo({ top: 0 }); }, [location.pathname]);
  useEffect(() => { document.title = `${titleFor(location.pathname)} · Vantage`; }, [location.pathname]);

  const flush = useCallback(async () => {
    if (!userId) return;
    const result = await flushOutbox((payload) => api.createRecord('activities', payload), userId);
    if (result.sent) {
      // A synced entry changes every read model built from entries, not just the list.
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
  const visibleNav = useMemo(() => NAV.filter((item) => {
    if (item.hideInDemo && identity?.demo) return false;
    if (item.requiresLead && !identity?.canLead) return false;
    if (item.requiresOperator && !identity?.user.is_operator) return false;
    if (item.requiresAi && !identity?.instance.aiEnabled) return false;
    if (item.requiresMaradmins && !identity?.instance.maradminsEnabled) return false;
    return true;
  }), [identity]);

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
      else if (event.key === 'g') {
        const second = (next: KeyboardEvent) => { const hit = visibleNav.find((i) => i.key === next.key); if (hit) { next.preventDefault(); navigate(hit.to); } window.removeEventListener('keydown', second, true); };
        window.addEventListener('keydown', second, true);
        window.setTimeout(() => window.removeEventListener('keydown', second, true), 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openQuickLog, visibleNav]);

  const switchPersona = async (persona: 'marine' | 'leader') => {
    try { await api.demoPersona(persona); qc.clear(); navigate('/'); qc.invalidateQueries(); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const startOver = async () => {
    try { await api.demoReset(); qc.clear(); navigate('/'); qc.invalidateQueries(); toast.success('A fresh synthetic workspace is ready.'); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); savePrefs.mutate({ theme: next }); };
  function toggleRail() { setCollapsed((c) => { const n = !c; try { localStorage.setItem('vantage.rail', n ? 'collapsed' : 'open'); } catch {} return n; }); }
  const user = identity?.user;
  const primary = identity?.memberships.find((m) => m.is_primary) || identity?.memberships[0];
  const who = [user?.rank?.abbr, user?.first_name, user?.last_name].filter(Boolean).join(' ');

  const accountMenu = (trigger: React.ReactNode) => (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent>
        <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2.5 pb-2.5 pt-1.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-rail-active text-xs font-semibold text-white">{initials(user?.first_name, user?.last_name)}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">{who}</span>
            <span className="block truncate text-xs text-ink-3">{primary ? `${primary.billet ? `${primary.billet} · ` : ''}${primary.unit_short || primary.unit_name}` : 'No unit yet'}</span>
          </span>
        </div>
        <MenuItem icon={Settings2} onSelect={() => navigate('/settings')}>Settings</MenuItem>
        {user?.is_operator && !demo ? <MenuItem onSelect={() => navigate('/operator')}>Owner console</MenuItem> : null}
        <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? Sun : Moon}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</MenuItem>
        <MenuItem icon={Keyboard} onSelect={() => setShortcuts(true)}>Keyboard shortcuts</MenuItem>
        <MenuSeparator />
        {demo
          ? <MenuItem icon={RefreshCw} onSelect={() => startOver()}>Start the demo over</MenuItem>
          : <MenuItem danger icon={LogOut} onSelect={() => signOutEverywhere()}>Sign out</MenuItem>}
      </MenuContent>
    </Menu>
  );

  // "More" sinks to the bottom of the rail: settings and the field guide are always reachable but
  // never compete with the destinations a person came here to open.
  const navList = (mobile: boolean) => {
    const wide = !collapsed || mobile;
    return (
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-2" aria-label="Primary">
        {NAV_GROUPS.map((group) => {
          const items = visibleNav.filter((i) => i.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className={cn('mb-1', group === 'More' && 'mt-auto pt-5', group !== 'Primary' && group !== 'More' && 'pt-4')}>
              {wide && (group === 'Leading' || group === 'Knowledge') && <p className="nav-label">{group === 'Leading' ? 'Leading' : 'Knowledge'}</p>}
              {!wide && group !== 'Primary' && group !== 'More' && <div className="mx-3 mb-3 h-px bg-white/10" aria-hidden />}
              <div className="space-y-0.5">
                {items.map((item) => (
                  <Tooltip key={item.to} content={!wide ? item.label : null} side="right">
                    <NavLink to={item.to} end={item.end} className={cn('nav-item group', !wide && 'justify-center px-0')} aria-current={location.pathname === item.to || (!item.end && location.pathname.startsWith(item.to)) ? 'page' : undefined}>
                      <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />
                      {wide && <span className="truncate">{item.label}</span>}
                      {wide && !mobile && <span className="ml-auto hidden font-mono text-[10px] text-white/35 group-hover:inline" aria-hidden>G {item.key.toUpperCase()}</span>}
                    </NavLink>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
    );
  };

  /* Which workspace you are in, stated once at the top — where a person looks to check they are
     filing this against the right unit. A tray with a plate in it, so it reads as a control. */
  const workspace = (wide: boolean) => wide ? (
    <div className="mx-3 mb-2 mt-1 rounded-[14px] bg-white/[.04] p-1 ring-1 ring-white/[.07]">
      <button type="button" onClick={() => navigate(identity?.canLead ? '/team?tab=units' : '/settings')}
        className="flex w-full items-center gap-2.5 rounded-[10px] bg-white/[.05] px-2.5 py-2 text-left shadow-[inset_0_1px_0_rgb(255_255_255/.06)] transition-colors hover:bg-white/[.08]">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rail-active [background-image:linear-gradient(to_bottom,rgb(255_255_255/.14),rgb(255_255_255/0))] text-2xs font-semibold tracking-wide text-white ring-1 ring-white/10">{(primary?.unit_short || primary?.unit_name || '·').slice(0, 3).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] leading-tight text-white/55">{identity?.instance.organizationName || 'Workspace'}</span>
          <span className="block truncate text-sm font-medium leading-tight text-white">{primary ? primary.unit_short || primary.unit_name : 'No unit yet'}</span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden />
      </button>
    </div>
  ) : null;

  const railBackground = 'bg-rail [background-image:radial-gradient(120%_60%_at_0%_0%,rgb(var(--accent)/.16),transparent_60%),radial-gradient(80%_40%_at_100%_100%,rgb(var(--brand-teal)/.08),transparent_70%)]';

  return (
    <OutboxContext.Provider value={{ pending, flush }}>
      <div className="flex min-h-[100dvh] bg-canvas">
        <a href="#main" className="skip-link">Skip to content</a>
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
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-white/[.06]" aria-label="Account menu">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white/10 text-2xs font-semibold text-white ring-1 ring-white/10">{initials(user?.first_name, user?.last_name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-white">{who}</span>
                      <span className="block truncate text-2xs text-white/50">{primary?.billet || 'Marine'}</span>
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
              {workspace(true)}
              {navList(true)}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-[60px] items-center gap-3 border-b border-line/80 bg-surface/80 px-3 backdrop-blur-xl backdrop-saturate-150 sm:px-5 lg:px-8">
            <button type="button" className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
            {/* Where you are, and what this screen is. Not a heading: every page carries its own h1. */}
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{titleFor(location.pathname)}</span>
              <span className="hidden shrink-0 text-line-strong sm:inline" aria-hidden>/</span>
              <span className="hidden truncate text-sm text-ink-3 sm:inline">{entryFor(location.pathname)?.[2]}</span>
            </p>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!online && <Tooltip content="Offline. New entries queue on this device."><span className="flex h-8 items-center gap-1.5 rounded-full bg-warn/10 px-3 text-xs font-medium text-warn ring-1 ring-warn/20"><WifiOff className="h-3.5 w-3.5" /><span className="hidden sm:inline">Offline</span></span></Tooltip>}
              {online && pending > 0 && <button type="button" onClick={flush} className="flex h-8 items-center gap-1.5 rounded-full bg-info/10 px-3 text-xs font-medium text-info ring-1 ring-info/20 hover:bg-info/15"><CloudOff className="h-3.5 w-3.5" />{pending} queued</button>}
              <button type="button" onClick={() => setPalette(true)} className="flex h-9 items-center gap-2 rounded-full bg-surface-2 px-3 text-sm text-ink-3 ring-1 ring-line transition-[box-shadow,color,background-color] hover:bg-surface hover:text-ink-2 hover:ring-line-strong md:w-64 lg:w-80" aria-label="Search">
                <Search className="h-4 w-4 shrink-0" aria-hidden /><span className="hidden md:inline">Search work, records, reference…</span><span className="ml-auto hidden lg:inline"><Kbd>⌘K</Kbd></span>
              </button>
              <button type="button" onClick={() => openQuickLog('')} aria-label="Log activity"
                className="group flex h-9 items-center gap-2 rounded-full bg-accent pl-3 pr-1 text-sm font-medium text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/.2),0_1px_2px_rgb(var(--accent)/.35),0_6px_16px_-6px_rgb(var(--accent)/.55)] transition-[filter,transform] hover:brightness-[1.06] xl:pl-4">
                <span className="hidden xl:inline">Log activity</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 transition-transform duration-200 group-hover:rotate-90"><Plus className="h-4 w-4" /></span>
              </button>
              <NotificationBell onNavigate={(to) => navigate(to)} />
              {accountMenu(
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-rail-active text-xs font-semibold text-white ring-1 ring-black/5 transition-[filter] hover:brightness-125 lg:hidden" aria-label="Account menu">{initials(user?.first_name, user?.last_name)}</button>,
              )}
            </div>
          </header>

          {demo && (
            <div role="region" aria-label="Synthetic demo" className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-accent/15 bg-gradient-to-r from-accent-soft/80 via-accent-soft/40 to-transparent px-4 py-2 text-sm text-ink sm:px-6 lg:px-8">
              <span className="flex items-center gap-2 font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent"><FlaskConical className="h-3.5 w-3.5" aria-hidden /></span>Synthetic demo</span>
              <span className="text-ink-2">
                You are {who}, {demo.workspace?.persona === 'leader' ? 'the section lead' : 'a budget analyst'}.
                <span className="hidden md:inline"> Everything here is invented; changes last {demo.ttl_hours} hours.</span>
              </span>
              <span className="flex items-center gap-1 md:ml-auto">
                <span className="flex rounded-full bg-surface p-0.5 ring-1 ring-line">
                  <button type="button" onClick={() => demo.workspace?.persona === 'leader' && switchPersona('marine')} aria-pressed={demo.workspace?.persona !== 'leader'}
                    className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', demo.workspace?.persona !== 'leader' ? 'bg-rail-active text-white' : 'text-ink-2 hover:text-ink')}>
                    {demo.workspace?.persona === 'leader' ? 'View as the Marine' : 'The Marine'}
                  </button>
                  <button type="button" onClick={() => demo.workspace?.persona !== 'leader' && switchPersona('leader')} aria-pressed={demo.workspace?.persona === 'leader'}
                    className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', demo.workspace?.persona === 'leader' ? 'bg-rail-active text-white' : 'text-ink-2 hover:text-ink')}>
                    {demo.workspace?.persona === 'leader' ? 'The section lead' : 'View as the section lead'}
                  </button>
                </span>
                <button type="button" onClick={startOver} className="ml-1 rounded-full px-3 py-1 text-xs font-medium text-ink-2 hover:bg-surface hover:text-ink">Start over</button>
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
            <ErrorBoundary resetKey={location.pathname + location.search}><div key={location.pathname} className="animate-fade-up"><Outlet /></div></ErrorBoundary>
          </main>
          <footer className="no-print flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-5 text-xs text-ink-3 sm:px-6 lg:px-10">
            <span className="flex items-center gap-1.5"><Mark size={12} />Vantage v{VERSION}</span>
            <span>Records stay on this deployment’s server.</span>
            <span className="hidden sm:inline">Not an official DoD or USMC system of record.</span>
          </footer>
        </div>

        <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
        <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} nav={visibleNav} />
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <SudoDialog open={Boolean(sudoOpen)} onOpenChange={(o) => { if (!o) { sudoOpen?.cancel(); setSudoOpen(null); } }} onConfirmed={() => { const req = sudoOpen; setSudoOpen(null); req?.confirm(); }} />
      </div>
    </OutboxContext.Provider>
  );
}
