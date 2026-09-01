import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import {
  AlertTriangle,
  Command,
  HelpCircle,
  Keyboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { NAV } from '@/config/nav';
import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/components/ui/primitives';
import QuickLog from '@/components/QuickLog';
import CommandPalette from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import NotificationCenter from '@/components/NotificationCenter';
import {
  PERMISSIONS,
  canAnywhere,
  refreshAll,
  signOut,
  unitPath,
  useCanLead,
  useIdentity,
  useLoadError,
  usePrefs,
  setPref,
} from '@/store/useStore';
import packageJson from '../../package.json';
import { useToast } from '@/components/ui/toast';
import { configuration, trackExperience } from '@/lib/api';

const PRIMARY_NAV = new Set(['/', '/activities', '/work', '/career', '/maradmins', '/team', '/reports']);

const PAGE_TITLES = [
  ['/activities', 'Records'],
  ['/readiness', 'Readiness'],
  ['/team', 'Team'],
  ['/work', 'Work'],
  ['/goals', 'Goals'],
  ['/career', 'Career'],
  ['/maradmins', 'MARADMINs'],
  ['/reports', 'Reports'],
  ['/units', 'Units'],
  ['/help', 'Help'],
  ['/settings', 'Settings'],
  ['/operator', 'Owner console'],
];

function titleFor(pathname) {
  if (pathname === '/') return 'Command';
  return PAGE_TITLES.find(([path]) => pathname.startsWith(path))?.[1] || 'Vantage';
}

function readableDate() {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());
}

function resolvedTheme(mode) {
  if (mode !== 'system') return mode === 'dark' ? 'dark' : 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme(preferredTheme) {
  const [mode, setMode] = useState(() => {
    try {
      return preferredTheme || localStorage.getItem('vantage.theme') || 'light';
    } catch {
      return preferredTheme || 'light';
    }
  });
  const [theme, setResolved] = useState(() => resolvedTheme(mode));

  useEffect(() => {
    if (preferredTheme) setMode(preferredTheme);
  }, [preferredTheme]);

  useEffect(() => {
    const apply = () => {
      const next = resolvedTheme(mode);
      setResolved(next);
      document.documentElement.setAttribute('data-theme', next);
    };
    apply();
    try {
      localStorage.setItem('vantage.theme', mode);
    } catch {
      setResolved(resolvedTheme(mode));
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (mode === 'system') media?.addEventListener?.('change', apply);
    return () => media?.removeEventListener?.('change', apply);
  }, [mode]);

  useEffect(() => {
    const update = (event) => setMode(event.detail || 'light');
    window.addEventListener('vantage:theme', update);
    return () => window.removeEventListener('vantage:theme', update);
  }, []);

  return [theme, setMode];
}

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}

function RefreshFailedBanner() {
  const error = useLoadError();
  if (!error) return null;

  return (
    <div className="no-print mb-4 flex items-center gap-3 rounded-md border border-redline/30 bg-redline/[0.06] px-4 py-3">
      <AlertTriangle className="h-4 w-4 shrink-0 text-redline" />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-text-2">
        Vantage could not refresh. You are seeing the last loaded copy, and new saves may fail until the connection returns.
      </p>
      <Button variant="outline" size="sm" onClick={() => refreshAll()}>
        Retry
      </Button>
    </div>
  );
}

function RailLink({ item, mobile = false }) {
  const location = useLocation();
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => {
        const active = isActive || (!mobile && item.activeOn?.some((path) => location.pathname.startsWith(path)));
        return cn(
          'group relative flex transition-[color,background-color,transform] duration-150 active:scale-[0.98]',
          mobile
            ? 'items-center gap-3 rounded-md px-3 py-2.5 text-base'
            : 'h-[72px] flex-col items-center justify-center gap-1.5 px-2 text-xs',
          active
            ? mobile
              ? 'bg-panel-2 text-signal'
              : 'bg-[#dceaf5] text-[#1767b5]'
            : mobile
              ? 'text-text-2 hover:bg-panel-2 hover:text-text'
              : 'text-white/70 hover:bg-white/[0.07] hover:text-white'
        );
      }}
    >
      {({ isActive }) => {
        const active = isActive || (!mobile && item.activeOn?.some((path) => location.pathname.startsWith(path)));
        return (
          <>
          {active && (
            <span
              aria-hidden
              className={cn(
                'absolute bg-signal',
                mobile ? 'inset-y-2 left-0 w-0.5 rounded-full' : 'inset-y-4 left-0 w-[3px] rounded-r-full'
              )}
            />
          )}
          <item.icon className={cn(mobile ? 'h-4 w-4' : 'h-[22px] w-[22px]', active && 'text-signal')} />
          <span className={cn(!mobile && 'max-w-full truncate')}>{item.label}</span>
          </>
        );
      }}
    </NavLink>
  );
}

