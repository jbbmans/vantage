import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Plus, Command, Menu, X, Moon, Sun, ShieldCheck, Keyboard, LogOut, AlertTriangle } from 'lucide-react';
import { NAV } from '@/config/nav';
import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/components/ui/primitives';
import { TapeStrip } from '@/components/FiscalTape';
import QuickLog from '@/components/QuickLog';
import CommandPalette from '@/components/CommandPalette';
import ShortcutsDialog from '@/components/ShortcutsDialog';
import { useActivities, useIdentity, useCanLead, signOut, unitPath, canAnywhere, PERMISSIONS, useLoadError, refreshAll } from '@/store/useStore';
import { fiscalQuarterRange, fiscalYearProgress, daysSinceLastActivity, currentStreak } from '@/lib/metrics';


function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('vantage.theme') || 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('vantage.theme', theme);
    } catch { /* private browsing */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

/** Tracks connectivity purely to label the header honestly. Nothing depends on it. */
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

/**
 * Finding 44: a failed refresh mid-session must announce itself. The records
 * on screen are the last loaded copy — real, but possibly stale — and that is
 * a different situation from "no data", which is what silence would imply.
 */
function RefreshFailedBanner() {
  const error = useLoadError();
  if (!error) return null;
  return (
    <div className="no-print mb-3 flex items-center gap-2.5 rounded border border-signal/40 bg-signal/[0.08] px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-signal" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-2">
        Couldn't refresh from the server — you are looking at the last loaded copy. New saves may not go through until
        the connection recovers.
      </p>
      <button
        type="button"
        onClick={() => refreshAll()}
        className="shrink-0 rounded border border-rule px-2 py-1 text-2xs text-text-2 hover:border-signal/50 hover:text-text"
      >
        Retry
      </button>
    </div>
  );
}

export default function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const [quickLog, setQuickLog] = useState(false);
  // Text carried over from the command palette's "Log …" action. Without this
  // the palette dropped whatever you'd typed and opened an empty dialog.
  const [quickLogSeed, setQuickLogSeed] = useState('');
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const online = useOnline();
  const location = useLocation();
  const navigate = useNavigate();
  const activities = useActivities();
  const identity = useIdentity();
  const canLead = useCanLead();

  useEffect(() => setDrawer(false), [location.pathname]);

  const openQuickLog = useCallback((text = '') => {
    setQuickLogSeed(typeof text === 'string' ? text : '');
    setQuickLog(true);
  }, []);

  /* Keyboard: ⌘K palette, N quick log, G-then-key navigation. */
  const handleKeys = useCallback(
    (e) => {
      const tag = e.target?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (typing) return;

      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        openQuickLog('');
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setShortcuts((s) => !s);
        return;
      }
      if (e.key === 'g') {
        const onSecond = (ev) => {
          const hit = NAV.find((n) => n.key.endsWith(ev.key));
          if (hit) {
            ev.preventDefault();
            navigate(hit.to);
          }
          window.removeEventListener('keydown', onSecond, true);
        };
        window.addEventListener('keydown', onSecond, true);
        setTimeout(() => window.removeEventListener('keydown', onSecond, true), 1200);
      }
    },
    [navigate, openQuickLog]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  }, [handleKeys]);

  const fq = fiscalQuarterRange();
  const fyp = fiscalYearProgress();
  const idle = daysSinceLastActivity(activities);
  const streak = currentStreak(activities);

  const visibleNav = NAV.filter((item) => {
    if (item.requiresLead && !canLead) return false;
    if (item.requires && !canAnywhere(PERMISSIONS[item.requires])) return false;
    return true;
  });

  const rail = (
    <div className="flex h-full flex-col">
      <div className="flex h-11 items-center gap-2 border-b border-rule px-3">
        <ShieldCheck className="h-4 w-4 text-signal" />
        <span className="font-mono text-sm font-semibold tracking-[0.2em] text-text">VANTAGE</span>
        <button
          className="ml-auto text-text-3 hover:text-text lg:hidden"
          onClick={() => setDrawer(false)}
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {identity?.user && (
        <div className="border-b border-rule px-3 py-2">
          <p className="truncate text-base text-text">
            <span className="text-signal">{identity.user.rank?.abbr || ''}</span> {identity.user.last_name}
          </p>
          <p className="truncate text-2xs text-text-3">
            {identity.assignments?.[0]?.billet_title || 'No billet assigned'}
          </p>
          <p className="truncate text-2xs text-text-3">
            {unitPath(identity.assignments?.[0]?.unit_id).map((u) => u.short_name || u.name).join(' › ')}
          </p>
          {identity.roles?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {identity.roles.slice(0, 3).map((r) => (
                <span
                  key={`${r.id}-${r.unit_id}`}
                  className="flex items-center gap-1 rounded-sm border border-rule px-1 py-0.5 text-2xs text-text-2"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.color || '#8D98A8' }} />
                  {r.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 overflow-y-auto p-2">
        {visibleNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-2.5 rounded px-2.5 py-1.5 text-base transition-colors',
                isActive ? 'bg-panel-2 text-text' : 'text-text-2 hover:bg-panel-2/60 hover:text-text'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-signal" />}
                <item.icon className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-signal' : 'text-text-3')} />
                <span className="flex-1">{item.label}</span>
                <kbd className="font-mono text-2xs text-text-3 opacity-0 transition-opacity group-hover:opacity-100">
                  {item.key.toUpperCase()}
                </kbd>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* FY progress read-out — the rail's own instrument */}
      <div className="border-t border-rule px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">{fq.label}</span>
          <span className="fig text-2xs text-text-3">
            D+{fyp.elapsed}/{fyp.total}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-rule/60">
          <div className="h-full bg-signal/70" style={{ width: `${fyp.fraction * 100}%` }} />
        </div>
        <div className="mt-2">
          <TapeStrip activities={activities} />
        </div>
        <div className="fig mt-2 flex items-center justify-between text-2xs text-text-3">
          <span>
            streak <span className="text-text">{streak}d</span>
          </span>
          <span className={cn(idle !== null && idle >= 3 && 'text-signal')}>
            {idle === null ? 'no entries' : idle === 0 ? 'logged today' : `idle ${idle}d`}
          </span>
        </div>
      </div>

      <div className="border-t border-rule p-2">
        <Button variant="primary" size="sm" className="w-full justify-center" onClick={() => openQuickLog('')}>
          <Plus className="h-3.5 w-3.5" />
          Log
          <kbd className="ml-auto font-mono text-2xs opacity-70">N</kbd>
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-ink">
      <aside className="no-print sticky top-0 hidden h-screen w-rail shrink-0 border-r border-rule bg-panel lg:flex lg:flex-col">
        {rail}
      </aside>

      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 h-full w-rail border-r border-rule bg-panel animate-fade-up">
            {rail}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-rule bg-ink/85 px-3 backdrop-blur-md lg:px-5">
          <button className="text-text-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Menu className="h-4 w-4" />
          </button>

          <Tooltip content={online ? 'Connected to your command server.' : 'No connection — changes cannot be saved right now.'}>
            <span className="fig hidden cursor-help items-center gap-2 text-2xs text-text-3 sm:flex">
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full', online ? 'bg-ledger' : 'bg-redline')} />
              {online ? 'CONNECTED' : 'NO CONNECTION'}
            </span>
          </Tooltip>

          <div className="flex-1" />


          <button
            onClick={() => setPalette(true)}
            className="flex h-7 items-center gap-2 rounded border border-rule bg-panel px-2 text-xs text-text-3 transition-colors hover:border-rule-strong hover:text-text-2"
          >
            <Command className="h-3 w-3" />
            <span className="hidden sm:inline">Search or jump</span>
            <kbd className="fig ml-1 rounded border border-rule px-1 text-2xs">⌘K</kbd>
          </button>

          <Tooltip content="Keyboard shortcuts — ?">
            <Button variant="ghost" size="icon-sm" onClick={() => setShortcuts(true)} aria-label="Keyboard shortcuts">
              <Keyboard className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>

          <Tooltip content={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
            <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
          </Tooltip>

          <Tooltip content="Sign out">
            <Button variant="ghost" size="icon-sm" onClick={() => signOut()} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>

          <Button variant="primary" size="sm" onClick={() => openQuickLog('')}>
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Log activity</span>
          </Button>
        </header>

        <main className="flex-1 px-3 py-4 lg:px-5 lg:py-5">
          <RefreshFailedBanner />
          <Outlet />
        </main>

        <footer className="no-print border-t border-rule px-3 py-2 lg:px-5">
          <p className="fig text-2xs text-text-3">
            VANTAGE v3.0 · BUILT BY JOHN BERNARD BOLETZ · RECORDS HELD ON YOUR COMMAND SERVER
          </p>
        </footer>
      </div>

      <QuickLog open={quickLog} onOpenChange={setQuickLog} initialText={quickLogSeed} />
      <CommandPalette open={palette} onOpenChange={setPalette} onQuickLog={openQuickLog} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </div>
  );
}
