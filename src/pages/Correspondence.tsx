import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Mail, MailPlus, Paperclip, Plug, Send, Upload, UserRound, ShieldAlert, Link2, ImageOff, Clock,
} from 'lucide-react';
import {
  PageHeader, Panel, Button, Input, Select, Textarea, Field, Badge, EmptyState, Skeleton, Tabs, type Tone,
} from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, useParam } from '@/components/common';
import { AiAction, AiResult } from '@/components/AiPanel';
import {
  useIdentity, useContacts, useThreads, useThread, useConnectors, invalidateCorrespondence,
  correspondenceKeys, type ThreadSummary,
} from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, todayIso } from '@/lib/utils';

/**
 * Correspondence: the emails behind the work, kept next to the work.
 *
 * A thread carries three separate facts, never one: when a reply came back, when the knowledge the
 * request was for arrived, and when the matter was closed. A reply that answers nothing still moves
 * the thread to "response received" and no further, because that is what happened.
 *
 * Message bodies are sanitized on the server before they are stored. Remote images are stripped
 * rather than loaded: a tracking pixel in a message body would tell the sender when a Marine opened
 * their mail, from which network.
 */

const STATES = ['draft', 'sent', 'awaiting_reply', 'response_received', 'ksd_received', 'resolved'] as const;
type State = (typeof STATES)[number];

const STATE_LABEL: Record<State, string> = {
  draft: 'Draft',
  sent: 'Sent',
  awaiting_reply: 'Awaiting reply',
  response_received: 'Response received',
  ksd_received: 'KSD received',
  resolved: 'Resolved',
};
const STATE_TONE: Record<State, Tone> = {
  draft: 'neutral', sent: 'info', awaiting_reply: 'warn',
  response_received: 'accent', ksd_received: 'good', resolved: 'good',
};
/** What each state actually asserts, spelled out so nobody reads "response" as "answer". */
const STATE_MEANING: Record<State, string> = {
  draft: 'Written, not sent.',
  sent: 'It went out.',
  awaiting_reply: 'Sent, and nothing has come back.',
  response_received: 'Somebody replied. It may not have answered anything.',
  ksd_received: 'The knowledge you asked for arrived.',
  resolved: 'The matter is closed.',
};

const emptyThread = { subject: '', unit_id: '', visibility: 'unit' as 'unit' | 'private', contact_id: '', follow_up_at: '' };
const emptyContact = { name: '', email: '', organization: '', role: '', phone: '', notes: '', visibility: 'unit' as 'unit' | 'private', unit_id: '' };

export default function Correspondence() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const [tab, setTab] = useParam('tab', 'threads');
  const [stateFilter, setStateFilter] = useParam('state', '');
  const [dueOnly, setDueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useParam('thread', '');
  const [composing, setComposing] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);

  const params = useMemo(() => ({
    state: stateFilter || undefined,
    due: dueOnly ? '1' : undefined,
    q: search.trim() || undefined,
  }), [stateFilter, dueOnly, search]);

  const threads = useThreads(params);
  const contacts = useContacts();
  const rows = threads.data || [];
  const primaryUnit = identity?.primaryUnitId || '';

  const due = rows.filter((t) => t.follow_up_at && t.follow_up_at <= todayIso() && t.state !== 'resolved' && t.state !== 'ksd_received');

  return (
    <div className="page">
      <PageHeader
        eyebrow="Work"
        title="Correspondence"
        lede="The emails behind the work, linked to the work they are about. A reply is not an answer, and an answer is not a closed matter, so each is recorded on its own."
      >
        <Button variant="ghost" onClick={() => setContactOpen(true)}><UserRound className="h-4 w-4" />New contact</Button>
        <Button variant="primary" onClick={() => setComposing(true)}><MailPlus className="h-4 w-4" />New thread</Button>
      </PageHeader>

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { value: 'threads', label: 'Threads' },
          { value: 'contacts', label: `Contacts${contacts.data?.length ? ` (${contacts.data.length})` : ''}` },
          { value: 'mailboxes', label: 'Mailboxes' },
        ]}
      />

      {tab === 'threads' && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <Field label="Search" className="min-w-[12rem] flex-1">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Subject" />
            </Field>
            <Field label="State" className="w-48">
              <Select
                value={stateFilter}
                onValueChange={setStateFilter}
                options={[{ value: '', label: 'Any state' }, ...STATES.map((s) => ({ value: s, label: STATE_LABEL[s] }))]}
              />
            </Field>
            <Button variant={dueOnly ? 'primary' : 'ghost'} onClick={() => setDueOnly((v) => !v)}>
              <Clock className="h-4 w-4" />Follow-up due{due.length ? ` (${due.length})` : ''}
            </Button>
          </div>

          {threads.isPending ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : rows.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={Mail}
                title="No correspondence yet"
                description="Start a thread for a request you are sending, or import an .eml file you already have."
                action={<Button variant="primary" onClick={() => setComposing(true)}><MailPlus className="h-4 w-4" />New thread</Button>}
              />
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((t) => <ThreadRow key={t.id} thread={t} onOpen={() => setOpenId(t.id)} />)}
            </ul>
          )}
        </>
      )}

      {tab === 'contacts' && <Contacts onNew={() => setContactOpen(true)} />}
      {tab === 'mailboxes' && <Mailboxes />}

      <ComposeThread
        open={composing}
        onOpenChange={setComposing}
        contacts={contacts.data || []}
        units={identity?.unitIds || []}
        defaultUnit={primaryUnit}
        onCreated={(id) => { invalidateCorrespondence(qc); setComposing(false); setOpenId(id); toast.success('Thread started.'); }}
      />
      <ContactDialog
        open={contactOpen}
        onOpenChange={setContactOpen}
        units={identity?.unitIds || []}
        defaultUnit={primaryUnit}
        onSaved={() => { qc.invalidateQueries({ queryKey: correspondenceKeys.contacts }); setContactOpen(false); toast.success('Contact saved.'); }}
      />
      <ThreadDetail id={openId || null} onClose={() => setOpenId('')} />
    </div>
  );
}

