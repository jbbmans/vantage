import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, Send } from 'lucide-react';
import { PageHeader, Panel, Button, Field, Input, Select, Textarea, Badge, EmptyState, Skeleton, Tabs, Switch, type Tone } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Table, useParam } from '@/components/common';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, humanize, timeAgo } from '@/lib/utils';

const CATEGORIES = [
  { value: 'sign_in', label: 'Signing in' }, { value: 'account', label: 'My account' }, { value: 'data', label: 'My records or data' },
  { value: 'bug', label: 'Something is broken' }, { value: 'request', label: 'A request' }, { value: 'other', label: 'Something else' },
];
const categoryLabel = (value: string) => CATEGORIES.find((c) => c.value === value)?.label || humanize(value);

const STATES: Record<string, [string, Tone]> = {
  open: ['Open', 'warn'], in_progress: ['In progress', 'accent'], waiting_on_requester: ['Waiting on the requester', 'info'],
  resolved: ['Resolved', 'good'], closed: ['Closed', 'neutral'],
};
const StateBadge = ({ state, mine }: { state: string; mine?: boolean }) => (
  <Badge tone={STATES[state]?.[1] || 'neutral'}>{mine && state === 'waiting_on_requester' ? 'Waiting on you' : STATES[state]?.[0] || humanize(state)}</Badge>
);
const PRIORITIES = ['low', 'normal', 'high', 'urgent'].map((value) => ({ value, label: humanize(value) }));

type Ticket = { id: string; subject: string; category: string; state: string; priority: string; requester_id: string | null; requester_name: string | null; requester_email: string | null; assigned_to: string | null; version: number; created_at: string; updated_at: string; message_count?: number };

export default function Support() {
  const { id } = useParams();
  return id ? <TicketView id={id} /> : <SupportHome />;
}

