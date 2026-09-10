import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { installTelemetry, track } from '@/lib/telemetry';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, ChevronsLeft, ChevronsRight, CloudOff, Command, LogOut, Menu as MenuIcon, Moon, Plus, RefreshCw, Search, Sun, WifiOff, X } from 'lucide-react';
import { NAV, NAV_GROUPS } from '@/config/nav';
import { cn, initials, timeAgo } from '@/lib/utils';
import { Button, Tooltip, Kbd } from '@/components/ui/primitives';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import * as Popover from '@radix-ui/react-popover';
import QuickLog from '@/components/QuickLog';
import CommandPalette from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import SudoDialog, { type SudoRequest } from '@/components/SudoDialog';
import ErrorBoundary from '@/components/ErrorBoundary';
import { useIdentity, useNotifications, useSavePrefs, signOutEverywhere, keys } from '@/lib/queries';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { flushOutbox, onOutboxChange, outbox } from '@/lib/outbox';
import { resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';

const TITLES: Array<[string, string]> = [['/records', 'Records'], ['/queue', 'Queue'], ['/work', 'Tasks'], ['/goals', 'Goals'], ['/correspondence', 'Correspondence'], ['/studio', 'Report Studio'], ['/career', 'Career'], ['/readiness', 'Readiness'], ['/reports', 'Analysis'], ['/team', 'Team'], ['/maradmins', 'MARADMINs'], ['/settings', 'Settings'], ['/operator', 'Owner console'], ['/help', 'Help']];
const titleFor = (p: string) => (p === '/' ? 'Dashboard' : TITLES.find(([path]) => p.startsWith(path))?.[1] || 'Vantage');

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
function surfaceOf(pathname: string): string {
  const segment = pathname.split('/')[1] || '';
  const map: Record<string, string> = {
    '': 'dashboard', records: 'records', queue: 'queue', work: 'tasks', goals: 'goals',
    correspondence: 'correspondence', studio: 'studio', reports: 'reports', career: 'career',
    readiness: 'readiness', team: 'team', settings: 'settings', operator: 'operator', help: 'help',
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
  useEffect(() => { track('surface.viewed', { surface: surfaceOf(location.pathname) }); }, [location.pathname]);
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

  const visibleNav = useMemo(() => NAV.filter((item) => {
    if (item.requiresLead && !identity?.canLead) return false;
    if (item.requiresOperator && !identity?.user.is_operator) return false;
    if (item.requiresAi && !identity?.instance.aiEnabled) return false;
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

  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); savePrefs.mutate({ theme: next }); };
  const toggleRail = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('vantage.rail', n ? 'collapsed' : 'open'); } catch {} return n; });
  const user = identity?.user;
  const primary = identity?.memberships.find((m) => m.is_primary) || identity?.memberships[0];

  const navList = (mobile: boolean) => (
    <nav className="flex-1 overflow-y-auto py-1" aria-label="Primary">
      {NAV_GROUPS.map((group) => {
        const items = visibleNav.filter((i) => i.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="mb-1">
            {(!collapsed || mobile) && group !== 'More' && (
              <p className="border-b border-rail-ink/12 px-3 pb-1 pt-2 font-mono text-2xs font-medium uppercase tracking-[0.16em] text-rail-ink/65">{group}</p>
            )}
            {group === 'More' && <div className="my-2 border-t border-rail-ink/12" />}
            <div>
              {items.map((item) => (
                <Tooltip key={item.to} content={collapsed && !mobile ? item.label : null} side="right">
                  <NavLink to={item.to} end={item.end} className={cn('nav-item', collapsed && !mobile && 'justify-center px-0')} aria-current={location.pathname === item.to || (!item.end && location.pathname.startsWith(item.to)) ? 'page' : undefined}>
                    <item.icon className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
                    {(!collapsed || mobile) && <span className="truncate">{item.label}</span>}
                  </NavLink>
                </Tooltip>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );

  return (
    <OutboxContext.Provider value={{ pending, flush }}>
      <div className="flex min-h-screen bg-canvas">
        <a href="#main" className="skip-link">Skip to content</a>
        <aside className={cn('no-print sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line-strong bg-rail text-rail-ink transition-[width] duration-150 lg:flex', collapsed ? 'w-[56px]' : 'w-[212px]')}>
          <div className={cn('flex h-11 items-center gap-2.5 border-b border-rail-ink/12 px-3', collapsed && 'justify-center px-0')}>
            <img src="/mark.svg" alt="Vantage" width={22} height={22} className="h-[22px] w-[22px]" />
            {!collapsed && <div className="min-w-0"><p className="font-mono text-2xs font-bold tracking-[0.24em] text-rail-ink">VANTAGE</p><p className="truncate font-mono text-2xs tracking-[0.06em] text-rail-ink/65">{identity?.instance.organizationName}</p></div>}
          </div>
          {navList(false)}
          <div className="border-t border-rail-ink/12">
            <button type="button" onClick={toggleRail} className="nav-item w-full justify-center" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
              {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <><ChevronsLeft className="h-3.5 w-3.5" /><span>Collapse</span></>}
            </button>
          </div>
        </aside>

        {drawer && (
          <div className="no-print fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-ink/60 animate-fade-in" onClick={() => setDrawer(false)} aria-label="Close menu" />
            <aside className="absolute inset-y-0 left-0 flex w-[min(86vw,272px)] flex-col border-r border-line-strong bg-rail text-rail-ink animate-slide-in-left">
              <div className="flex h-11 items-center gap-2.5 border-b border-rail-ink/12 px-3">
                <img src="/mark.svg" alt="" width={22} height={22} className="h-[22px] w-[22px]" />
                <div className="min-w-0"><p className="font-mono text-2xs font-bold tracking-[0.24em] text-rail-ink">VANTAGE</p><p className="truncate font-mono text-2xs text-rail-ink/65">{user ? `${user.first_name} ${user.last_name}` : ''}</p></div>
                <button type="button" onClick={() => setDrawer(false)} className="ml-auto p-2 text-rail-ink/70 hover:bg-rail-ink/10 hover:text-rail-ink" aria-label="Close menu"><X className="h-4 w-4" /></button>
              </div>
              {navList(true)}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-line-strong bg-canvas px-3 sm:px-4 lg:px-6">
            <button type="button" className="p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-4 w-4" /></button>
            <h1 className="min-w-0 truncate font-mono text-2xs font-medium uppercase tracking-[0.14em] text-ink-2">{titleFor(location.pathname)}</h1>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!online && <Tooltip content="Offline. New entries queue on this device."><span className="flex h-7 items-center gap-1.5 border border-warn px-2 font-mono text-2xs uppercase tracking-wider text-warn"><WifiOff className="h-3.5 w-3.5" /><span className="hidden sm:inline">Offline</span></span></Tooltip>}
              {online && pending > 0 && <button type="button" onClick={flush} className="flex h-7 items-center gap-1.5 border border-info px-2 font-mono text-2xs uppercase tracking-wider text-info hover:bg-info hover:text-canvas"><CloudOff className="h-3.5 w-3.5" />{pending} queued</button>}
              <button type="button" onClick={() => setPalette(true)} className="flex h-7 items-center gap-2 border border-line bg-surface px-2.5 font-mono text-2xs uppercase tracking-[0.1em] text-ink-3 transition-colors hover:border-line-strong hover:text-ink" aria-label="Search">
                <Command className="hidden h-3.5 w-3.5 md:block" aria-hidden /><Search className="h-3.5 w-3.5 md:hidden" aria-hidden /><span className="hidden md:inline">Search</span><span className="hidden lg:inline"><Kbd>⌘K</Kbd></span>
              </button>
              <Button variant="primary" size="sm" onClick={() => openQuickLog('')} aria-label="Log activity"><Plus className="h-3.5 w-3.5" /><span className="hidden xl:inline">Log activity</span></Button>
              <NotificationBell onNavigate={(to) => navigate(to)} />
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="flex h-7 w-7 items-center justify-center border border-line-strong bg-rail font-mono text-2xs font-bold text-rail-ink" aria-label="Account menu">{initials(user?.first_name, user?.last_name)}</button>
                </MenuTrigger>
                <MenuContent>
                  <div className="border-b border-line px-2.5 pb-2 pt-1">
                    <p className="truncate text-sm font-semibold text-ink">{user?.rank?.abbr} {user?.first_name} {user?.last_name}</p>
                    <p className="truncate text-xs text-ink-3">{primary ? `${primary.billet ? `${primary.billet} · ` : ''}${primary.unit_short || primary.unit_name}` : 'No unit yet'}</p>
                  </div>
                  <MenuItem onSelect={() => navigate('/settings')}>Settings</MenuItem>
                  {user?.is_operator ? <MenuItem onSelect={() => navigate('/operator')}>Owner console</MenuItem> : null}
                  <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? Sun : Moon}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</MenuItem>
                  <MenuItem onSelect={() => setShortcuts(true)}>Keyboard shortcuts</MenuItem>
                  <MenuSeparator />
                  <MenuItem danger icon={LogOut} onSelect={() => signOutEverywhere()}>Sign out</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </header>

          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-3 pb-24 pt-4 outline-none sm:px-4 lg:px-6 lg:pb-12 lg:pt-5">
            {updateReady && (
              <div role="status" className="no-print page mb-3 flex items-center gap-2.5 border-l-2 border-l-info border-y border-r border-line bg-surface px-3 py-2 text-sm text-ink">
                <RefreshCw className="h-4 w-4 text-info" /><span className="flex-1">A new version of Vantage is ready.</span>
                <Button size="xs" onClick={() => { navigator.serviceWorker?.getRegistration().then((r) => r?.waiting?.postMessage('skip-waiting')); setTimeout(() => window.location.reload(), 300); }}>Reload</Button>
              </div>
            )}
            {identity?.instance.announcement && (
              <div role="status" className="no-print page mb-3 flex items-start gap-2 border-l-2 border-l-accent border-y border-r border-line bg-surface px-3 py-2 text-sm text-ink">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span>{identity.instance.announcement}</span>
              </div>
            )}
            <ErrorBoundary resetKey={location.pathname + location.search}><div key={location.pathname} className="animate-fade-up"><Outlet /></div></ErrorBoundary>
          </main>
          <footer className="no-print px-5 py-3 text-2xs text-ink-3 lg:px-10">Vantage v{VERSION} · Records stay on this deployment's server.</footer>
        </div>

        <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
        <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} nav={visibleNav} />
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <SudoDialog open={Boolean(sudoOpen)} onOpenChange={(o) => { if (!o) { sudoOpen?.cancel(); setSudoOpen(null); } }} onConfirmed={() => { const req = sudoOpen; setSudoOpen(null); req?.confirm(); }} />
      </div>
    </OutboxContext.Provider>
  );
}
