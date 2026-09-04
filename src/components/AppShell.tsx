import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, ChevronsLeft, ChevronsRight, CloudOff, Command, LogOut, Menu as MenuIcon, Moon, Plus, RefreshCw, Search, Sun, WifiOff, X } from 'lucide-react';
import { NAV } from '@/config/nav';
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

const TITLES: Array<[string, string]> = [['/records', 'Records'], ['/work', 'Work'], ['/goals', 'Goals'], ['/career', 'Career'], ['/readiness', 'Readiness'], ['/reports', 'Reports'], ['/team', 'Team'], ['/maradmins', 'MARADMINs'], ['/assist', 'AI assist'], ['/settings', 'Settings'], ['/operator', 'Owner console'], ['/help', 'Help']];
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

export default function AppShell() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const savePrefs = useSavePrefs();
  const location = useLocation();
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
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-label="Primary">
      {visibleNav.filter((i) => !i.secondary).map((item) => (
        <Tooltip key={item.to} content={collapsed && !mobile ? item.label : null} side="right">
          <NavLink to={item.to} end={item.end} className={cn('nav-item', collapsed && !mobile && 'justify-center px-0')} aria-current={location.pathname === item.to || (!item.end && location.pathname.startsWith(item.to)) ? 'page' : undefined}>
            <item.icon className="h-[18px] w-[18px] shrink-0 opacity-90" strokeWidth={1.75} />
            {(!collapsed || mobile) && <span className="truncate">{item.label}</span>}
          </NavLink>
        </Tooltip>
      ))}
      <div className="my-2 border-t border-rail-ink/10" />
      {visibleNav.filter((i) => i.secondary).map((item) => (
        <Tooltip key={item.to} content={collapsed && !mobile ? item.label : null} side="right">
          <NavLink to={item.to} className={cn('nav-item', collapsed && !mobile && 'justify-center px-0')} aria-current={location.pathname.startsWith(item.to) ? 'page' : undefined}>
            <item.icon className="h-[18px] w-[18px] shrink-0 opacity-90" strokeWidth={1.75} />
            {(!collapsed || mobile) && <span className="truncate">{item.label}</span>}
          </NavLink>
        </Tooltip>
      ))}
    </nav>
  );

  return (
    <OutboxContext.Provider value={{ pending, flush }}>
      <div className="flex min-h-screen bg-canvas">
        <a href="#main" className="skip-link">Skip to content</a>
        <aside className={cn('no-print sticky top-0 hidden h-screen shrink-0 flex-col bg-rail text-rail-ink transition-[width] duration-200 ease-[cubic-bezier(.22,.8,.32,1)] lg:flex', collapsed ? 'w-[68px]' : 'w-[244px]')}>
          <div className={cn('flex h-16 items-center gap-3 px-4', collapsed && 'justify-center px-0')}>
            <img src="/mark.svg" alt="Vantage" width={32} height={32} className="h-8 w-8" />
            {!collapsed && <div className="min-w-0"><p className="text-[13px] font-bold tracking-[0.18em] text-rail-ink">VANTAGE</p><p className="truncate text-2xs text-rail-ink/55">{identity?.instance.organizationName}</p></div>}
          </div>
          {navList(false)}
          <div className="border-t border-rail-ink/10 p-2">
            <button type="button" onClick={toggleRail} className="nav-item w-full justify-center" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /><span className="text-xs">Collapse</span></>}
            </button>
          </div>
        </aside>

        {drawer && (
          <div className="no-print fixed inset-0 z-50 lg:hidden">
            <button type="button" className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-in" onClick={() => setDrawer(false)} aria-label="Close menu" />
            <aside className="absolute inset-y-0 left-0 flex w-[min(86vw,300px)] flex-col bg-rail text-rail-ink shadow-modal animate-slide-in-left">
              <div className="flex h-16 items-center gap-3 border-b border-rail-ink/10 px-4">
                <img src="/mark.svg" alt="" width={32} height={32} className="h-8 w-8" />
                <div className="min-w-0"><p className="text-[13px] font-bold tracking-[0.18em] text-rail-ink">VANTAGE</p><p className="truncate text-2xs text-rail-ink/55">{user ? `${user.first_name} ${user.last_name}` : ''}</p></div>
                <button type="button" onClick={() => setDrawer(false)} className="ml-auto rounded-md p-2 text-rail-ink/70 hover:bg-rail-ink/10 hover:text-rail-ink" aria-label="Close menu"><X className="h-4 w-4" /></button>
              </div>
              {navList(true)}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line/70 bg-canvas/85 px-3 backdrop-blur-md sm:px-5 lg:px-8">
            <button type="button" className="rounded-md p-2 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><MenuIcon className="h-5 w-5" /></button>
            <h1 className="min-w-0 truncate text-sm font-semibold tracking-[-0.005em] text-ink-2">{titleFor(location.pathname)}</h1>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!online && <Tooltip content="Offline. New entries queue on this device."><span className="flex h-9 items-center gap-1.5 rounded-md bg-warn/10 px-2 text-xs font-medium text-warn"><WifiOff className="h-4 w-4" /><span className="hidden sm:inline">Offline</span></span></Tooltip>}
              {online && pending > 0 && <button type="button" onClick={flush} className="flex h-9 items-center gap-1.5 rounded-md bg-info/10 px-2 text-xs font-medium text-info hover:brightness-95"><CloudOff className="h-4 w-4" />{pending} queued</button>}
              <button type="button" onClick={() => setPalette(true)} className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm text-ink-3 shadow-card transition-colors hover:border-line-strong hover:text-ink" aria-label="Search">
                <Command className="hidden h-4 w-4 md:block" aria-hidden /><Search className="h-4 w-4 md:hidden" aria-hidden /><span className="hidden md:inline">Search…</span><span className="hidden lg:inline"><Kbd>⌘K</Kbd></span>
              </button>
              <Button variant="primary" size="sm" onClick={() => openQuickLog('')} className="h-9" aria-label="Log activity"><Plus className="h-4 w-4" /><span className="hidden xl:inline">Log activity</span></Button>
              <NotificationBell onNavigate={(to) => navigate(to)} />
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="flex h-9 w-9 items-center justify-center rounded-full bg-rail text-xs font-bold text-rail-ink ring-2 ring-canvas" aria-label="Account menu">{initials(user?.first_name, user?.last_name)}</button>
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

          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:px-10 lg:pb-16 lg:pt-8">
            {updateReady && (
              <div role="status" className="no-print page mb-4 flex items-center gap-3 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-ink">
                <RefreshCw className="h-4 w-4 text-info" /><span className="flex-1">A new version of Vantage is ready.</span>
                <Button size="xs" onClick={() => { navigator.serviceWorker?.getRegistration().then((r) => r?.waiting?.postMessage('skip-waiting')); setTimeout(() => window.location.reload(), 300); }}>Reload</Button>
              </div>
            )}
            {identity?.instance.announcement && (
              <div role="status" className="no-print page mb-4 flex items-start gap-2 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 text-sm text-ink">
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
