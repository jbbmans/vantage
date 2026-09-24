import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { installTelemetry, track } from '@/lib/telemetry';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, ChevronsUpDown, CloudOff, PanelLeftClose, PanelLeftOpen, FlaskConical, LogOut, Menu as MenuIcon, Moon, Plus, RefreshCw, Search, Sun, WifiOff, X } from 'lucide-react';
import { NAV, NAV_GROUPS } from '@/config/nav';
import { m } from 'motion/react';
import { Ambient } from '@/components/effects';
import { installSpotlight } from '@/lib/effects';
import { cn, initials, timeAgo } from '@/lib/utils';
import { Button, Tooltip, Kbd } from '@/components/ui/primitives';
import Logo, { Mark } from '@/components/Logo';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import * as Popover from '@radix-ui/react-popover';
import QuickLog from '@/components/QuickLog';
import CommandPalette from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import SudoDialog, { type SudoRequest } from '@/components/SudoDialog';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useIdentity, useNotifications, useSavePrefs, signOutEverywhere, keys, useAssignedWork } from '@/lib/queries';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { flushOutbox, onOutboxChange, outbox } from '@/lib/outbox';
import { resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';

/** Destination name, and the one-line subtitle the breadcrumb shows beside it. */
const TITLES: Array<[string, string, string]> = [
  ['/records', 'Record', 'An activity you recorded'],
  ['/record', 'Record', 'What you did and what backs it up'],
  ['/work', 'Work', 'Taskers, the queue, and what is yours'],
  ['/goals', 'Goals', 'Targets and measurable progress'],
  ['/career', 'Career', 'Next steps, training, readiness'],
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
    if (n.action_url) onNavigate(n.action_url);
  };
  return (
    <Popover.Root onOpenChange={(o) => { if (o) refetch(); }}>
      <Popover.Trigger asChild>
        <button type="button" className="relative flex h-9 w-9 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-[min(92vw,380px)] rounded-lg border border-line bg-surface shadow-pop animate-scale-in">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            {unread > 0 && <button type="button" onClick={async () => { await api.markAllRead(); qc.invalidateQueries({ queryKey: keys.notifications }); }} className="text-xs text-accent hover:underline">Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-ink-3">You are caught up.</p> : rows.map((n) => (
              <button key={n.id} type="button" onClick={() => open(n)} className={cn('row flex w-full items-start gap-3 px-3 py-2.5 text-left', !n.read_at && 'bg-accent-soft/40')}>
                <span className={cn('mt-1.5 badge-dot', n.read_at ? 'bg-line-strong' : 'bg-accent')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{n.title}</span>
                  {n.message && <span className="block text-xs leading-snug text-ink-2">{n.message}</span>}
                  <span className="block text-2xs text-ink-3">{timeAgo(n.created_at)}</span>
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
  if (segment === 'work') return pathname.split('/')[2] === 'items' ? 'work_item' : tab === 'mail' ? 'correspondence' : tab === 'tasks' || tab === 'projects' ? 'tasks' : 'queue';
  if (segment === 'team' && (!tab || tab === 'workload')) return 'workload';
  if (segment === 'reports') return tab === 'analysis' ? 'reports' : 'studio';
  if (segment === 'career' && tab === 'readiness') return 'readiness';
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
  const [updateReady, setUpdateReady] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(identity?.prefs.theme || storedTheme()));

  useEffect(() => { setTheme(resolveTheme(identity?.prefs.theme || storedTheme())); }, [identity?.prefs.theme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll reset on path change only
  useEffect(() => { setDrawer(false); if (!location.hash) window.scrollTo({ top: 0 }); }, [location.pathname]);
  useEffect(() => { document.title = `${titleFor(location.pathname)} · Vantage`; }, [location.pathname]);
  useEffect(() => { const h = () => setUpdateReady(true); window.addEventListener('vantage:update-available', h); return () => window.removeEventListener('vantage:update-available', h); }, []);

  const flush = useCallback(async () => {
    if (!userId) return;
    const result = await flushOutbox((payload) => api.createRecord('activities', payload), userId);
    if (result.sent) { qc.invalidateQueries({ queryKey: ['records', 'activities'] }); toast.success(`${result.sent} queued ${result.sent === 1 ? 'entry' : 'entries'} synced.`); }
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
  const toggleRail = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('vantage.rail', n ? 'collapsed' : 'open'); } catch {} return n; });
  const user = identity?.user;
  const primary = identity?.memberships.find((m) => m.is_primary) || identity?.memberships[0];

  const isActive = (item: { to: string; end?: boolean }) => location.pathname === item.to || (!item.end && location.pathname.startsWith(item.to));
  // Cards catch the cursor (src/lib/effects.ts). Installed once for the signed-in app.
  useEffect(() => installSpotlight(), []);

  // How much each destination is holding for you, shown beside it. Work: the items in your hands.
  const assigned = useAssignedWork();
  const held = (assigned.data || []).filter((a: any) => !['resolved', 'not_applicable'].includes(a.stage)).length;
  const counts: Record<string, { value: number; says: string }> = held ? { '/work': { value: held, says: `${held} in your hands` } } : {};
  const unitName = primary ? primary.unit_short || primary.unit_name : 'No unit yet';
  const unitMark = (primary?.unit_short || primary?.unit_name || 'V').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();

  // Primary destinations first, then Leading, then everything else pinned to the bottom. A count or a
  // shortcut sits beside each link rather than inside it, so a link's name stays its destination.
  const navList = (mobile: boolean) => (
    <nav className="sidebar-nav flex flex-1 flex-col overflow-y-auto px-3 pb-2" aria-label="Primary">
      {NAV_GROUPS.map((group) => {
        const items = visibleNav.filter((i) => i.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className={cn(group === 'More' && 'mt-auto pt-4', group === 'Leading' && 'pt-5')}>
            {(!collapsed || mobile) && group === 'Leading' && <p className="sidebar-label">Leading</p>}
            <div className="space-y-0.5">
              {items.map((item) => {
                const count = counts[item.to];
                const describe = count ? `nav-count-${item.key}${mobile ? '-m' : ''}` : undefined;
                return (
                  <div key={item.to} className="group relative">
                    <Tooltip content={collapsed && !mobile ? item.label : null} side="right">
                      <NavLink to={item.to} end={item.end} aria-describedby={describe} className={cn('nav-item', collapsed && !mobile && 'justify-center px-0')} aria-current={isActive(item) ? 'page' : undefined}>
                        {/* The selected pill slides from the last destination to this one. */}
                        {isActive(item) && <m.span layoutId={mobile ? 'nav-pill-drawer' : 'nav-pill'} className="nav-pill" transition={{ type: 'spring', stiffness: 460, damping: 36 }} aria-hidden />}
                        <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
                        {(!collapsed || mobile) && <span className="truncate">{item.label}</span>}
                      </NavLink>
                    </Tooltip>
                    {(!collapsed || mobile) && (count
                      ? <><span className="nav-count" aria-hidden>{count.value}</span><span id={describe} hidden>{count.says}</span></>
                      : !mobile && <span className="nav-keys" aria-hidden><kbd>G</kbd><kbd>{item.key.toUpperCase()}</kbd></span>)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );

  /* Which unit you are in, stated once at the top, where a person looks to check they are filing
     this against the right one. */
  const unitSwitch = (compact: boolean) => (
    <button
      type="button"
      onClick={() => navigate(identity?.canLead ? '/team?tab=units' : '/settings')}
      className={cn('unit-switch', compact && 'justify-center px-0')}
      aria-label={compact ? `Unit: ${unitName}` : undefined}
    >
      <span className="unit-mark" aria-hidden>{unitMark}</span>
      {!compact && (
        <>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold text-ink">{unitName}</span>
            <span className="block truncate text-xs text-ink-3">{identity?.instance.organizationName || 'Workspace'}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        </>
      )}
    </button>
  );

  const accountMenu = (
    <>
      <div className="border-b border-line px-2.5 pb-2 pt-1">
        <p className="truncate text-sm font-semibold text-ink">{user?.rank?.abbr} {user?.first_name} {user?.last_name}</p>
        <p className="truncate text-xs text-ink-3">{primary ? `${primary.billet ? `${primary.billet} · ` : ''}${primary.unit_short || primary.unit_name}` : 'No unit yet'}</p>
      </div>
      <MenuItem onSelect={() => navigate('/settings')}>Settings</MenuItem>
      {user?.is_operator ? <MenuItem onSelect={() => navigate('/operator')}>Owner console</MenuItem> : null}
      <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? Sun : Moon}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</MenuItem>
      <MenuItem onSelect={() => setShortcuts(true)}>Keyboard shortcuts</MenuItem>
      <MenuSeparator />
      {demo
        ? <MenuItem icon={RefreshCw} onSelect={() => startOver()}>Start the demo over</MenuItem>
        : <MenuItem danger icon={LogOut} onSelect={() => signOutEverywhere()}>Sign out</MenuItem>}
    </>
  );
  const avatar = <span className="avatar" aria-hidden>{initials(user?.first_name, user?.last_name)}</span>;

  return (
    <OutboxContext.Provider value={{ pending, flush }}>
      <div className="app-shell flex min-h-screen">
        <Ambient />
        <a href="#main" className="skip-link">Skip to content</a>
        <aside className={cn('sidebar no-print sticky top-0 hidden h-screen shrink-0 flex-col transition-[width] duration-200 lg:flex', collapsed ? 'w-[72px]' : 'w-[248px]')}>
          <div className={cn('flex h-[60px] shrink-0 items-center gap-2 px-4', collapsed && 'justify-center px-0')}>
            {collapsed ? <Mark size={24} reversed={theme === 'dark'} /> : <Logo size={24} reversed={theme === 'dark'} />}
            {!collapsed && <button type="button" onClick={toggleRail} className="sidebar-icon ml-auto" aria-label="Collapse navigation"><PanelLeftClose className="h-4 w-4" /></button>}
          </div>
          <div className="px-3 pb-3">{unitSwitch(collapsed)}</div>
          {collapsed && <div className="flex justify-center pb-2"><button type="button" onClick={toggleRail} className="sidebar-icon" aria-label="Expand navigation"><PanelLeftOpen className="h-4 w-4" /></button></div>}
          {navList(false)}
          <div className="sidebar-foot px-3 pb-3 pt-2">
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className={cn('profile', collapsed && 'justify-center px-0')} aria-label="Account menu">
                  {avatar}
                  {!collapsed && (
                    <>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium text-ink">{[user?.rank?.abbr, user?.first_name, user?.last_name].filter(Boolean).join(' ')}</span>
                        <span className="block truncate text-xs text-ink-3">{primary?.billet || (demo ? (demo.workspace?.persona === 'leader' ? 'Section lead' : 'Budget analyst') : unitName)}</span>
                      </span>
                      <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                    </>
                  )}
                </button>
              </MenuTrigger>
              <MenuContent side="top" align="start">{accountMenu}</MenuContent>
            </Menu>
          </div>
        </aside>

        {drawer && (
          <div className="no-print fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-ink/60 animate-fade-in" onClick={() => setDrawer(false)} aria-label="Close menu" />
            <aside className="sidebar sidebar-drawer absolute inset-y-0 left-0 flex w-[min(86vw,288px)] flex-col animate-slide-in-left">
              <div className="flex h-[60px] shrink-0 items-center gap-2 px-4">
                <Logo size={24} reversed={theme === 'dark'} />
                <button type="button" onClick={() => setDrawer(false)} className="sidebar-icon ml-auto" aria-label="Close menu"><X className="h-4 w-4" /></button>
              </div>
              <div className="px-3 pb-3">{unitSwitch(false)}</div>
              {navList(true)}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-[60px] items-center gap-3 border-b border-line bg-surface px-3 sm:px-4 lg:px-6">
            <button type="button" className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
            {/* Where you are, and what this screen is. Two words beat a folder path nobody reads. */}
            {/* Not a heading: every page carries its own h1, and two per page confuses a screen reader's outline. */}
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-lg font-semibold text-ink">{titleFor(location.pathname)}</span>
              <span className="hidden shrink-0 text-ink-3 sm:inline" aria-hidden>/</span>
              <span className="hidden truncate text-base text-ink-3 sm:inline">{entryFor(location.pathname)?.[2]}</span>
            </p>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!online && <Tooltip content="Offline. New entries queue on this device."><span className="flex h-9 items-center gap-1.5 rounded-md bg-warn/12 px-2.5 text-xs font-medium text-warn"><WifiOff className="h-4 w-4" /><span className="hidden sm:inline">Offline</span></span></Tooltip>}
              {online && pending > 0 && <button type="button" onClick={flush} className="flex h-9 items-center gap-1.5 rounded-md bg-info/12 px-2.5 text-xs font-medium text-info hover:bg-info/20"><CloudOff className="h-4 w-4" />{pending} queued</button>}
              <button type="button" onClick={() => setPalette(true)} className="flex h-9 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-base text-ink-3 transition-colors hover:border-ink-3/50 hover:text-ink-2 md:w-64 lg:w-80" aria-label="Search">
                <Search className="h-4 w-4 shrink-0" aria-hidden /><span className="hidden md:inline">Search cases, records, or actions…</span><span className="ml-auto hidden lg:inline"><Kbd>⌘K</Kbd></span>
              </button>
              <Button variant="primary" onClick={() => openQuickLog('')} aria-label="Log activity"><Plus className="h-4 w-4" /><span className="hidden xl:inline">Log activity</span></Button>
              <NotificationBell onNavigate={(to) => navigate(to)} />
              {/* On a phone the account lives here; on a desktop it sits at the foot of the sidebar. */}
              <div className="lg:hidden">
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" className="flex h-9 w-9 items-center justify-center rounded-full" aria-label="Account menu">{avatar}</button>
                  </MenuTrigger>
                  <MenuContent>{accountMenu}</MenuContent>
                </Menu>
              </div>
            </div>
          </header>

          {demo && (
            <div role="region" aria-label="Synthetic demo" className="no-print flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-accent-soft/60 px-4 py-2 text-sm text-ink sm:px-6 lg:px-8">
              <span className="flex items-center gap-2 font-medium"><FlaskConical className="h-4 w-4 text-accent" aria-hidden />Synthetic demo</span>
              <span className="text-ink-2">
                You are {user?.rank?.abbr} {user?.first_name} {user?.last_name}, {demo.workspace?.persona === 'leader' ? 'the section lead' : 'a budget analyst'}.
                <span className="hidden md:inline"> Everything here is invented; changes are kept for {demo.ttl_hours} hours, then removed.</span>
                {demo.measured_with === 'posthog' && <span className="hidden md:inline"> Screen and step names are measured with PostHog; nothing you type is sent.</span>}
              </span>
              <span className="flex items-center gap-1.5 md:ml-auto">
                {demo.workspace?.persona === 'leader'
                  ? <Button size="sm" onClick={() => switchPersona('marine')}>View as the Marine</Button>
                  : <Button size="sm" onClick={() => switchPersona('leader')}>View as the section lead</Button>}
                <Button size="sm" variant="ghost" onClick={startOver}>Start over</Button>
              </span>
            </div>
          )}
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:px-8 lg:pb-16 lg:pt-8">
            {updateReady && (
              <div role="status" className="no-print page card mb-4 flex items-center gap-2.5 border-l-[3px] border-l-info px-4 py-3 text-base text-ink">
                <RefreshCw className="h-4 w-4 text-info" /><span className="flex-1">A new version of Vantage is ready.</span>
                <Button size="xs" onClick={() => { navigator.serviceWorker?.getRegistration().then((r) => r?.waiting?.postMessage('skip-waiting')); setTimeout(() => window.location.reload(), 300); }}>Reload</Button>
              </div>
            )}
            {identity?.instance.announcement && (
              <div role="status" className="no-print page card mb-4 flex items-start gap-2 border-l-[3px] border-l-accent px-4 py-3 text-base text-ink">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span>{identity.instance.announcement}</span>
              </div>
            )}
            <ErrorBoundary resetKey={location.pathname + location.search}><div key={location.pathname} className="animate-fade-up"><Outlet /></div></ErrorBoundary>
          </main>
          <footer className="no-print px-4 py-4 text-xs text-ink-3 sm:px-6 lg:px-8">Vantage v{VERSION} · Records stay on this deployment's server.</footer>
        </div>

        <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
        <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} nav={visibleNav} />
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <SudoDialog open={Boolean(sudoOpen)} onOpenChange={(o) => { if (!o) { sudoOpen?.cancel(); setSudoOpen(null); } }} onConfirmed={() => { const req = sudoOpen; setSudoOpen(null); req?.confirm(); }} />
      </div>
    </OutboxContext.Provider>
  );
}