function SupportHome() {
  const { data: identity } = useIdentity();
  const [tab, setTab] = useParam('tab', 'mine');
  const mine = useQuery({ queryKey: ['support', 'mine'], queryFn: () => api.supportTickets(true) });
  const works = Boolean(mine.data?.works_queue);
  const queue = useQuery({ queryKey: ['support', 'queue'], queryFn: () => api.supportTickets(false), enabled: works });
  const shown = works && tab === 'queue' ? 'queue' : 'mine';
  const list = shown === 'queue' ? queue : mine;
  const tickets: Ticket[] = list.data?.tickets || [];
  const me = identity?.user.id;
  return (
    <div className="page page-narrow">
      <PageHeader eyebrow="Support" title="Ask a person" lede="For what the field guide does not answer. A request goes to the people who run Vantage here, and to the support staff of the unit you send it to." />
      {works && <Tabs value={shown} onChange={setTab} className="mb-4" tabs={[{ value: 'mine', label: 'Yours', count: mine.data?.tickets?.length }, { value: 'queue', label: 'The queue', count: queue.data?.tickets?.filter((t: Ticket) => t.state !== 'resolved' && t.state !== 'closed').length }]} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <NewRequest units={identity?.memberships || []} />
        <Panel title={shown === 'queue' ? 'The queue' : 'Your requests'} className="lg:col-span-2" padded={false}>
          {list.isPending ? <Skeleton className="m-4 h-32" /> : !tickets.length ? <EmptyState title={shown === 'queue' ? 'Nothing waiting' : 'No requests yet'} description={shown === 'queue' ? 'New requests appear here, and you are told when one arrives.' : 'When you send one, it is listed here with every answer.'} /> : (
            <Table minWidth={520} head={<><th>Request</th>{shown === 'queue' && <th className="w-40">From</th>}<th className="w-44">State</th><th className="w-28">Updated</th></>}>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td><Link className="link font-medium" to={`/support/${t.id}`}>{t.subject}</Link><span className="block text-xs text-ink-3">{categoryLabel(t.category)}{t.priority === 'high' || t.priority === 'urgent' ? ` · ${humanize(t.priority)} priority` : ''}</span></td>
                  {shown === 'queue' && <td className="text-xs text-ink-2">{t.requester_id === me ? 'You' : t.requester_name || t.requester_email || 'Signed out'}</td>}
                  <td><StateBadge state={t.state} mine={t.requester_id === me} /></td>
                  <td className="text-xs text-ink-3">{timeAgo(t.updated_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function NewRequest({ units }: { units: Array<{ unit_id: string; unit_name: string; unit_short: string | null }> }) {
  const toast = useToast(); const qc = useQueryClient(); const navigate = useNavigate();
  const [form, setForm] = useState({ subject: '', body: '', category: 'other', unit_id: '__instance' });
  const [busy, setBusy] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({});
  const send = async () => {
    setBusy(true); setErrors({});
    try {
      const ticket = await api.raiseSupportTicket({ subject: form.subject, body: form.body, category: form.category, unit_id: form.unit_id === '__instance' ? null : form.unit_id });
      qc.invalidateQueries({ queryKey: ['support'] }); toast.success('Request sent.'); navigate(`/support/${ticket.id}`);
    } catch (e: any) { setErrors(e?.fieldErrors || {}); toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Panel title="New request" className="lg:col-span-1">
      <div className="space-y-3">
        <Field label="What is wrong" error={errors.subject}><Input maxLength={200} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <Field label="About"><Select value={form.category} onValueChange={(category) => setForm({ ...form, category })} options={CATEGORIES} /></Field>
        {units.length > 0 && <Field label="Send to" hint="who answers it"><Select value={form.unit_id} onValueChange={(unit_id) => setForm({ ...form, unit_id })} options={[{ value: '__instance', label: 'The people who run Vantage' }, ...units.map((u) => ({ value: u.unit_id, label: `${u.unit_short || u.unit_name} support staff` }))]} /></Field>}
        <Field label="What happened" hint="what you tried, and what it said" error={errors.body}><Textarea rows={5} maxLength={8000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        <Button variant="primary" className="w-full" onClick={send} loading={busy} disabled={!form.subject.trim() || !form.body.trim()}><Send className="h-4 w-4" />Send request</Button>
        <p className="text-xs text-ink-3">Nobody who answers will ever ask for your password.</p>
      </div>
    </Panel>
  );
}

function TicketView({ id }: { id: string }) {
  const toast = useToast(); const qc = useQueryClient(); const { data: identity } = useIdentity();
  const { data, isPending, error, refetch } = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => api.supportTicket(id) });
  const [reply, setReply] = useState(''); const [internal, setInternal] = useState(false); const [busy, setBusy] = useState(false);
  if (isPending) return <div className="page page-narrow"><Skeleton className="h-64" /></div>;
  if (!data) return <div className="page page-narrow"><div className="card"><EmptyState title="This request is not available" description={api.errorText(error)} action={<Link className="link" to="/support">All requests</Link>} /></div></div>;

  const ticket: Ticket = data.ticket;
  const works: boolean = data.works;
  const me = identity?.user.id;
  const mine = ticket.requester_id === me;
  const changed = () => { refetch(); qc.invalidateQueries({ queryKey: ['support'] }); };
  const update = async (patch: { state?: string; priority?: string; assigned_to?: string | null }) => {
    try { await api.updateSupportTicket(id, { ...patch, version: ticket.version }); changed(); } catch (e) { toast.error(api.errorText(e)); refetch(); }
  };
  const send = async () => {
    setBusy(true);
    try { await api.replySupportTicket(id, { body: reply, internal }); setReply(''); setInternal(false); changed(); toast.success(internal ? 'Note added.' : 'Reply sent.'); }
    catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const author = (m: any) => (m.author_id ? (m.author_id === me ? 'You' : `${m.first_name} ${m.last_name}`) : ticket.requester_name || ticket.requester_email || 'Someone signed out');

  return (
    <div className="page page-narrow">
      <Link to="/support" className="link mb-3 inline-flex items-center gap-1 text-sm"><ArrowLeft className="h-4 w-4" />All requests</Link>
      <PageHeader eyebrow={categoryLabel(ticket.category)} title={ticket.subject} lede={`${mine ? 'You' : ticket.requester_name || ticket.requester_email || 'Someone signed out'} · opened ${timeAgo(ticket.created_at)}`}>
        <StateBadge state={ticket.state} mine={mine} />
      </PageHeader>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <ol className="space-y-3">
            {data.messages.map((m: any) => (
              <li key={m.id} className={cn('card p-4', m.internal && 'border-warn/40 bg-warn/5')}>
                <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-3"><span className="font-medium text-ink">{author(m)}</span>{m.internal ? <Badge tone="warn"><Lock className="h-3 w-3" />Internal note</Badge> : null}<span>{timeAgo(m.created_at)}</span></p>
                <p className="whitespace-pre-wrap break-words text-sm text-ink-2">{m.body}</p>
              </li>
            ))}
          </ol>
          {works && !ticket.requester_id && (
            <p className="card p-3 text-sm text-ink-2">This came from the sign-in page, so whoever sent it cannot read a reply here. {ticket.requester_email ? <>Write to them at <a className="link" href={`mailto:${ticket.requester_email}`}>{ticket.requester_email}</a>, and note it below.</> : 'They left no address.'}</p>
          )}
          {ticket.state === 'closed' && !works ? <p className="text-sm text-ink-3">This request is closed. <Link className="link" to="/support">Raise a new one</Link> if you still need help.</p> : (
            <Panel title={internal ? 'Internal note' : 'Reply'}>
              <div className="space-y-3">
                <Textarea aria-label={internal ? 'Internal note' : 'Your reply'} rows={4} maxLength={8000} value={reply} onChange={(e) => setReply(e.target.value)} />
                {works && <Switch checked={internal} onChange={setInternal} label="Internal note" description="Only the people who work the queue see it." />}
                {mine && ticket.state === 'resolved' && <p className="text-xs text-ink-3">Replying reopens it.</p>}
                <div className="flex justify-end"><Button variant="primary" onClick={send} loading={busy} disabled={!reply.trim()}><Send className="h-4 w-4" />{internal ? 'Add note' : 'Send reply'}</Button></div>
              </div>
            </Panel>
          )}
        </div>
        {works && (
          <div className="space-y-4">
            <Panel title="Work it">
              <div className="space-y-3">
                <Field label="State"><Select value={ticket.state} onValueChange={(state) => update({ state })} options={Object.entries(STATES).map(([value, [label]]) => ({ value, label }))} /></Field>
                <Field label="Priority"><Select value={ticket.priority} onValueChange={(priority) => update({ priority })} options={PRIORITIES} /></Field>
                <p className="text-sm text-ink-2">{data.assignee ? (data.assignee.id === me ? 'You have it.' : `${data.assignee.name} has it.`) : 'Nobody has it yet.'}</p>
                {data.assignee?.id === me ? <Button variant="ghost" onClick={() => update({ assigned_to: null })}>Let it go</Button> : <Button onClick={() => update({ assigned_to: me })}>Take it</Button>}
              </div>
            </Panel>
            <Panel title="Email to this person" subtitle="Whether it went out, never what it said">
              {data.delivery.length ? (
                <ul className="space-y-2">{data.delivery.map((d: any) => <li key={d.id} className="text-xs text-ink-2"><span className="font-medium text-ink">{humanize(d.kind)}</span> to {d.to_address} · {d.status} · {timeAgo(d.created_at)}{d.error && <span className="block text-bad">{d.error}</span>}</li>)}</ul>
              ) : <p className="text-sm text-ink-3">No email to them on record.</p>}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
