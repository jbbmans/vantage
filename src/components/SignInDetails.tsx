import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Send, ShieldCheck, MailX } from 'lucide-react';
import { Button, Badge, Segmented, Progress } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { Table } from '@/components/common';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { timeAgo } from '@/lib/utils';
import * as api from '@/lib/api';

interface Person { id: string; username: string; name: string; email: string | null; last_login_at: string | null; must_change_password: boolean; sent_at: string | null }
interface Audience { emailEnabled: boolean; provider: string; linkHours: number; recipients: Person[]; withoutEmail: Person[] }
type Scope = 'all' | 'new' | 'unsent';
type Outcome = { status: 'sent' | 'queued' | 'failed' | 'skipped'; error?: string };

const CHUNK = 10;
const TONE = { sent: 'good', queued: 'warn', failed: 'bad', skipped: 'neutral' } as const;
const LABEL = { sent: 'Sent', queued: 'Queued', failed: 'Failed', skipped: 'Skipped' } as const;

/**
 * Emails everyone their username and a one-time link to choose a password. The browser sends in small batches so
 * progress is visible, a provider's rate limit is respected, and closing the dialog stops before the next batch.
 */
/** Email each member of an organization their username and a link to choose their own password. */
export default function SignInDetails({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [sending, setSending] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const stop = useRef(false);
  const toast = useToast();
  const qc = useQueryClient();

  const load = async () => {
    setLoading(true);
    try { setAudience(await withSudo(() => api.orgSignInAudience(orgId))); } catch (e) { toast.error(api.errorText(e)); setOpen(false); } finally { setLoading(false); }
  };
  const begin = () => { setAudience(null); setOutcomes({}); setSentTo(null); setScope('all'); setOpen(true); void load(); };

  const people = audience?.recipients || [];
  const scoped = { all: people, new: people.filter((p) => !p.last_login_at), unsent: people.filter((p) => !p.sent_at) } as const;
  // Once sending starts, the list stays the people it was started for.
  const shown = sentTo ? people.filter((p) => sentTo.includes(p.id)) : scoped[scope];
  const done = Object.keys(outcomes).length;
  const count = (s: Outcome['status']) => Object.values(outcomes).filter((o) => o.status === s).length;

  const send = async () => {
    const ids = scoped[scope].map((p) => p.id);
    if (!ids.length) return;
    stop.current = false;
    setSentTo(ids); setOutcomes({}); setSending(true);
    const collected: Record<string, Outcome> = {};
    let broken = false;
    for (let i = 0; i < ids.length && !stop.current; i += CHUNK) {
      try {
        const { results } = await withSudo(() => api.orgSendSignInDetails(orgId, ids.slice(i, i + CHUNK))) as { results: Array<{ id: string } & Outcome> };
        for (const r of results) collected[r.id] = { status: r.status, error: r.error };
        setOutcomes({ ...collected });
      } catch (e) {
        toast.error(api.errorText(e));
        broken = true;
        break;
      }
    }
    setSending(false);
    const values = Object.values(collected);
    const delivered = values.filter((o) => o.status === 'sent' || o.status === 'queued').length;
    const failed = values.filter((o) => o.status === 'failed').length;
    if (failed) toast.error(`${delivered} sent, ${failed} failed. The reason is beside each name.`);
    else if (!broken) toast.success(`Sign-in details sent to ${delivered} ${delivered === 1 ? 'person' : 'people'}${stop.current ? ' before you stopped' : ''}.`);
    qc.invalidateQueries({ queryKey: ['org', orgId] });
    onDone();
  };

  const close = (o: boolean) => {
    if (!o && sending) { stop.current = true; toast.info('Stopping after the current batch.'); }
    setOpen(o);
  };

  const target = scoped[scope].length;
  return (
    <>
      <Button size="sm" onClick={begin}><Send className="h-3.5 w-3.5" />Email sign-in details</Button>
      <Dialog
        open={open}
        onOpenChange={close}
        size="lg"
        title="Email sign-in details"
        description={`Each person gets their username and a one-time link to choose their own password, good for ${audience?.linkHours ?? 72} hours. Nobody’s current password changes until they use it, and no password is ever sent by email.`}
        footer={sentTo && !sending
          ? <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
          : <>
              <Button variant="ghost" onClick={() => { if (sending) stop.current = true; else setOpen(false); }}>{sending ? 'Stop' : 'Cancel'}</Button>
              <Button variant="primary" loading={sending} disabled={!audience?.emailEnabled || !target || sending} onClick={() => void send()}>
                <Send className="h-4 w-4" />{sending ? `Sending ${done} of ${sentTo?.length ?? target}` : `Send to ${target} ${target === 1 ? 'person' : 'people'}`}
              </Button>
            </>}
      >
        {loading || !audience ? <p className="py-8 text-center text-sm text-ink-3">Reading accounts…</p> : (
          <>
            {!audience.emailEnabled && (
              <p role="alert" className="mb-3 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-ink">Email is off on Vantage right now, so nothing can be sent. Set it up on the Email tab first.</p>
            )}
            {!sentTo && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Segmented<Scope> label="Who receives it" value={scope} onChange={setScope} size="sm" options={[
                  { value: 'all', label: `Everyone · ${scoped.all.length}` },
                  { value: 'new', label: `Never signed in · ${scoped.new.length}` },
                  { value: 'unsent', label: `Not sent yet · ${scoped.unsent.length}` },
                ]} />
                <span className="text-xs text-ink-3">You are not included. Sent through {audience.provider}.</span>
              </div>
            )}
            {sentTo && (
              <div className="mb-3">
                <Progress value={done} max={sentTo.length} tone={count('failed') ? 'warn' : 'good'} label="Sending sign-in details" />
                <p className="mt-1.5 text-xs text-ink-3" role="status">
                  {done} of {sentTo.length} · <span className="text-good">{count('sent')} sent</span>{count('queued') ? <> · <span className="text-warn">{count('queued')} queued to retry</span></> : null}{count('failed') ? <> · <span className="text-bad">{count('failed')} failed</span></> : null}{count('skipped') ? <> · {count('skipped')} skipped</> : null}
                </p>
              </div>
            )}
            {!sentTo && audience.withoutEmail.length > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">
                <MailX className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <p>{audience.withoutEmail.length} {audience.withoutEmail.length === 1 ? 'account has' : 'accounts have'} no email address and cannot be reached this way: {audience.withoutEmail.slice(0, 8).map((p) => p.username).join(', ')}{audience.withoutEmail.length > 8 ? `, and ${audience.withoutEmail.length - 8} more` : ''}. Give them a temporary password in person from the Accounts list.</p>
              </div>
            )}
            {!shown.length ? <p className="py-6 text-center text-sm text-ink-3">Nobody in this group has an email address to send to.</p> : (
              <div className="card" style={{ overflow: 'hidden' }}>
                <Table minWidth={640} head={<><th>Marine</th><th>Email</th><th className="w-32">Last sign-in</th><th className="w-40">Status</th></>}>
                  {shown.map((p) => {
                    const o = outcomes[p.id];
                    return (
                      <tr key={p.id}>
                        <td><span className="block font-medium text-ink">{p.name}</span><span className="block text-xs text-ink-3">@{p.username}</span></td>
                        <td className="break-all text-xs text-ink-2">{p.email}</td>
                        <td className="text-xs text-ink-3">{p.last_login_at ? timeAgo(p.last_login_at) : 'never'}</td>
                        <td>{o ? <><Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge>{o.error && <span className="mt-1 block break-words text-2xs text-ink-3">{o.error}</span>}</>
                          : p.sent_at ? <span className="text-xs text-ink-3">last sent {timeAgo(p.sent_at)}</span> : <span className="text-xs text-ink-3">not sent yet</span>}</td>
                      </tr>
                    );
                  })}
                </Table>
              </div>
            )}
            <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-3"><ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />Sending again replaces a person’s earlier link, so only the newest one works. Every send is in the audit log.</p>
          </>
        )}
      </Dialog>
    </>
  );
}
