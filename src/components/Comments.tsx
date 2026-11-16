import { useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Check, CircleHelp, ClipboardCheck, CornerDownRight, Lock, MessageSquare, Pencil, Send, StickyNote, Trash2, Undo2 } from 'lucide-react';
import { Badge, Button, Panel, Skeleton, Textarea, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { QueryFailure } from '@/components/QueryFailure';
import { PersonPicker } from '@/components/PersonPicker';
import * as api from '@/lib/api';
import { discussionKey, keys, useDiscussion, useIdentity } from '@/lib/queries';
import { cn, formatStamp, timeAgo } from '@/lib/utils';
import {
  ANSWER_MAX, COMMENT_MAX, REQUEST_KIND_LABELS, REQUEST_MAX, REQUEST_STATE_LABELS, isRequestKind,
  type DiscussionEntry, type RequestKind, type RequestState, type Speaker, type Told,
} from '../../shared/workflowMessages';

/**
 * A record's or a work case's Discussion (ADR-0031). Everything said here hangs on what it is about and is read by those
 * who read that: comments (records only; a case keeps its own notes in its history), questions and review requests to
 * one named person, their answers, and the note an assignment carries. Nothing here is a chat.
 */

type Mode = 'comment' | RequestKind;
type Refresh = (requests?: boolean) => void;
type Say = (text: string) => void;

const STATE_TONE: Record<RequestState, Tone> = {
  open: 'info', answered: 'good', looks_right: 'good', needs_changes: 'warn', withdrawn: 'neutral', closed: 'neutral',
};

const authorName = (e: DiscussionEntry) =>
  [e.author_rank, `${e.author_first_name} ${e.author_last_name}`.trim() || e.author_username].filter(Boolean).join(' ');

/** "A", "A and B", "A, B and C". */
const joinNames = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What a comment did, in words: who it told, and which @names reached nobody who can see the record. */
function toldLine(done: string, told: Told) {
  const parts = [done];
  if (told.told.length) parts.push(`${joinNames(told.told.map((t) => t.name))} ${told.told.length === 1 ? 'was' : 'were'} told you named them.`);
  if (told.not_told.length) parts.push(`${joinNames(told.not_told)} did not reach anyone who can see this record, so nobody was told.`);
  return parts.join(' ');
}

function When({ at }: { at: string }) {
  return <time dateTime={at} title={formatStamp(at)} className="fig text-2xs text-ink-3">{timeAgo(at)}</time>;
}

/** The words, with each @name picked out. An @ after a letter or digit (an e-mail address) names nobody. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9_.-]{2,64})/g);
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-ink-2">
      {parts.map((part, i) => {
        const named = i % 2 === 1 && !/[A-Za-z0-9_.-]$/.test(parts[i - 1] ?? '');
        return named ? <span key={i} className="font-medium text-accent">{part}</span> : <span key={i}>{part}</span>;
      })}
    </p>
  );
}

/** How much is written, against the most a message may hold. */
function Count({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length > max;
  return (
    <span id={id} className={cn('fig text-2xs', over ? 'font-medium text-bad' : 'text-ink-3')}>
      {over ? `Keep it under ${max.toLocaleString()} characters: ${(length - max).toLocaleString()} too many.` : (
        <><span aria-hidden>{length.toLocaleString()}/{max.toLocaleString()}</span><span className="sr-only">{length.toLocaleString()} of {max.toLocaleString()} characters</span></>
      )}
    </span>
  );
}

const sendKey = (e: React.KeyboardEvent, send: () => void) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
};

interface DiscussionProps {
  host: api.DiscussionHost;
  /** May remove others' comments: holds Manage records in the record's unit. */
  canModerate?: boolean;
  /** On a counseling: the other party's name, for what is said between the viewer and them. */
  between?: string;
  /** On a counseling not yet final: what is said now stays between its counselor and its Marine. */
  privateNow?: boolean;
  className?: string;
}

/** One panel per record: a draft, a chosen person or a status line never carries over to the next record shown in its place. */
export function Discussion(props: DiscussionProps) {
  const { host } = props;
  return <DiscussionPanel key={`${host.kind === 'record' ? host.table : 'work_items'}:${host.id}`} {...props} />;
}

function DiscussionPanel({ host, canModerate = false, between, privateNow = false, className }: DiscussionProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const me = identity?.user?.id;
  const thread = useDiscussion(host);
  const isCase = host.kind === 'work';
  const table = host.kind === 'record' ? host.table : 'work_items';
  const [status, setStatus] = useState('');
  const [removing, setRemoving] = useState<DiscussionEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  const entries = useMemo(() => thread.data?.comments ?? [], [thread.data]);
  const { top, answers } = useMemo(() => {
    const requests = new Set(entries.filter((e) => isRequestKind(e.kind)).map((e) => e.id));
    const byRequest = new Map<string, DiscussionEntry[]>();
    const shown: DiscussionEntry[] = [];
    for (const e of entries) {
      if (e.kind === 'answer' && e.reply_to && requests.has(e.reply_to)) byRequest.set(e.reply_to, [...(byRequest.get(e.reply_to) ?? []), e]);
      else shown.push(e);
    }
    return { top: shown, answers: byRequest };
  }, [entries]);

  const refresh: Refresh = (requests = false) => {
    void qc.invalidateQueries({ queryKey: discussionKey(host) });
    if (requests) void qc.invalidateQueries({ queryKey: keys.notifications });
  };
  const say: Say = (text) => setStatus(text);

  const modes: Array<{ value: Mode; label: string; icon: typeof MessageSquare }> = [
    ...(isCase ? [] : [{ value: 'comment' as const, label: 'Comment', icon: MessageSquare }]),
    { value: 'clarification_request', label: 'Ask a question', icon: CircleHelp },
    // A counseling is reviewed by sharing it with its Marine (ADR-0027): there is no second way to ask.
    ...(table === 'counselings' ? [] : [{ value: 'review_request' as const, label: 'Ask for review', icon: ClipboardCheck }]),
  ];

  const remove = async () => {
    const entry = removing;
    if (!entry || host.kind !== 'record') return;
    setRemoveBusy(true);
    try {
      await api.deleteComment(host.table, host.id, entry.id);
      // Off the page before the dialog gives focus back, so it is not handed to a button about to vanish.
      qc.setQueryData<{ comments: DiscussionEntry[] }>(discussionKey(host), (old) => (old ? { comments: old.comments.filter((c) => c.id !== entry.id) } : old));
      say('Comment removed.');
      window.setTimeout(() => { if (document.activeElement === document.body || !document.activeElement) composer.current?.focus({ preventScroll: true }); }, 120);
      refresh();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setRemoveBusy(false); }
  };

  const count = top.length;
  return (
    <Panel
      title="Discussion"
      className={className}
      subtitle={isCase
        ? 'Ask someone a question about this case, or ask them to review it. Its own notes stay in its history.'
        : count ? `${count} ${count === 1 ? 'remark' : 'remarks'}` : 'Ask a question, or leave a note for whoever picks this up'}
    >
      {thread.isPending ? <Skeleton className="h-16" />
        : thread.isError ? <QueryFailure error={thread.error} onRetry={() => void thread.refetch()} what="This discussion" className="rounded-xl ring-1 ring-inset ring-line" />
          : (
            <>
              {top.length > 0 ? (
                <ol className="mb-4 space-y-3" aria-label="What has been said">
                  {top.map((e) => (
                    <EntryItem key={e.id} entry={e} answers={answers.get(e.id) ?? []} host={host} me={me} canModerate={canModerate} between={between}
                      say={say} refresh={refresh} onRemove={setRemoving} />
                  ))}
                </ol>
              ) : (
                <p className="mb-4 text-sm text-ink-3">{isCase ? 'Nobody has asked anything about this case yet.' : 'Nothing has been said here yet.'}</p>
              )}
              <Composer host={host} modes={modes} privateNow={privateNow} between={between} say={say} refresh={refresh} textarea={composer} />
            </>
          )}
      <p role="status" aria-live="polite" className={cn('text-xs leading-relaxed text-ink-2', status ? 'mt-2' : 'sr-only')}>{status}</p>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title="Remove this comment?"
        confirmLabel="Remove"
        loading={removeBusy}
        body={removing && removing.author_id !== me
          ? 'You are removing someone else’s comment as a moderator. It comes off this discussion for everyone, and the removal is recorded.'
          : 'It comes off this discussion for everyone who can see the record. This cannot be undone.'}
        onConfirm={remove}
      />
    </Panel>
  );
}

/** The name the app has long used for this panel. */
export const Comments = Discussion;

function EntryItem({ entry: e, answers, host, me, canModerate, between, say, refresh, onRemove }: {
  entry: DiscussionEntry; answers: DiscussionEntry[]; host: api.DiscussionHost; me: string | undefined; canModerate: boolean; between?: string;
  say: Say; refresh: Refresh; onRemove: (e: DiscussionEntry) => void;
}) {
  const self = useRef<HTMLLIElement | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = e.author_id === me;
  const author = mine ? 'You' : authorName(e);
  const focusSelf = () => requestAnimationFrame(() => self.current?.focus({ preventScroll: true }));
  const other = between ?? (!mine ? authorName(e) : e.addressee_name ?? 'the other party');
  const privately = e.private && (
    <Badge tone="neutral" className="gap-1"><Lock className="h-3 w-3" aria-hidden />Between you and {other}</Badge>
  );

  // A comment, or an answer whose question is not here to hang it under.
  if (e.kind === 'comment' || e.kind === 'answer') {
    const plain = e.kind === 'comment' && host.kind === 'record';
    const canEdit = plain && mine;
    const canRemove = plain && (mine || canModerate);
    const editLength = editDraft.trim().length;
    const closeEdit = () => { setEditing(false); setEditError(null); requestAnimationFrame(() => editButton.current?.focus()); };
    const saveEdit = async () => {
      const body = editDraft.trim();
      if (!body || host.kind !== 'record') return;
      if (body.length > COMMENT_MAX) { setEditError(`Keep it under ${COMMENT_MAX.toLocaleString()} characters.`); return; }
      setBusy(true); setEditError(null);
      try {
        const res = await api.editComment(host.table, host.id, e.id, body);
        say(toldLine('Saved.', res));
        closeEdit();
        refresh();
      } catch (err) { setEditError(api.errorText(err)); }
      finally { setBusy(false); }
    };
    return (
      <li ref={self} tabIndex={-1} className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {e.kind === 'answer' && <span className="text-xs font-semibold text-ink-2">Answer</span>}
          <span className="text-sm font-medium text-ink">{author}</span>
          <When at={e.created_at} />
          {e.edited_at && <span className="text-2xs text-ink-3">edited</span>}
          {privately}
          {(canEdit || canRemove) && !editing && (
            <span className="ml-auto flex gap-1">
              {canEdit && (
                <Button ref={editButton} size="xs" variant="ghost" className="[@media(pointer:coarse)]:min-w-11" aria-label="Edit your comment"
                  onClick={() => { setEditing(true); setEditDraft(e.body); setEditError(null); }}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />Edit
                </Button>
              )}
              {canRemove && (
                <Button size="xs" variant="ghost" className="hover:text-bad [@media(pointer:coarse)]:min-w-11" aria-label={mine ? 'Remove your comment' : `Remove ${authorName(e)}’s comment`}
                  onClick={() => onRemove(e)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />Remove
                </Button>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <Textarea rows={3} value={editDraft} onChange={(ev) => setEditDraft(ev.target.value)} aria-label="Edit your remark" aria-describedby={`${uid}-count`}
              aria-invalid={editLength > COMMENT_MAX || undefined} onKeyDown={(ev) => sendKey(ev, () => void saveEdit())} autoFocus />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" loading={busy} disabled={!editLength || editLength > COMMENT_MAX} onClick={() => void saveEdit()}>Save</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={closeEdit}>Cancel</Button>
              <span className="ml-auto"><Count id={`${uid}-count`} length={editLength} max={COMMENT_MAX} /></span>
            </div>
            {editError && <p role="alert" className="text-xs text-bad">{editError}</p>}
          </div>
        ) : <Body text={e.body} />}
      </li>
    );
  }

  if (e.kind === 'assignment_note') {
    return (
      <li ref={self} tabIndex={-1} className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StickyNote className="h-3.5 w-3.5 text-ink-3" aria-hidden />
          <span className="text-sm font-semibold text-ink">Note with the assignment</span>
          {e.addressee_name && <span className="text-xs text-ink-3">for {e.addressee_id === me ? 'you' : e.addressee_name}</span>}
        </div>
        <p className="mb-1 flex flex-wrap items-center gap-x-2 text-2xs text-ink-3"><span>From {mine ? 'you' : authorName(e)}</span><When at={e.created_at} />{privately}</p>
        <Body text={e.body} />
      </li>
    );
  }

  // A question or a review request, with its answers under it.
  const kind = e.kind as RequestKind;
  const state = (e.state ?? 'open') as RequestState;
  const open = state === 'open';
  const toMe = e.addressee_id === me;
  const addressee = toMe ? 'you' : e.addressee_name ?? 'someone';
  const lost = open && e.can_answer === false;
  const Icon = kind === 'review_request' ? ClipboardCheck : CircleHelp;
  const answerLabel = kind === 'clarification_request' ? 'Answer' : state === 'needs_changes' ? 'Needs changes' : state === 'looks_right' ? 'Looks right' : 'Answer';
  const withdraw = async () => {
    setBusy(true);
    try {
      await api.withdrawRequest(host, e.id);
      say(`Withdrawn. ${e.addressee_name ?? 'They'} ${e.addressee_name ? 'is' : 'are'} no longer asked.`);
      focusSelf();
      refresh(true);
    } catch (err) { say(api.errorText(err)); refresh(true); }
    finally { setBusy(false); }
  };
  return (
    <li ref={self} tabIndex={-1} className={cn('rounded-lg border p-3', open ? 'border-info/30 bg-info/[.04]' : 'border-line bg-surface')}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className="h-3.5 w-3.5 text-ink-3" aria-hidden />
        <span className="text-sm font-semibold text-ink">{REQUEST_KIND_LABELS[kind]} to {addressee}</span>
        <Badge tone={STATE_TONE[state]}>{REQUEST_STATE_LABELS[state]}</Badge>
        {open && mine && (
          <span className="ml-auto">
            <Button size="xs" variant="ghost" loading={busy} className="[@media(pointer:coarse)]:min-w-11" aria-label={`Withdraw your ${REQUEST_KIND_LABELS[kind].toLowerCase()} to ${e.addressee_name ?? 'them'}`} onClick={() => void withdraw()}>
              <Undo2 className="h-3.5 w-3.5" aria-hidden />Withdraw
            </Button>
          </span>
        )}
      </div>
      <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-3"><span>Asked by {mine ? 'you' : authorName(e)}</span><When at={e.created_at} />{privately}</p>
      <Body text={e.body} />
      {lost && <p className="mt-2 text-xs text-warn">{toMe ? 'You can no longer answer this here.' : `${e.addressee_name ?? 'They'} can no longer answer this here.`}{mine ? ' You can withdraw it.' : ''}</p>}
      {answers.length > 0 && (
        <ol className="mt-2 space-y-2 border-l-2 border-line pl-3" aria-label={`Answers to this ${REQUEST_KIND_LABELS[kind].toLowerCase()}`}>
          {answers.map((a) => (
            <li key={a.id}>
              <p className="mb-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-3">
                <CornerDownRight className="h-3 w-3" aria-hidden />
                <span className="font-semibold text-ink-2">{answerLabel}</span>
                <span>{a.author_id === me ? 'You' : authorName(a)}</span>
                <When at={a.created_at} />
              </p>
              <Body text={a.body} />
            </li>
          ))}
        </ol>
      )}
      {open && toMe && !lost && <AnswerForm host={host} request={e} asker={mine ? 'You' : authorName(e)} say={say} refresh={refresh} onAnswered={focusSelf} />}
    </li>
  );
}

/** Answering what was asked of me: a question takes words; a review comes back looking right, or needing changes and what. */
function AnswerForm({ host, request, asker, say, refresh, onAnswered }: {
  host: api.DiscussionHost; request: DiscussionEntry; asker: string; say: Say; refresh: Refresh; onAnswered: () => void;
}) {
  const uid = useId();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const review = request.kind === 'review_request';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'answer' | 'looks_right' | 'needs_changes'>(null);
  const body = text.trim();
  const over = body.length > ANSWER_MAX;

  const send = async (outcome?: 'looks_right' | 'needs_changes') => {
    if (!review && !body) { setError('Write your answer first.'); area.current?.focus(); return; }
    if (outcome === 'needs_changes' && !body) { setError('Say what needs changing first.'); area.current?.focus(); return; }
    if (over) { setError(`Keep it under ${ANSWER_MAX.toLocaleString()} characters.`); area.current?.focus(); return; }
    setBusy(outcome ?? 'answer'); setError(null);
    try {
      await api.answerRequest(host, request.id, review ? { outcome, ...(body ? { body } : {}) } : { body });
      say(review
        ? `${outcome === 'looks_right' ? 'You said it looks right.' : 'You said it needs changes.'} ${asker} ${asker === 'You' ? 'are' : 'is'} told.`
        : `Answered. ${asker} ${asker === 'You' ? 'are' : 'is'} told.`);
      onAnswered();
      refresh(true);
    } catch (e) { setError(api.errorText(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="mt-3 space-y-2 rounded-lg bg-surface p-3 ring-1 ring-inset ring-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <label htmlFor={`${uid}-text`} className="text-sm font-medium text-ink">
          {review ? 'Your note' : 'Your answer'}<span className="sr-only"> to {asker === 'You' ? 'your own' : `${asker}’s`} {review ? 'review request' : 'question'}</span>
        </label>
        <span id={`${uid}-hint`} className="text-xs text-ink-3">{review ? 'Optional if it looks right. Say what needs changing if it does not.' : `${asker} is told when you answer.`}</span>
      </div>
      <Textarea ref={area} id={`${uid}-text`} rows={2} value={text} onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        aria-describedby={`${uid}-hint ${uid}-count${error ? ` ${uid}-error` : ''}`} aria-invalid={Boolean(error) || over || undefined}
        onKeyDown={(e) => { if (!review) sendKey(e, () => void send()); }} />
      <div className="flex flex-wrap items-center gap-2">
        {review ? (
          <>
            <Button size="sm" variant="primary" loading={busy === 'looks_right'} disabled={Boolean(busy)} onClick={() => void send('looks_right')}><Check className="h-3.5 w-3.5" aria-hidden />Looks right</Button>
            <Button size="sm" loading={busy === 'needs_changes'} disabled={Boolean(busy)} onClick={() => void send('needs_changes')}><Pencil className="h-3.5 w-3.5" aria-hidden />Needs changes</Button>
          </>
        ) : (
          <Button size="sm" variant="primary" loading={busy === 'answer'} disabled={Boolean(busy)} onClick={() => void send()}><Send className="h-3.5 w-3.5" aria-hidden />Answer</Button>
        )}
        <span className="ml-auto"><Count id={`${uid}-count`} length={body.length} max={ANSWER_MAX} /></span>
      </div>
      {error && <p id={`${uid}-error`} role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}

/** Saying something new: a comment (records only), a question, or a request for review, each to the people of this record. */
function Composer({ host, modes, privateNow, between, say, refresh, textarea }: {
  host: api.DiscussionHost;
  modes: Array<{ value: Mode; label: string; icon: typeof MessageSquare }>;
  privateNow: boolean; between?: string; say: Say; refresh: Refresh;
  textarea: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const uid = useId();
  const [mode, setMode] = useState<Mode>(modes[0].value);
  const [draft, setDraft] = useState('');
  const [person, setPerson] = useState<Speaker | null>(null);
  const [picking, setPicking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const asking = mode !== 'comment';
  const max = asking ? REQUEST_MAX : COMMENT_MAX;
  const body = draft.trim();
  const over = body.length > max;
  const table = host.kind === 'record' ? host.table : 'work_items';

  const focusText = (caret?: number) => requestAnimationFrame(() => {
    const el = textarea.current;
    if (!el) return;
    el.focus();
    if (caret != null) el.setSelectionRange(caret, caret);
  });

  /** Puts @username where the caret was, with a space either side as needed. */
  const insertMention = (p: Speaker) => {
    const el = textarea.current;
    const start = el ? el.selectionStart : draft.length;
    const end = el ? el.selectionEnd : draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const insert = `${before && !/\s$/.test(before) ? ' ' : ''}@${p.username}${/^\s/.test(after) ? '' : ' '}`;
    setDraft(before + insert + after);
    setNaming(false);
    say(`Added @${p.username}. ${p.name} is told when you post.`);
    focusText(before.length + insert.length);
  };

  const send = async () => {
    if (busy) return;
    if (!body) { setError(asking ? 'Write what you are asking first.' : 'Write the comment first.'); focusText(); return; }
    if (over) { setError(`Keep it under ${max.toLocaleString()} characters.`); focusText(); return; }
    if (asking && !person) { setError('Choose who to ask first.'); requestAnimationFrame(() => picker.current?.focus()); return; }
    setBusy(true); setError(null);
    try {
      if (!asking) {
        if (host.kind !== 'record') return;
        const res = await api.addComment(host.table, host.id, body);
        setDraft('');
        say(toldLine('Posted.', res));
        refresh();
      } else {
        await api.askRequest(host, { kind: mode, addressee_id: person!.id, body });
        setDraft('');
        setPerson(null);
        say(`Asked ${person!.name}. They are told, and their answer will show here.`);
        refresh(true);
      }
    } catch (e) { setError(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const label = mode === 'comment' ? 'Write a remark' : mode === 'clarification_request' ? 'Your question' : 'What should they review';
  const placeholder = mode === 'comment' ? 'Type @ to name somebody who can already see this record.'
    : mode === 'clarification_request' ? 'What do you need to know?' : 'Say what to look at, and what you need from them.';
  const askHint = table === 'duties' && mode === 'review_request' ? 'Ask someone who reviews duty in its unit. Its Marine cannot review it.' : undefined;
  const where = privateNow && between
    ? `What you say here now stays between you and ${between}.`
    : host.kind === 'work'
      ? 'Only people who can already open this case can be asked.'
      : asking ? 'Only people who can already see this record can be asked. They are told you asked.' : 'A remark is only visible to whoever can already see this record.';
  const SendIcon = asking ? Send : MessageSquare;

  return (
    <div className="space-y-2.5" id={`${uid}-composer`}>
      {modes.length > 1 && (
        <fieldset>
          <legend className="sr-only">What to say</legend>
          <div className="flex flex-wrap gap-1.5">
            {modes.map((m) => {
              const ModeIcon = m.icon;
              return (
                <label key={m.value} className="relative">
                  <input type="radio" name={`${uid}-mode`} value={m.value} checked={mode === m.value} className="peer sr-only"
                    onChange={() => { setMode(m.value); setError(null); setNaming(false); }} />
                  <span className="tap inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-ink peer-checked:bg-accent-soft peer-checked:text-accent peer-checked:ring-accent/30 peer-focus-visible:shadow-[0_0_0_2px_rgb(var(--surface)),0_0_0_4px_rgb(var(--accent)/.6)]">
                    <ModeIcon className="h-3.5 w-3.5" aria-hidden />{m.label}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {asking && (person && !picking ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-ink-3">Asking</span>
          <span className="font-medium text-ink">{person.name}</span>
          <Button size="xs" variant="ghost" className="[@media(pointer:coarse)]:min-w-11" aria-label={`Change who to ask, now ${person.name}`} onClick={() => setPicking(true)}>Change</Button>
        </p>
      ) : (
        <PersonPicker host={host} label="Ask whom" hint={askHint} autoFocus={picking} inputRef={picker}
          onChoose={(p) => { setPerson(p); setPicking(false); setError(null); focusText(); }}
          onCancel={person ? () => { setPicking(false); focusText(); } : undefined} />
      ))}

      <label htmlFor={`${uid}-text`} className="sr-only">{label}</label>
      <Textarea
        ref={textarea}
        id={`${uid}-text`}
        rows={3}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        placeholder={placeholder}
        aria-describedby={`${uid}-count ${uid}-where${error ? ` ${uid}-error` : ''}`}
        aria-invalid={over || undefined}
        onKeyDown={(e) => sendKey(e, () => void send())}
      />

      {naming && mode === 'comment' && (
        <PersonPicker host={host} label="Name someone" hint="They are told you named them when you post." autoFocus
          onChoose={insertMention} onCancel={() => { setNaming(false); focusText(); }} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!body} onClick={() => void send()}>
          <SendIcon className="h-3.5 w-3.5" aria-hidden />{mode === 'comment' ? 'Post' : mode === 'clarification_request' ? 'Ask' : 'Ask for review'}
        </Button>
        {mode === 'comment' && (
          <Button size="sm" variant="ghost" aria-expanded={naming} onClick={() => setNaming((v) => !v)}>
            <AtSign className="h-3.5 w-3.5" aria-hidden />Name someone
          </Button>
        )}
        <span className="ml-auto"><Count id={`${uid}-count`} length={body.length} max={max} /></span>
      </div>
      {error && <p id={`${uid}-error`} role="alert" className="text-xs text-bad">{error}</p>}
      <p id={`${uid}-where`} className="text-2xs text-ink-3">{where}</p>
    </div>
  );
}