export default function AppShell() {
  const toast = useToast();
  const identity = useIdentity();
  const canLead = useCanLead();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const prefs = usePrefs();
  const [theme, setThemeMode] = useTheme(prefs.interface?.theme);
  const [drawer, setDrawer] = useState(false);
  const [quickLog, setQuickLog] = useState(false);
  const [quickLogSeed, setQuickLogSeed] = useState('');
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [instanceConfig, setInstanceConfig] = useState(null);

  useEffect(() => {
    configuration().then(setInstanceConfig).catch(() => setInstanceConfig(null));
  }, []);

  useEffect(() => {
    setDrawer(false);
    if (!location.hash) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      return undefined;
    }
    const targetId = location.hash.slice(1);
    let attempts = 0;
    let timer;
    const reveal = () => {
      const target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else if (attempts++ < 10) timer = window.setTimeout(reveal, 50);
    };
    reveal();
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', prefs.interface?.density || 'comfortable');
  }, [prefs.interface?.density]);

  useEffect(() => {
    const event = location.pathname === '/' ? 'page_command'
      : location.pathname.startsWith('/activities') ? 'page_records'
        : location.pathname.startsWith('/work') ? 'page_work'
          : location.pathname.startsWith('/career') ? 'page_career'
            : location.pathname.startsWith('/team') ? 'page_team'
              : location.pathname.startsWith('/reports') ? 'page_reports'
                : location.pathname.startsWith('/settings') ? 'page_settings'
                  : null;
    if (event) trackExperience(event);
  }, [location.pathname]);

  const openQuickLog = useCallback((text = '') => {
    setQuickLogSeed(typeof text === 'string' ? text : '');
    setQuickLog(true);
    trackExperience('quick_log_opened');
  }, []);

  useEffect(() => {
    const handleOpenQuickLog = (event) => openQuickLog(event.detail || '');
    window.addEventListener('vantage:open-quick-log', handleOpenQuickLog);
    return () => window.removeEventListener('vantage:open-quick-log', handleOpenQuickLog);
  }, [openQuickLog]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemeMode(next);
    setPref('interface', { ...(prefs.interface || {}), theme: next });
  };

  const visibleNav = useMemo(
    () =>
      NAV.filter((item) => {
        if (item.requiresLead && !canLead) return false;
        if (item.requiresOperator && !identity?.isOperator) return false;
        if (item.requires && !canAnywhere(PERMISSIONS[item.requires])) return false;
        return true;
      }),
    [canLead, identity?.isOperator]
  );
  const primaryNav = visibleNav.filter((item) => PRIMARY_NAV.has(item.to));

  const openOperatorConsole = () => {
    const origin = instanceConfig?.deployment?.admin_url;
    if (origin && new URL(origin).origin !== window.location.origin) {
      window.location.assign(`${origin}/operator`);
      return;
    }
    navigate('/operator');
  };

  useEffect(() => {
    const handleKeys = (event) => {
      const tag = event.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((value) => !value);
        return;
      }
      if (typing) return;
      if (event.key === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        openQuickLog('');
      } else if (event.key === '/') {
        event.preventDefault();
        setPalette(true);
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcuts((value) => !value);
      } else if (event.key === 'g') {
        const onSecond = (nextEvent) => {
          const hit = visibleNav.find((item) => item.key.endsWith(nextEvent.key));
          if (hit) {
            nextEvent.preventDefault();
            navigate(hit.to);
          }
          window.removeEventListener('keydown', onSecond, true);
        };
        window.addEventListener('keydown', onSecond, true);
        window.setTimeout(() => window.removeEventListener('keydown', onSecond, true), 1200);
      }
    };

    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  }, [navigate, openQuickLog, visibleNav]);

  const userName = [identity?.user?.first_name, identity?.user?.last_name].filter(Boolean).join(' ');
  const initials = [identity?.user?.first_name, identity?.user?.last_name]
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'V';

  const mobileRail = (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-[calc(68px+env(safe-area-inset-top))] items-center gap-3 border-b border-rule px-5 pt-[env(safe-area-inset-top)]">
        <img src="/mark.svg" alt="" className="h-9 w-9 rounded-md" />
        <div className="min-w-0">
          <p className="font-semibold tracking-[0.16em] text-text">VANTAGE</p>
          <p className="truncate text-xs text-text-3">{userName}</p>
        </div>
        <button type="button" onClick={() => setDrawer(false)} className="ml-auto rounded-md p-2 text-text-3 hover:bg-panel-2" aria-label="Close menu">
          <X className="h-4 w-4" />
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Primary navigation">
        {visibleNav.map((item) => <RailLink key={item.to} item={item} mobile />)}
      </nav>
      <div className="border-t border-rule px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-xs text-text-3">
        {unitPath(identity?.assignments?.[0]?.unit_id).map((unit) => unit.short_name || unit.name).join(' › ') || 'No unit attached'}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-ink">
      <aside className="no-print sticky top-0 hidden h-screen w-rail shrink-0 flex-col bg-[#102a36] lg:flex">
        <div className="flex h-[98px] items-center justify-center border-b border-white/10">
          <img src="/mark.svg" alt="Vantage" className="h-11 w-11 rounded-lg shadow-sm" />
        </div>
        <nav className="flex-1 overflow-y-auto" aria-label="Primary navigation">
          {primaryNav.map((item) => <RailLink key={item.to} item={item} />)}
        </nav>
        <div className="border-t border-white/10 py-2">
          <NavLink to="/help" className="flex h-11 items-center justify-center text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white" aria-label="Help">
            <HelpCircle className="h-5 w-5" />
          </NavLink>
          <NavLink to="/settings" className="flex h-11 items-center justify-center text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white" aria-label="Settings">
            <Settings2 className="h-5 w-5" />
          </NavLink>
        </div>
      </aside>

      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <button type="button" className="absolute inset-0 bg-[#102a36]/50 backdrop-blur-sm animate-fade-in" onClick={() => setDrawer(false)} aria-label="Close menu overlay" />
          <aside className="absolute inset-y-0 left-0 w-[min(88vw,320px)] border-r border-rule shadow-[var(--shadow-lg)] animate-slide-in-left">
            {mobileRail}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-[68px] items-center border-b border-rule bg-panel/95 px-4 backdrop-blur-md lg:px-8">
          <button type="button" className="mr-3 rounded-md p-2 text-text-2 hover:bg-panel-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight text-text sm:text-lg">{titleFor(location.pathname)}</h1>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <span className="hidden text-sm text-text-3 xl:inline">{readableDate()}</span>
            <button type="button" onClick={() => setPalette(true)} className="flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-text-3 transition-colors hover:bg-panel-2 hover:text-text" aria-label="Search or jump">
              <Command className="h-4 w-4" />
              <span className="hidden md:inline">Search or jump</span>
              <kbd className="hidden rounded border border-rule px-1.5 py-0.5 text-2xs lg:inline">⌘K</kbd>
            </button>
            <NotificationCenter online={online} onNavigate={navigate} />
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className="flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-panel-2 text-xs font-semibold text-text" aria-label="Open account menu">
                  {initials}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content sideOffset={10} align="end" className="z-50 w-64 rounded-md border border-rule bg-panel p-2 shadow-[var(--shadow)] animate-scale-in">
                  <div className="border-b border-rule px-2 pb-2 pt-1">
                    <p className="truncate text-sm font-semibold text-text">{userName || 'Vantage account'}</p>
                    <p className="truncate text-xs text-text-3">{identity?.assignments?.[0]?.billet_title || 'No billet assigned'}</p>
                  </div>
                  <div className="space-y-1 pt-2">
                    <button type="button" onClick={() => navigate('/settings')} className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-text-2 hover:bg-panel-2 hover:text-text">
                      <Settings2 className="h-4 w-4" /> Settings
                    </button>
                    {identity?.isOperator && (
                      <button type="button" onClick={openOperatorConsole} className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-text-2 hover:bg-panel-2 hover:text-text">
                        <ShieldCheck className="h-4 w-4" /> Owner console
                      </button>
                    )}
                    <button type="button" onClick={toggleTheme} className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-text-2 hover:bg-panel-2 hover:text-text">
                      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                      {theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
                    </button>
                    <button type="button" onClick={() => setShortcuts(true)} className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-text-2 hover:bg-panel-2 hover:text-text">
                      <Keyboard className="h-4 w-4" /> Keyboard shortcuts
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!await signOut()) toast.error('Sign-out could not be confirmed. Close this browser before leaving the workstation.');
                      }}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-redline hover:bg-redline/10"
                    >
                      <LogOut className="h-4 w-4" /> Sign out
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-10 lg:pb-24 lg:pt-8">
          {instanceConfig?.ui?.announcement && (
            <div role="status" className="no-print page-canvas mb-4 flex items-start gap-2 rounded-lg border border-info/25 bg-info/[0.07] px-3 py-2.5 text-sm text-text-2 animate-fade-up">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
              <span>{instanceConfig.ui.announcement}</span>
            </div>
          )}
          {identity?.deploymentMode !== 'operational' && (
            <div role="status" className="no-print page-canvas mb-4 flex items-center gap-2 rounded-md border border-signal/20 bg-signal/[0.055] px-3 py-2 text-xs text-text-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-signal" />
              <span><strong className="font-semibold text-text">Controlled evaluation.</strong> Use synthetic or specifically authorized test information only.</span>
            </div>
          )}
          <RefreshFailedBanner />
          <div key={`${location.pathname}${location.search}`} className="animate-page-enter">
            <Outlet />
          </div>
        </main>

        <footer className="no-print border-t border-rule px-5 pb-[max(.625rem,env(safe-area-inset-bottom))] pt-2.5 text-2xs text-text-3 lg:px-10">
          VANTAGE v{packageJson.version} · Records remain on this deployment's server
        </footer>
      </div>

      <button
        type="button"
        onClick={() => openQuickLog('')}
        className="no-print fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 inline-flex h-12 items-center gap-2 rounded-full border border-[#0b2230] bg-[#102a36] px-4 text-sm font-medium text-white shadow-[0_18px_38px_-18px_rgba(16,42,54,0.8)] transition hover:-translate-y-0.5 hover:bg-[#173c4c] focus-visible:ring-offset-ink sm:bottom-7 sm:right-7 sm:rounded-md"
      >
        <Plus className="h-4 w-4" />
        Log activity
      </button>

      <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
      <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />

    </div>
  );
}
