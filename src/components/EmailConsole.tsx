import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Mail, RefreshCw, Server, ShieldCheck, XCircle, CircleDashed } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import * as api from '@/lib/api';
import { copyToClipboard, timeAgo } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface Setup {
  provider: string; from: string; domain: string; replyTo: string | null; helo: string | null;
  records: Array<{ id: string; type: string; host: string; fqdn: string; value: string; why: string; status?: 'ok' | 'missing' | 'different' | 'unknown'; found?: string[] }>;
  path: { checkedAt: string; open: boolean; ip: string | null; ptr: string | null; forwardConfirmed: boolean; server: string | null; error?: string } | null;
  queue: { waiting: number; oldest: string | null };
  dnsHost?: { name: string | null; nameservers: string[] };
  recent: Array<{ to_address: string; kind: string; status: string; error: string | null; created_at: string }>;
}

const STATUS: Record<string, { label: string; tone: 'good' | 'bad' | 'warn' | 'neutral'; icon: typeof CheckCircle2 }> = {
  ok: { label: 'Published', tone: 'good', icon: CheckCircle2 },
  missing: { label: 'Not found', tone: 'bad', icon: XCircle },
  different: { label: 'Different', tone: 'warn', icon: XCircle },
  unknown: { label: 'Needs the path check', tone: 'neutral', icon: CircleDashed },
};