function ThreadRow({ thread, onOpen }: { thread: ThreadSummary; onOpen: () => void }) {
  const state = thread.state as State;
  const overdue = Boolean(thread.follow_up_at && thread.follow_up_at <= todayIso() && state !== 'resolved' && state !== 'ksd_received');
  return (
    <li>
      <button type="button" onClick={onOpen} className="card card-hover flex w-full items-start gap-3 p-3 text-left">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-ink-3"><Mail className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{thread.subject}</span>
            <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state] || state}</Badge>
            {thread.visibility === 'private' && <Badge>Private</Badge>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            {thread.contact_name && <span>{thread.contact_name}{thread.contact_organization ? ` · ${thread.contact_organization}` : ''}</span>}
            <span>{thread.message_count} message{thread.message_count === 1 ? '' : 's'}</span>
            {thread.linked_items > 0 && <span className="flex items-center gap-1"><Link2 className="h-3 w-3" />{thread.linked_items} linked</span>}
            {thread.follow_up_at && (
              <span className={cn('flex items-center gap-1', overdue && 'font-semibold text-warn')}>
                <Clock className="h-3 w-3" />Follow up <DateText value={thread.follow_up_at} />
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function ComposeThread({ open, onOpenChange, contacts, units, defaultUnit, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; contacts: Array<Record<string, any>>;
  units: string[]; defaultUnit: string; onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [d, setD] = useState({ ...emptyThread, unit_id: defaultUnit });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof emptyThread, v: string) => setD((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!d.subject.trim()) { toast.error('Give the thread a subject.'); return; }
    setBusy(true);
    try {
      const created = await api.createThread({
        subject: d.subject,
        unit_id: d.visibility === 'unit' ? (d.unit_id || defaultUnit) : null,
        visibility: d.visibility,
        contact_id: d.contact_id || null,
        follow_up_at: d.follow_up_at || null,
      });
      setD({ ...emptyThread, unit_id: defaultUnit });
      onCreated(created.id);
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New thread"
      description="A thread is one conversation about one thing. Link it to the work once it exists."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Start thread</Button></>}
    >
      <div className="space-y-3">
        <Field label="Subject" required><Input autoFocus value={d.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Aged obligation review, 1st Bn" /></Field>
        <Field label="Who it is with">
          <Select
            value={d.contact_id}
            onValueChange={(v) => set('contact_id', v === '__none' ? '' : v)}
            options={[{ value: '__none', label: 'Nobody yet' }, ...contacts.map((c) => ({ value: String(c.id), label: `${c.name}${c.organization ? ` · ${c.organization}` : ''}` }))]}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Who can see it" hint="private means only you">
            <Select value={d.visibility} onValueChange={(v) => set('visibility', v)} options={[{ value: 'unit', label: 'My unit' }, { value: 'private', label: 'Only me' }]} />
          </Field>
          {d.visibility === 'unit' && (
            <Field label="Unit"><Select value={d.unit_id} onValueChange={(v) => set('unit_id', v)} options={units.map((u) => ({ value: u, label: u }))} /></Field>
          )}
        </div>
        <Field label="Follow up on" hint="leave blank if nothing is owed back"><Input type="date" value={d.follow_up_at} onChange={(e) => set('follow_up_at', e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function ContactDialog({ open, onOpenChange, units, defaultUnit, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; units: string[]; defaultUnit: string; onSaved: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState({ ...emptyContact, unit_id: defaultUnit });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof emptyContact, v: string) => setD((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!d.name.trim()) { toast.error('A contact needs a name.'); return; }
    setBusy(true);
    try {
      await api.createContact({ ...d, unit_id: d.visibility === 'unit' ? (d.unit_id || defaultUnit) : null });
      setD({ ...emptyContact, unit_id: defaultUnit });
      onSaved();
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New contact"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save contact</Button></>}
    >
      <div className="space-y-3">
        <Field label="Name" required><Input autoFocus value={d.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Email"><Input value={d.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Phone"><Input value={d.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Organization"><Input value={d.organization} onChange={(e) => set('organization', e.target.value)} placeholder="DFAS" /></Field>
          <Field label="Role"><Input value={d.role} onChange={(e) => set('role', e.target.value)} placeholder="Budget analyst" /></Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Who can see it">
            <Select value={d.visibility} onValueChange={(v) => set('visibility', v)} options={[{ value: 'unit', label: 'My unit' }, { value: 'private', label: 'Only me' }]} />
          </Field>
          {d.visibility === 'unit' && <Field label="Unit"><Select value={d.unit_id} onValueChange={(v) => set('unit_id', v)} options={units.map((u) => ({ value: u, label: u }))} /></Field>}
        </div>
        <Field label="Notes"><Textarea rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function Contacts({ onNew }: { onNew: () => void }) {
  const contacts = useContacts();
  if (contacts.isPending) return <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (!contacts.data?.length) {
    return <div className="card"><EmptyState icon={UserRound} title="No contacts yet" description="The people you correspond with, so a thread has somebody on the other end." action={<Button variant="primary" onClick={onNew}><UserRound className="h-4 w-4" />New contact</Button>} /></div>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {contacts.data.map((c) => (
        <div key={String(c.id)} className="card p-4">
          <p className="text-sm font-semibold text-ink">{String(c.name)}</p>
          {c.role || c.organization ? <p className="mt-0.5 text-xs text-ink-3">{[c.role, c.organization].filter(Boolean).join(' · ')}</p> : null}
          <div className="mt-2 space-y-0.5 text-xs text-ink-2">
            {c.email ? <p className="truncate">{String(c.email)}</p> : null}
            {c.phone ? <p>{String(c.phone)}</p> : null}
          </div>
          {c.visibility === 'private' && <Badge className="mt-2">Private</Badge>}
        </div>
      ))}
    </div>
  );
}

function ThreadDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const detail = useThread(id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [aiOut, setAiOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);

  const thread = detail.data?.thread;
  const state = (thread?.state || 'draft') as State;

  const move = async (next: State) => {
    if (!thread) return;
    setBusy(true);
    try {
      await api.setThreadState(thread.id, { state: next, version: thread.version });
      invalidateCorrespondence(qc, thread.id);
      toast.success(STATE_MEANING[next]);
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    if (!thread) return;
    setBusy(true);
    try {
      const res = await api.importEmail(file, { threadId: thread.id, unitId: thread.unit_id, visibility: thread.visibility, direction: 'inbound' });
      invalidateCorrespondence(qc, thread.id);
      toast.success(res.replayed ? 'That email is already on this thread. Nothing was duplicated.' : 'Email imported.');
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const send = async () => {
    if (!thread || !reply.trim()) return;
    setBusy(true);
    try {
      await api.addThreadMessage(thread.id, { direction: 'outbound', subject: thread.subject, body_text: reply });
      setReply('');
      setAiOut(null);
      invalidateCorrespondence(qc, thread.id);
      toast.success('Message recorded. Vantage records what you sent; it does not send it for you.');
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open={Boolean(id)}
      onOpenChange={(o) => { if (!o) onClose(); }}
      variant="drawer"
      title={thread?.subject || 'Thread'}
      description={thread ? STATE_MEANING[state] : undefined}
    >
      {detail.isPending || !thread ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-32" /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
            {thread.visibility === 'private' && <Badge>Private</Badge>}
            {detail.data?.contact && <Badge>{String(detail.data.contact.name)}</Badge>}
          </div>

          <Panel title="Where it stands" subtitle="a reply, the knowledge you asked for, and a closed matter are three separate facts">
            <div className="space-y-3">
              <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                <Fact label="Response received" value={thread.response_at} />
                <Fact label="KSD received" value={thread.ksd_at} />
                <Fact label="Resolved" value={thread.resolved_at} />
              </dl>
              <div className="flex flex-wrap gap-2">
                {STATES.filter((s) => s !== state).map((s) => (
                  <Button key={s} size="xs" variant="soft" disabled={busy} onClick={() => move(s)}>{STATE_LABEL[s]}</Button>
                ))}
              </div>
            </div>
          </Panel>

          <Panel
            title={`Messages (${detail.data?.messages.length || 0})`}
            action={
              <>
                <input ref={fileRef} type="file" accept=".eml,message/rfc822" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }} />
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" />Import .eml</Button>
              </>
            }
          >
            {detail.data?.messages.length ? (
              <ul className="space-y-3">{detail.data.messages.map((m) => <Message key={String(m.id)} message={m} />)}</ul>
            ) : (
              <p className="text-sm text-ink-3">Nothing on this thread yet. Import the email you received, or record what you sent.</p>
            )}
          </Panel>

          <Panel title="Record what you sent" subtitle="Vantage keeps the record; it does not send mail on your behalf">
            <div className="space-y-3">
              <Textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="What you wrote, or the facts you want drafted into a request." />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" loading={busy} disabled={!reply.trim()} onClick={send}><Send className="h-3.5 w-3.5" />Record message</Button>
                <AiAction
                  workflow="writing"
                  surface="correspondence"
                  input={{ kind: 'email', source: `Subject: ${thread.subject}\n${reply}`, audience: detail.data?.contact ? `${detail.data.contact.name}${detail.data.contact.organization ? `, ${detail.data.contact.organization}` : ''}` : undefined, limit: 1200 }}
                  label="Draft this email"
                  disabled={!reply.trim()}
                  onResult={(output, meta) => setAiOut({ output, meta })}
                />
              </div>
              {aiOut && (
                <div className="space-y-2">
                  <AiResult output={aiOut.output} meta={aiOut.meta} primaryKey="draft" />
                  {typeof aiOut.output.draft === 'string' && (
                    <Button size="xs" variant="soft" onClick={() => setReply(String(aiOut.output.draft))}>Use this draft</Button>
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Panel title={`Linked work (${detail.data?.links.length || 0})`} subtitle="one email can be about a hundred rows and is still one email">
            {detail.data?.links.length ? (
              <ul className="space-y-1.5">
                {detail.data.links.map((l) => (
                  <li key={String(l.id)} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
                    <span className="min-w-0"><span className="font-mono text-xs text-ink-3">{String(l.natural_key)}</span> <span className="truncate text-ink-2">{String(l.title || '')}</span></span>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={async () => {
                      setBusy(true);
                      try { await api.unlinkThreadWork(thread.id, String(l.work_item_id)); invalidateCorrespondence(qc, thread.id); }
                      catch (err) { toast.error(api.errorText(err)); }
                      finally { setBusy(false); }
                    }}>Unlink</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">Link this thread from a row in the Queue to tie it to the work it is about.</p>
            )}
          </Panel>
        </div>
      )}
    </Dialog>
  );
}

const Fact = ({ label, value }: { label: string; value: string | null }) => (
  <div className="rounded-md border border-line px-3 py-2">
    <dt className="eyebrow">{label}</dt>
    <dd className="mt-0.5 text-sm text-ink">{value ? <DateText value={value} /> : <span className="text-ink-3">Not yet</span>}</dd>
  </div>
);

function Message({ message }: { message: Record<string, any> }) {
  const inbound = message.direction === 'inbound';
  const attachments: Array<Record<string, any>> = Array.isArray(message.attachments) ? message.attachments : [];
  return (
    <li className={cn('rounded-lg border p-3', inbound ? 'border-line bg-surface-2/50' : 'border-accent/25 bg-accent-soft/25')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-ink">{inbound ? 'Received' : 'Sent'}{message.from_name || message.from_email ? ` · ${message.from_name || message.from_email}` : ''}</p>
        {message.sent_at ? <p className="text-2xs text-ink-3"><DateText value={String(message.sent_at)} /></p> : null}
      </div>
      {message.subject ? <p className="mt-1 text-sm font-medium text-ink-2">{String(message.subject)}</p> : null}
      {message.body_html
        ? <div className="prose-email mt-2 text-sm leading-relaxed text-ink-2" dangerouslySetInnerHTML={{ __html: String(message.body_html) }} />
        : <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{String(message.body_text || '')}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-ink-3">
        {message.blocked_remote_images ? <span className="flex items-center gap-1"><ImageOff className="h-3 w-3" />Images from elsewhere were not loaded.</span> : null}
        {message.blocked_active_content ? <span className="flex items-center gap-1 text-warn"><ShieldAlert className="h-3 w-3" />Something that could run was removed.</span> : null}
        {attachments.map((a, i) => (
          <span key={i} className="flex items-center gap-1"><Paperclip className="h-3 w-3" />{String(a.filename || a.name || 'Attachment')}</span>
        ))}
      </div>
    </li>
  );
}

function Mailboxes() {
  const toast = useToast();
  const qc = useQueryClient();
  const connectors = useConnectors();
  const [cloud, setCloud] = useState('usgov');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ id: string; plan: Record<string, any> } | null>(null);

  const add = async () => {
    if (!label.trim()) { toast.error('Name the mailbox so you can tell them apart.'); return; }
    setBusy(true);
    try {
      await api.createConnector({ provider: 'microsoft365', cloud, account_label: label });
      setLabel('');
      qc.invalidateQueries({ queryKey: correspondenceKeys.connectors });
      toast.success('Mailbox added. Nothing is read until it is authorized.');
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Connect a mailbox" subtitle="read-only, and only after you authorize it">
        <div className="space-y-3">
          <Field label="Which Microsoft cloud" hint="never guessed from your address">
            <Select
              value={cloud}
              onValueChange={setCloud}
              options={(connectors.data?.clouds || []).map((c) => ({ value: c.value, label: c.label }))}
            />
          </Field>
          <Field label="Mailbox name" required><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="G-8 shared inbox" /></Field>
          <Button variant="primary" size="sm" loading={busy} onClick={add}><Plug className="h-3.5 w-3.5" />Add mailbox</Button>
          <p className="text-xs leading-relaxed text-ink-3">
            Vantage asks for {(connectors.data?.scopes || []).join(', ') || 'read-only'} and nothing else. It never sends mail, never deletes
            mail, and a message deleted in the mailbox does not delete the record of the work.
          </p>
        </div>
      </Panel>

      <Panel title="Mailboxes">
        {connectors.isPending ? <Skeleton className="h-20" /> : connectors.data?.connectors.length ? (
          <ul className="space-y-2">
            {connectors.data.connectors.map((c: Record<string, any>) => (
              <li key={String(c.id)} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{String(c.account_label)}</p>
                    <p className="text-xs text-ink-3">{String(c.cloud)} · {String(c.status)}</p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="ghost" onClick={async () => {
                      try { const res = await api.connectorAuthorization(String(c.id)); setPlan({ id: String(c.id), plan: res.plan }); }
                      catch (err) { toast.error(api.errorText(err)); }
                    }}>What it would ask for</Button>
                    <Button size="xs" variant="ghost" onClick={async () => {
                      try { await api.deleteConnector(String(c.id)); qc.invalidateQueries({ queryKey: correspondenceKeys.connectors }); toast.success('Mailbox removed. The correspondence it brought in stays.'); }
                      catch (err) { toast.error(api.errorText(err)); }
                    }}>Remove</Button>
                  </div>
                </div>
                {plan?.id === String(c.id) && (
                  <dl className="mt-3 space-y-1 rounded-md border border-line bg-surface-2/50 p-3 text-2xs">
                    <div><dt className="eyebrow">Sign in at</dt><dd className="break-all text-ink-2">{String(plan.plan.authorize_url || plan.plan.authority || '')}</dd></div>
                    <div><dt className="eyebrow">Reads from</dt><dd className="break-all text-ink-2">{String(plan.plan.delta_url || plan.plan.graph_base || '')}</dd></div>
                    <div><dt className="eyebrow">Permissions</dt><dd className="text-ink-2">{(plan.plan.scopes || []).join(', ')}</dd></div>
                  </dl>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Plug} title="No mailbox connected" description="Until one is, import .eml files by hand. Both end up in the same place." />
        )}
      </Panel>
    </div>
  );
}
