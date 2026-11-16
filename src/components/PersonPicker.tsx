import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import * as api from '@/lib/api';
import { discussionKey } from '@/lib/queries';
import { cn } from '@/lib/utils';
import type { RequestKind, Speaker, SpeakersResponse } from '../../shared/workflowMessages';

/** How long typing must pause before the people on a record are looked up. The lookup is rate limited. */
const DEBOUNCE_MS = 250;

/**
 * Where a picker that is not a record's discussion finds its people: a server search that offers only those the reader
 * may choose, and says (`more`) when it stopped at its limit before reading everyone who matched.
 */
export interface PersonSearch {
  /** Names the search in the query cache; what was typed is added to it. */
  key: readonly unknown[];
  load: (q: string) => Promise<SpeakersResponse>;
  /** The fewest letters it looks anyone up for: the server refuses fewer. */
  minLength?: number;
  /** What to say when nobody matches what was typed. */
  none: string;
}

/**
 * Choosing one person (ADR-0031): an ARIA 1.2 combobox over the people the server offers, by rank and name (never the
 * whole service). On a record or a case they are its own people (`host`); elsewhere a `search` finds them. Typing looks
 * them up after a pause, and a polite status says how many there are; Down opens the list and moves through it, Enter
 * chooses, Escape closes the list, then clears what was typed, then cancels. The list is part of the page, not a
 * floating layer, so it is never cut off inside a dialog.
 */
export function PersonPicker({ host, kind, search, label, hideLabel = false, hint, error, onChoose, onCancel, autoFocus = false, placeholder = 'Type a name', inputRef, className }: ({
  host: api.DiscussionHost;
  /** What they are to be asked, when they are asked something: the server offers only those who may be asked it. */
  kind?: RequestKind;
  search?: never;
} | { search: PersonSearch; host?: never; kind?: never }) & {
  /** What the field is for: "Ask whom", "Name someone". */
  label: string;
  hideLabel?: boolean;
  hint?: string;
  /** What is wrong with the choice, as a form field says it. */
  error?: string | null;
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
  const errorId = `${uid}-error`;
  const input = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const minLength = search?.minLength ?? 0;
  const tooShort = query.length < minLength;
  // A discussion's people are not under the discussion's own key: refreshing what was said must not look them up again.
  // By kind, since who may be asked for a review is not always who may be named.
  const prefix: readonly unknown[] = search ? search.key : ['discussion-people', ...discussionKey(host!).slice(1), kind ?? null];
  const people = useQuery({
    queryKey: [...prefix, query],
    queryFn: () => (search ? search.load(query) : api.discussionPeople(host!, query, kind)),
    enabled: open && !tooShort && (search ? true : Boolean(host?.id)),
    staleTime: 30_000,
    retry: false,
    // Earlier rows stay up while the next lookup runs, but only for the same search: a review may go to fewer people than
    // a question, so rows looked up for one are never offered for the other.
    placeholderData: (previous, previousQuery) => (JSON.stringify(previousQuery?.queryKey.slice(0, -1)) === JSON.stringify(prefix) ? previous : undefined),
  });
  const rows: Speaker[] = tooShort ? [] : people.data?.people ?? [];
  const optionId = (p: Speaker) => `${uid}-option-${p.id}`;
  const settled = tooShort || (!people.isFetching && query === text.trim());

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

  // The lookup stopped at its limit before it read everyone who matched: a name, or more of one, finds who is left.
  const more = !tooShort && Boolean(people.data?.more);
  const narrow = query ? 'type more of the name' : 'type a name';
  const status = !open ? ''
    : tooShort ? `Type at least ${minLength} letters of a name.`
      : people.isError ? api.errorText(people.error)
        : !settled && !rows.length ? 'Looking…'
          : !rows.length && more ? `Too many people to look through at once. To find someone, ${narrow}.`
            : !rows.length ? (search ? search.none : query ? 'Nobody by that name can be asked or named here.' : 'Nobody else can be asked or named here.')
              : `${rows.length} ${rows.length === 1 ? 'person' : 'people'} to choose from.${more ? ` There may be others: ${narrow} to find them.` : ''}`;
  const shownStatus = open && (people.isError || !rows.length || more) ? status : '';
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
          aria-describedby={[hint ? hintId : null, error ? errorId : null, statusId].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
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
            {p.username && <span className="shrink-0 text-xs text-ink-3">@{p.username}</span>}
          </li>
        ))}
      </ul>
      {error && <p id={errorId} className="mt-1 text-xs leading-snug text-bad" role="alert">{error}</p>}
      <p id={statusId} role="status" aria-live="polite" className={cn('text-xs text-ink-3', shownStatus ? 'mt-1.5' : 'sr-only')}>{status}</p>
    </div>
  );
}
