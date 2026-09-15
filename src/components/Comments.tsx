import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Trash2, Pencil } from 'lucide-react';
import { Panel, Button, Textarea, Skeleton } from '@/components/ui/primitives';
import * as api from '@/lib/api';
import { useIdentity } from '@/lib/queries';
import { useToast } from '@/components/ui/toast';

/**
 * The conversation on a record.
 *
 * This component knows nothing about who may read what, deliberately. The server decides from the
 * host record, so the component asks and renders whatever comes back — a 403 means there is nothing
 * to show, not that the component should have hidden a button. That keeps one rule in one place
 * instead of two that can disagree.
 */

interface Comment {
  id: string;
  author_id: string;
  author_username: string;
  author_first_name: string;
  author_last_name: string;
  author_rank: string | null;
  body: string;
  mentions: string[];
  edited_at: string | null;
  created_at: string;
}

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const displayName = (c: Comment) =>
  [c.author_rank, `${c.author_first_name} ${c.author_last_name}`.trim() || c.author_username].filter(Boolean).join(' ');

/** Renders @name in the accent so a mention reads as one, without turning the body into HTML. */
function Body({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-ink-2">
      {text.split(/(@[A-Za-z0-9_.-]{2,64})/g).map((part, i) =>
        part.startsWith('@')
          ? <span key={i} className="font-medium text-accent">{part}</span>
          : <span key={i}>{part}</span>
      )}
    </p>
  );
}

export function Comments({ table, id, canModerate = false }: { table: api.Store; id: string; canModerate?: boolean }) {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const me = identity?.user?.id;
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['comments', table, id],
    queryFn: () => api.comments(table, id),
    enabled: Boolean(id),
  });
  const list: Comment[] = data?.comments || [];

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try { await api.addComment(table, id, body); setDraft(''); refetch(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const saveEdit = async (commentId: string) => {
    const body = editDraft.trim();
    if (!body) return;
    setBusy(true);
    try { await api.editComment(table, id, commentId, body); setEditing(null); refetch(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const remove = async (commentId: string) => {
    setBusy(true);
    try { await api.deleteComment(table, id, commentId); refetch(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <Panel
      title="Discussion"
      subtitle={list.length ? `${list.length} ${list.length === 1 ? 'remark' : 'remarks'}` : 'Ask a question, or leave a note for whoever picks this up'}
    >
      {isLoading ? <Skeleton className="h-16" /> : (
        <>
          {list.length > 0 && (
            <ul className="mb-4 space-y-3">
              {list.map((c) => (
                <li key={c.id} className="rounded-lg border border-line bg-surface-2 p-3">
                  <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-ink">{displayName(c)}</span>
                    <span className="fig text-2xs text-ink-3">{when(c.created_at)}</span>
                    {c.edited_at && <span className="text-2xs text-ink-3">edited</span>}
                    <span className="ml-auto flex gap-1">
                      {c.author_id === me && editing !== c.id && (
                        <button type="button" className="text-ink-3 hover:text-ink" aria-label="Edit this remark"
                          onClick={() => { setEditing(c.id); setEditDraft(c.body); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {(c.author_id === me || canModerate) && (
                        <button type="button" className="text-ink-3 hover:text-bad" aria-label="Remove this remark"
                          onClick={() => remove(c.id)} disabled={busy}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                  {editing === c.id ? (
                    <div className="space-y-2">
                      <Textarea rows={3} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} aria-label="Edit your remark" />
                      <span className="flex gap-2">
                        <Button size="xs" variant="primary" loading={busy} onClick={() => saveEdit(c.id)}>Save</Button>
                        <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </span>
                    </div>
                  ) : <Body text={c.body} />}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2">
            <Textarea
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type @ to name somebody who can already see this record."
              aria-label="Write a remark"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void post(); } }}
            />
            <span className="flex items-center gap-2">
              <Button size="sm" variant="primary" loading={busy} disabled={!draft.trim()} onClick={post}>
                <MessageSquare className="h-3.5 w-3.5" />Post
              </Button>
              <span className="text-2xs text-ink-3">A remark is only visible to whoever can already see this record.</span>
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}
