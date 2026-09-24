import { CloudOff, KeyRound, Lock, SearchX, ServerCrash } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';

/**
 * Why a read failed, in words that say what to do about it (F11).
 *
 * A failed request used to render as an empty list, an endless skeleton, or "you do not have
 * permission", whichever the screen happened to assume. Those mean different things to the person
 * looking at them: offline is wait-and-retry, denied is ask-somebody, and a server error is neither.
 */
export type FailureKind = 'offline' | 'signed_out' | 'denied' | 'missing' | 'server';

export function failureOf(error: unknown): FailureKind {
  const status = error instanceof ApiError ? error.status : (error as { status?: number } | null)?.status;
  if (status === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'offline';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'denied';
  if (status === 404) return 'missing';
  return 'server';
}

const COPY: Record<FailureKind, { icon: typeof Lock; title: string; description: string }> = {
  offline: { icon: CloudOff, title: 'You are offline', description: 'Nothing here is lost. It loads again when the connection comes back.' },
  signed_out: { icon: KeyRound, title: 'Your session ended', description: 'Sign in again to pick up where you left off.' },
  denied: { icon: Lock, title: 'Not yours to see', description: 'Your role does not include this. A unit leader can change that.' },
  missing: { icon: SearchX, title: 'Not here any more', description: 'It was removed or moved, or the link is out of date.' },
  server: { icon: ServerCrash, title: 'This could not load', description: 'The server did not answer properly. Try again; if it keeps happening, tell your administrator.' },
};

export function QueryFailure({ error, onRetry, what, denied, className }: {
  error: unknown;
  onRetry?: () => void;
  /** What failed to load, for the title: "Your career plan could not load". */
  what?: string;
  /** Screen-specific wording for the permission case. */
  denied?: { title: string; description: string };
  className?: string;
}) {
  const kind = failureOf(error);
  const copy = kind === 'denied' && denied ? { ...COPY.denied, ...denied } : COPY[kind];
  const title = kind === 'server' && what ? `${what} could not load` : copy.title;
  const detail = kind === 'server' && error instanceof Error && error.message ? ` (${error.message})` : '';
  const retry = kind === 'offline' || kind === 'server';
  return (
    <div className={className ?? 'card'} role={kind === 'server' ? 'alert' : undefined}>
      <EmptyState
        icon={copy.icon}
        title={title}
        description={`${copy.description}${detail}`}
        action={retry && onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : kind === 'signed_out' ? <Button size="sm" onClick={() => window.location.assign('/login')}>Sign in</Button> : undefined}
      />
    </div>
  );
}
