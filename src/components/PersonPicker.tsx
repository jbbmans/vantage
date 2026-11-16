import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import * as api from '@/lib/api';
import { discussionKey } from '@/lib/queries';
import { cn } from '@/lib/utils';
import type { RequestKind, Speaker } from '../../shared/workflowMessages';

/** How long typing must pause before the people on a record are looked up. The lookup is rate limited. */
const DEBOUNCE_MS = 250;

/**
 * Choosing one person who may be named or asked on a record or a case (ADR-0031): an ARIA 1.2 combobox over the record's
 * own people, by rank and name, as the server offers them (never the whole service). Typing looks them up after a pause;
 * Down opens the list and moves through it, Enter chooses, Escape closes the list, then clears what was typed, then
 * cancels. The list is part of the page, not a floating layer, so it is never cut off inside a dialog.
 */
export function PersonPicker({ host, kind, label, hideLabel = false, hint, onChoose, onCancel, autoFocus = false, placeholder = 'Type a name', inputRef, className }: {
  host: api.DiscussionHost;
  /** What they are to be asked, when they are asked something: the server offers only those who may be asked it. */
  kind?: RequestKind;
  /** What the field is for: "Ask whom", "Name someone". */
  label: string;
  hideLabel?: boolean;
  hint?: string;
  onChoose: (person: Speaker) => void;
  /** Escape with nothing typed and the list closed: the caller puts the picker away. */
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** The field itself, for a caller that puts the keyboard there ("choose who to ask first"). */
  inputRef?: React.MutableRefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const labelId = `${uid}-label`;
  const listId = `${uid}-list`;
  const hintId = `${uid}-hint`;
  const statusId = `${uid}-status`;
  const input = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const people = useQuery({
    // Not under the discussion's own key: refreshing what was said must not look the people up again. By kind, since who
    // may be asked for a review is not always who may be named.
    queryKey: ['discussion-people', ...discussionKey(host).slice(1), kind ?? null, query],
    queryFn: () => api.discussionPeople(host, query, kind),
    enabled: open && Boolean(host.id),
    staleTime: 30_000,
    retry: false,
    // Earlier rows stay up while the next lookup runs, but only for the same kind: a review may go to fewer people than a
    // question, so rows looked up for one are never offered for the other.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey.at(-2) === (kind ?? null) ? previous : undefined),
  });
  const rows: Speaker[] = people.data?.people ?? [];
  const optionId = (p: Speaker) => `${uid}-option-${p.id}`;
  const settled = !people.isFetching && query === text.trim();

  useEffect(() => { setActive(-1); }, [people.data]);

  // A dialog closes on Escape before the field hears it (Radix listens on the document, capturing). While Escape still
  // has something to do here (the field says so in data-escape), mark it handled first, so the dialog stays open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && e.target === input.current && input.current?.dataset.escape) e.preventDefault(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const choose = (p: Speaker) => {
    setOpen(false);
    setText('');
    setQuery('');
    setActive(-1);
    onChoose(p);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (rows.length) setActive((a) => (a + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (rows.length) setActive((a) => (a <= 0 ? rows.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      const pick = active >= 0 ? rows[active] : rows.length === 1 && settled ? rows[0] : null;
      e.preventDefault();
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      if (open) { setOpen(false); setActive(-1); }
      else if (text) setText('');
      else onCancel?.();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const status = !open ? ''
    : people.isError ? api.errorText(people.error)
      : !settled && !rows.length ? 'Looking…'
        : !rows.length ? (query ? 'Nobody by that name can be asked or named here.' : 'Nobody else can be asked or named here.')
          : `${rows.length} ${rows.length === 1 ? 'person' : 'people'} to choose from.`;
  const shownStatus = open && (people.isError || !rows.length) ? status : '';
  const expanded = open && rows.length > 0;
  const activeId = expanded && active >= 0 && rows[active] ? optionId(rows[active]) : undefined;

  return (
    <div className={cn('min-w-0', className)}>
      <div className={cn('mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5', hideLabel && 'sr-only')}>
        <label id={labelId} htmlFor={inputId} className="text-base font-medium text-ink">{label}</label>
        {hint && <span id={hintId} className="text-xs leading-snug text-ink-3">{hint}</span>}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          ref={(el) => { input.current = el; if (inputRef) inputRef.current = el; }}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={[hint ? hintId : null, statusId].filter(Boolean).join(' ')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          data-escape={open || text || onCancel ? 'handled' : undefined}
          value={text}
          placeholder={placeholder}
          className="field h-9 py-0 pl-9 pr-9"
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={() => { setOpen(false); setActive(-1); }}
        />
        {open && people.isFetching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-3" aria-hidden />}
      </div>
      <ul id={listId} role="listbox" aria-labelledby={labelId} hidden={!expanded}
        className="mt-1.5 max-h-64 overflow-y-auto rounded-xl bg-surface p-1 shadow-pop ring-1 ring-inset ring-line">
        {rows.map((p, i) => (
          <li key={p.id} id={optionId(p)} role="option" aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => { if (active !== i) setActive(i); }}
            onClick={() => choose(p)}
            className={cn('tap flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm', i === active ? 'bg-surface-2 text-ink' : 'text-ink-2')}>
            <span className="min-w-0 truncate font-medium text-ink">{p.name}</span>
            <span className="shrink-0 text-xs text-ink-3">@{p.username}</span>
          </li>
        ))}
      </ul>
      <p id={statusId} role="status" aria-live="polite" className={cn('text-xs text-ink-3', shownStatus ? 'mt-1.5' : 'sr-only')}>{status}</p>
    </div>
  );
}
