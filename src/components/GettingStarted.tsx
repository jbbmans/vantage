import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Check, KeyRound, ShieldCheck, UserRound, PenLine, Users, X } from 'lucide-react';
import { useIdentity, useRecordSummary, useSavePrefs } from '@/lib/queries';
import { useView, viewLabel } from '@/lib/view';
import { cn } from '@/lib/utils';

const seenKey = (userId: string) => `vantage.seen-team.${userId}`;
export const markTeamSeen = (userId: string | undefined) => { if (userId) { try { localStorage.setItem(seenKey(userId), '1'); } catch { /* ignore */ } } };
const teamSeen = (userId: string) => { try { return localStorage.getItem(seenKey(userId)) === '1'; } catch { return false; } };

interface Step { key: string; title: string; hint: string; done: boolean; icon: React.ComponentType<{ className?: string }>; to?: string; onClick?: () => void; action: string }

/**
 * The first week, as a short list that ticks itself off: a password of your own, a second factor, a profile
 * leaders can rely on, a first entry, and a look at your team. It goes away when it is done or dismissed.
 */
export default function GettingStarted() {
  const { data: identity } = useIdentity();
  const { view } = useView(identity);
  const today = new Date().toISOString().slice(0, 10);
  const summary = useRecordSummary({ from: '2000-01-01', to: today });
  const save = useSavePrefs();
  const user = identity?.user;

  const steps: Step[] = useMemo(() => {
    if (!user) return [];
    return [
      { key: 'password', title: 'Your own password', hint: 'Set when you first signed in.', done: true, icon: KeyRound, action: 'Done' },
      { key: 'secure', title: 'Protect your sign-in', hint: 'Add a passkey or an authenticator app, so a password alone is never enough.', done: Boolean(user.passkeys || user.totp_enabled), icon: ShieldCheck, to: '/settings?tab=security', action: 'Secure' },
      { key: 'profile', title: 'Check your profile', hint: 'Rank, MOS and an email for reset links. Rank decides JEPES or FITREP.', done: Boolean(user.rank_id && user.mos && user.email), icon: UserRound, to: '/settings?tab=profile', action: 'Review' },
      { key: 'first', title: 'Log your first activity', hint: 'One sentence is enough. Press N anywhere.', done: (summary.data?.personal?.activities || 0) > 0, icon: PenLine, onClick: () => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' })), action: 'Log one' },
      { key: 'team', title: view ? `Meet ${viewLabel(view)}` : 'Meet your team', hint: 'Who is on your team, the command above it, and the goals you share.', done: teamSeen(user.id), icon: Users, to: '/team', action: 'Open' },
    ];
  }, [user, summary.data, view]);

  if (!identity || identity.demo || identity.prefs?.onboardingDone || summary.isPending) return null;
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const pct = Math.round((done / steps.length) * 100);

  return (
    <section aria-labelledby="getting-started" className="card relative mb-6 overflow-hidden p-0">
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <h2 id="getting-started" className="text-md font-semibold text-ink">Your first week</h2>
          <p className="mt-0.5 text-sm text-ink-2">{done} of {steps.length} done. Each step ticks itself off.</p>
        </div>
        <button type="button" onClick={() => save.mutate({ onboardingDone: true })} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Hide the first-week list"><X className="h-4 w-4" /></button>
      </div>
      <div className="mx-5 mb-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="First week progress">
        <div className="bar-grow h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <ol className="stagger divide-y divide-line border-t border-line">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const action = s.done ? null : s.to
            ? <Link to={s.to} className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft">{s.action}</Link>
            : <button type="button" onClick={s.onClick} className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft">{s.action}</button>;
          return (
            <li key={s.key} className="flex items-center gap-3 px-5 py-3" style={{ '--i': i } as React.CSSProperties}>
              <span className={cn('check-pop flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1', s.done ? 'bg-good text-white ring-good' : 'bg-surface-2 text-ink-3 ring-line')} data-done={s.done || undefined}>
                {s.done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Icon className="h-3.5 w-3.5" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm font-medium', s.done ? 'text-ink-3 line-through decoration-ink-3/40' : 'text-ink')}>{s.title}</span>
                {!s.done && <span className="block text-xs text-ink-3">{s.hint}</span>}
              </span>
              {action}
              <span className="sr-only">{s.done ? 'done' : 'to do'}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