/** Sending from the deployment's own domain, with no email service: what to publish, and whether it is working. */
export default function EmailConsole() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery<Setup>({ queryKey: ['admin', 'email'], queryFn: () => withSudo(api.adminEmail), retry: false });
  const [checked, setChecked] = useState<Setup | null>(null);
  const [checking, setChecking] = useState(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const view = checked || data;

  const check = async () => {
    setChecking(true);
    try { setChecked(await withSudo(api.adminEmailCheck)); qc.invalidateQueries({ queryKey: ['admin', 'email'] }); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setChecking(false); }
  };
  const test = async () => {
    setSending(true);
    try {
      const r = await withSudo(() => api.adminEmailTest(to || undefined));
      toast.success(r.queued ? 'The receiving server asked to try again later. It is queued and retried automatically.' : view?.provider === 'direct' ? 'Delivered to the receiving server.' : `Handed to ${view?.provider}.`);
      qc.invalidateQueries({ queryKey: ['admin', 'email'] });
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setSending(false); }
  };

  if (isPending) return <Skeleton className="h-64" />;
  if (error || !view) return <div className="card"><EmptyState title="Could not load email settings" description={api.errorText(error)} /></div>;

  const direct = view.provider === 'direct';
  const testPanel = (
    <Panel title="Send a test" subtitle={direct ? 'Delivered straight to the receiving server' : `Sent through ${view.provider}, from ${view.from}`}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="To" hint="blank sends to your own address" className="min-w-[14rem] flex-1"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" /></Field>
        <Button variant="primary" onClick={test} loading={sending}><Mail className="h-4 w-4" />Send test</Button>
      </div>
      {direct && <p className="mt-3 flex items-start gap-2 text-2xs leading-relaxed text-ink-3"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />A receiver that says “try later” is retried automatically for up to two days (30 minutes for a reset link). A refusal is final, and its exact reason is logged below.</p>}
      <ul className="mt-3 space-y-1.5 text-xs">
        {view.recent.slice(0, 8).map((m, i) => (
          <li key={i} className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate text-ink">{m.kind} → {m.to_address}</span>
            <span className={cn('shrink-0 text-right', m.status === 'sent' ? 'text-good' : m.status === 'queued' ? 'text-warn' : 'text-bad')} title={m.error || undefined}>{m.status}</span>
          </li>
        ))}
        {!view.recent.length && <li className="text-ink-3">Nothing sent yet.</li>}
      </ul>
    </Panel>
  );

  if (!direct) {
    return (
      <div className="space-y-4">
        {view.provider !== 'none' && testPanel}
        <Panel title="Send from your own domain" subtitle={view.provider === 'none' ? 'Email is off' : `Currently sending through ${view.provider}. This is optional.`}>
          <div className="space-y-3 text-sm leading-relaxed text-ink-2">
            <p>Vantage can deliver its own mail, straight to each recipient’s mail server, signed for your domain. No email service, account or API key is involved.</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>On the host, set <code className="cite">VANTAGE_EMAIL_PROVIDER=direct</code> and <code className="cite">VANTAGE_EMAIL_FROM=&quot;Vantage &lt;no-reply@yourdomain&gt;&quot;</code>, then redeploy.</li>
              <li>Come back to this tab. It shows the three DNS records to publish, and checks them for you.</li>
            </ol>
            <p className="text-xs text-ink-3">The host must allow outbound connections on port 25. Render blocks it on free instances; paid instances allow it.</p>
          </div>
        </Panel>
      </div>
    );
  }

  const path = view.path;
  return (
    <div className="space-y-4">
      <Panel title="Sending from your own domain" subtitle={`${view.from}${view.replyTo ? ` · replies go to ${view.replyTo}` : ''}`}
        action={<Button size="sm" onClick={check} loading={checking}><RefreshCw className="h-3.5 w-3.5" />Check everything</Button>}>
        <p className="text-sm leading-relaxed text-ink-2">Vantage delivers each message itself, to the recipient’s own mail server, and signs it with a key it made for <strong className="text-ink">{view.domain}</strong>. Nothing passes through an email service.</p>
        <ol className="stagger mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Step n={1} title="Reach mail servers" state={!path ? 'unknown' : path.open ? 'ok' : 'bad'}>
            {!path ? 'Not checked yet. Check everything to test it.' : path.open ? <>Port 25 is open. This server sends from <span className="fig text-ink">{path.ip || 'an unknown address'}</span>.</> : <>Port 25 is blocked: {path.error}</>}
          </Step>
          <Step n={2} title="Publish three records" state={view.records.every((r) => r.status === 'ok') ? 'ok' : view.records.some((r) => r.status) ? 'bad' : 'unknown'}>
            {view.records.some((r) => r.status) ? `${view.records.filter((r) => r.status === 'ok').length} of 3 published correctly.` : 'Add them where your DNS is hosted, then check.'}
          </Step>
          <Step n={3} title="Send a test" state={view.recent.some((m) => m.kind === 'test' && m.status === 'sent') ? 'ok' : 'unknown'}>
            Send one to an address you can read, and look for “DKIM: pass” in its headers.
          </Step>
        </ol>
      </Panel>

      <Panel title="DNS records for your domain" padded={false}
        subtitle={view.dnsHost?.name ? `Add these in ${view.dnsHost.name}, which hosts ${view.domain}’s DNS. The host column is the name field there.` : 'Add these where the domain’s DNS is hosted. The host column is the name field there.'}>
        <ul className="divide-y divide-line">
          {view.records.map((r) => {
            const s = r.status ? STATUS[r.status] : null;
            return (
              <li key={r.id} className="grid grid-cols-1 gap-2 px-4 py-3.5 md:grid-cols-[5rem_12rem_minmax(0,1fr)_7rem] md:items-start">
                <span className="text-xs font-semibold text-ink-2">{r.type}</span>
                <span className="fig break-all text-sm text-ink">{r.host}</span>
                <span className="min-w-0">
                  <span className="flex items-start gap-2">
                    <code className="block min-w-0 flex-1 break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-2xs leading-relaxed text-ink ring-1 ring-inset ring-line">{r.value}</code>
                    <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${r.id.toUpperCase()} value`} onClick={async () => { if (await copyToClipboard(r.value)) toast.success('Copied.'); }}><Copy className="h-3.5 w-3.5" /></Button>
                  </span>
                  <span className="mt-1 block text-2xs leading-relaxed text-ink-3">{r.why}</span>
                  {r.status === 'different' && r.found?.length ? <span className="mt-1 block break-all text-2xs text-warn">Published now: {r.found.join(' | ')}</span> : null}
                </span>
                <span>{s ? <Badge tone={s.tone}>{s.label}</Badge> : <span className="text-2xs text-ink-3">not checked</span>}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="The sending server" subtitle={path ? `checked ${timeAgo(path.checkedAt)}` : 'not checked yet'}>
          <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-ink-3">Port 25</dt><dd>{!path ? '—' : path.open ? <Badge tone="good">Open</Badge> : <Badge tone="bad">Blocked</Badge>}</dd>
            <dt className="text-ink-3">Sends from</dt><dd className="fig text-ink">{path?.ip || '—'}</dd>
            <dt className="text-ink-3">Reverse name</dt><dd className="break-all text-ink">{path?.ptr || '—'}{path?.ptr && <span className="ml-1 text-2xs text-ink-3">{path.forwardConfirmed ? '(confirmed both ways)' : '(does not point back)'}</span>}</dd>
            <dt className="text-ink-3">Greets as</dt><dd className="break-all text-ink">{view.helo || '—'}</dd>
            <dt className="text-ink-3">Waiting to retry</dt><dd className="fig text-ink">{view.queue.waiting}</dd>
          </dl>
          <p className="mt-3 flex items-start gap-2 text-2xs leading-relaxed text-ink-3"><Server className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />A host may send from more than one address. Put every outbound address it lists in the SPF record. Receivers also check that the address’s reverse name points back to it, which only the host can set.</p>
        </Panel>
        {testPanel}
      </div>
    </div>
  );
}

function Step({ n, title, state, children }: { n: number; title: string; state: 'ok' | 'bad' | 'unknown'; children: React.ReactNode }) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : CircleDashed;
  return (
    <li className="rounded-xl bg-surface-2/60 p-3.5 ring-1 ring-inset ring-line" style={{ '--i': n - 1 } as React.CSSProperties}>
      <span className="flex items-center gap-2 text-sm font-medium text-ink">
        <Icon className={cn('h-4 w-4 shrink-0', state === 'ok' ? 'text-good' : state === 'bad' ? 'text-bad' : 'text-ink-3')} aria-hidden />{n}. {title}
      </span>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{children}</p>
    </li>
  );
}
