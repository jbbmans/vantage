import React, { useCallback, useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bell, CheckCheck, CircleAlert, GraduationCap, Megaphone, X } from 'lucide-react';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';

const ICONS = {
  maradmin: Megaphone,
  rank_request: GraduationCap,
  profile: GraduationCap,
};

function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(time));
}

export default function NotificationCenter({ onNavigate, online = true }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ rows: [], unread: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.notifications();
      setState({ rows: next.rows || [], unread: next.unread || 0 });
    } catch {
      if (!quiet) setState((current) => ({ ...current, error: true }));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ quiet: true }), 60_000);
    const refresh = () => load({ quiet: true });
    const reveal = () => setOpen(true);
    window.addEventListener('vantage:notifications-refresh', refresh);
    window.addEventListener('vantage:open-notifications', reveal);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('vantage:notifications-refresh', refresh);
      window.removeEventListener('vantage:open-notifications', reveal);
    };
  }, [load]);

  useEffect(() => { if (open) load({ quiet: true }); }, [open, load]);

  const openNotification = async (row) => {
    if (!row.read_at) {
      setState((current) => ({
        rows: current.rows.map((item) => item.id === row.id ? { ...item, read_at: new Date().toISOString() } : item),
        unread: Math.max(0, current.unread - 1),
      }));
      api.markNotificationRead(row.id).catch(() => load({ quiet: true }));
    }
    setOpen(false);
    if (row.kind === 'rank_request') window.dispatchEvent(new CustomEvent('vantage:rank-requests-refresh'));
    if (row.action_url) onNavigate?.(row.action_url);
  };

  const markAll = async () => {
    setState((current) => ({
      rows: current.rows.map((row) => ({ ...row, read_at: row.read_at || new Date().toISOString() })),
      unread: 0,
    }));
    try { await api.markAllNotificationsRead(); }
    catch { load({ quiet: true }); }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex h-10 w-10 items-center justify-center rounded-lg text-text-3 transition hover:bg-panel-2 hover:text-text"
          aria-label={state.unread ? `Notifications, ${state.unread} unread` : 'Notifications'}
        >
          <Bell className={cn('h-[18px] w-[18px]', state.unread > 0 && 'animate-bell-ring text-signal')} />
          {state.unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-redline px-1 text-[9px] font-bold leading-none text-white ring-2 ring-panel">
              {state.unread > 9 ? '9+' : state.unread}
            </span>
          )}
          {!online && <span className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-redline ring-2 ring-panel" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={10}
          className="z-50 w-[min(calc(100vw-1rem),390px)] overflow-hidden rounded-xl border border-rule bg-panel shadow-[var(--shadow-lg)] data-[state=open]:animate-notification-in"
        >
          <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-md font-semibold text-text">Notifications</p>
              <p className="text-xs text-text-3">{state.unread ? `${state.unread} unread` : 'You’re caught up'}</p>
            </div>
            {state.unread > 0 && (
              <button type="button" onClick={markAll} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-3 hover:bg-panel-2 hover:text-text">
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
            <Popover.Close className="rounded-md p-1.5 text-text-3 hover:bg-panel-2 hover:text-text" aria-label="Close notifications">
              <X className="h-4 w-4" />
            </Popover.Close>
          </header>

          <div className="max-h-[min(64vh,520px)] overflow-y-auto">
            {loading ? (
              <div className="space-y-2 p-3" role="status" aria-label="Loading notifications">
                {[0, 1, 2].map((item) => <div key={item} className="skeleton h-16 rounded-lg" />)}
              </div>
            ) : state.error ? (
              <div className="flex items-center gap-2 px-4 py-8 text-sm text-text-3">
                <CircleAlert className="h-4 w-4 text-redline" /> Notifications could not be loaded.
              </div>
            ) : state.rows.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-panel-2 text-text-3"><Bell className="h-4 w-4" /></span>
                <p className="mt-3 text-sm font-medium text-text">Nothing new</p>
                <p className="mt-1 text-xs text-text-3">Rank requests, MARADMIN updates, and account changes will appear here.</p>
              </div>
            ) : (
              state.rows.map((row) => {
                const Icon = ICONS[row.kind] || Bell;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openNotification(row)}
                    className={cn(
                      'group flex w-full items-start gap-3 border-b border-rule px-4 py-3 text-left last:border-0 hover:bg-panel-2/70',
                      !row.read_at && 'bg-signal/[0.055]'
                    )}
                  >
                    <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', row.read_at ? 'bg-panel-2 text-text-3' : 'bg-signal/10 text-signal')}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-2">
                        <span className={cn('min-w-0 flex-1 text-sm', row.read_at ? 'font-medium text-text-2' : 'font-semibold text-text')}>{row.title}</span>
                        <span className="fig shrink-0 text-2xs text-text-3">{relativeTime(row.created_at)}</span>
                      </span>
                      {row.message && <span className="mt-0.5 block text-xs leading-relaxed text-text-3">{row.message}</span>}
                    </span>
                    {!row.read_at && <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-signal" aria-label="Unread" />}
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
