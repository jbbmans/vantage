import { plain } from './realize.ts';
import type { Sentence } from './compose.ts';

/** Where an edit's areas are named: the headings over bullets, the labels before a paragraph's sentences. */
export interface EditLayout { areas: readonly string[]; labels: Record<string, string>; headers?: Record<string, string> }

/**
 * One sentence of an edit: one the writer wrote, found unchanged (`kept`), or one the Marine typed or changed. `area`
 * is the area of the heading or label it sits under, when there is one.
 */
export type Piece = { kind: 'kept'; sentence: Sentence; area: string | null; at: number } | { kind: 'typed'; text: string; area: string | null; at: number };

// A title's, a rank's or a date's abbreviation is not the end of a sentence: "Lt. Col. Smith", "No. 1", "12 Mar. 2026".
const ABBREVIATIONS = [
  'Lt', 'Col', 'Capt', 'Maj', 'Gen', 'Sgt', 'Cpl', 'Pvt', 'Pfc', 'LCpl', 'SSgt', 'GySgt', 'MSgt', 'MGySgt', '1stSgt', 'SgtMaj', '1stLt', '2ndLt',
  'LtCol', 'BGen', 'MajGen', 'LtGen', 'CWO', 'WO', 'Adm', 'Cdr', 'Cmdr', 'Mr', 'Mrs', 'Ms', 'Dr', 'St', 'Ft', 'Mt', 'No', 'Nos', 'Vol', 'Jr', 'Sr',
  'Co', 'Bn', 'Regt', 'Div', 'Dept', 'Bldg', 'Qtr', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'vs',
  'etc', 'approx', 'U\\.S', 'e\\.g', 'i\\.e', 'a\\.m', 'p\\.m',
];
const SENTENCE_END = new RegExp(`(?<=[.!?])(?<!(?<![\\w.])(?:${ABBREVIATIONS.join('|')})\\.)\\s+(?=["'([$A-Z0-9-])`);
// What opens a list item: dashes and bullets, "1.", "(1)", "a)", "iv.", "o".
const ITEM = String.raw`\(?(?:\d{1,2}|[A-Za-z]|[ivxIVX]{2,4})[.)]`;
const MARKER = String.raw`(?:[-•*+>]+[ \t]*|(?:${ITEM}|o)[ \t]+)`;
const LEADING_MARKER = new RegExp(`^[ \\t]*${MARKER}`);
const ONLY_MARKER = new RegExp(`^[ \\t]*(?:${MARKER}|${ITEM}|[-•*+>]+)?[ \\t]*$`);
// "MISSION: Reconciled…": a label opens a paragraph's area where a paragraph can have one: at the start of a line, after
// a list marker, or after a sentence ends. "Taught 3 classes on Leadership: counseling…" is one sentence. The label may
// end its line, with the sentences on the next.
const LABEL = new RegExp(String.raw`(?<=(?:^|\n)[ \t]*|(?:^|\n)[ \t]*${MARKER}|[.!?;][ \t]+)([A-Z][A-Za-z /&()-]{1,48}):(?:[ \t]+|[ \t]*(?=\n|$))`, 'g');
// A line break inside a sentence wrapped by hand: the line runs on, and the next starts in lower case, not with a marker.
// (A sentence the writer wrote is found across any line break; this is for what was typed.)
const WRAP = new RegExp(`(?<=[^.!?:\\s][ \\t]*)\\n(?=[ \\t]*[a-z$(])(?![ \\t]*(?:${ITEM}|o)[ \\t])`, 'g');
const speaks = (s: string) => /[A-Za-z0-9]/.test(s);
// The words a heading names an area by, for matching: "MOS & Mission Accomplishment", "Mission Accomplishments (MOS)"
// and "mos / mission accomplishment" are one. Joining words are left out and a plural is read as one.
const STOP = new Set(['and', 'or', 'of', 'the', 'for']);
const wordsOf = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter((w) => w && !STOP.has(w));
const one = (w: string) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
const areaWordsOf = (s: string) => wordsOf(s).map(one);
// A word that names no area by itself: "Accomplishments" over a list is a title.
const GENERIC = new Set(['accomplishment', 'individual', 'responsibilitie', 'fulfillment']);
// A FITREP section's letter beside its name ("D: Mission Accomplishment", "Leadership (Section F)") names nothing more.
const SECTION = /^(?:section|[a-h])$/;
/**
 * A line that only names the text, as a title or a line of the record above it, and is no sentence: "Billet
 * accomplishments", "JEPES input", "Section C comments", "Period: 1 Jun 2025 - 30 Nov 2026". Any other line is read.
 */
const TITLE_WORDS = new Set([
  'jepes', 'fitrep', 'billet', 'section', 'c', 'i', 'input', 'inputs', 'narrative', 'accomplishment', 'accomplishments', 'bullet', 'bullets', 'comment',
  'comments', 'directed', 'remarks', 'summary', 'period', 'reporting', 'quarterly', 'semiannual', 'annual', 'draft', 'my', 'performance',
]);
const RECORD_LINE = /^(?:reporting period|period|dates?|name|rank|grade|billet|unit|occasion|from|to)[ \t]*:[^.!?;]*$/i;
function titleLine(line: string) {
  if (LEADING_MARKER.test(line)) return false;
  const t = line.trim().replace(/:$/, '');
  if (RECORD_LINE.test(t)) return true;
  const words = wordsOf(t);
  return words.length > 0 && words.length <= 6 && !/[.!?;,\d$%]/.test(t) && words.every((w) => TITLE_WORDS.has(w));
}
// A dash between words, as typed (an em dash, or "DAI--all cleared"), reads as a spaced one; a range keeps its own.
const spaceDashes = (s: string) => s.replace(/[ \t]*\u2014[ \t]*|[ \t]+\u2013[ \t]+|(?<=[A-Za-z)])(?:\u2013|--)(?=[A-Za-z])/g, ' - ');
/** Escapes text for a pattern, with each space matching any spacing, a line break included. */
const spaced = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, String.raw`(?:[ \t]*\n[ \t]*|[ \t]+)`);

/**
 * Reads an edit back against the narrative it was edited from. Each sentence the writer wrote that still stands as
 * written, at a sentence's start and end (spacing, the list marker and the final period aside), is kept with what it
 * was written from; the rest is split into sentences, at line breaks and sentence ends, under the heading or label
 * above it. A line wrapped by hand is one sentence; a line that only names something (a heading, a title) is none.
 * Nothing is read twice: a sentence pasted in twice is kept once and read from its words the second time.
 */
export function piecesOf(edit: string, sentences: readonly Sentence[], layout: EditLayout): Piece[] {
  // The break of a typed line wrapped by hand becomes a space; positions point into this text, not the edit.
  const text = plain(spaceDashes(edit)).replace(/\r\n?/g, '\n').replace(WRAP, ' ');
  const taken = new Uint8Array(text.length);
  const take = (from: number, to: number) => taken.fill(1, from, to);
  const free = (from: number, to: number) => !taken.subarray(from, to).some(Boolean);

  // Each area by the words its name, label and heading use; a heading names the one area whose words hold all of its own.
  const words = layout.areas.map((area) => ({ area, words: new Set([area, layout.labels[area], layout.headers?.[area]].flatMap((n) => (n ? areaWordsOf(n) : []))) }));
  const areaNamed = (s: string) => {
    const said = areaWordsOf(s).filter((w) => !SECTION.test(w));
    if (!said.length || said.length > 6 || said.every((w) => GENERIC.has(w))) return null;
    const hits = words.filter((a) => said.every((w) => a.words.has(w)));
    return hits.length === 1 ? hits[0].area : null;
  };
  // Where each heading, label or title starts; a title names no area, so what follows it is the entry's own.
  const markers: Array<{ at: number; area: string | null }> = [];

  // A line that is only an area's heading, as the writer puts it over bullets, or a title line: neither is a sentence.
  let pos = 0;
  for (const line of text.split('\n')) {
    const bare = line.replace(LEADING_MARKER, '').replace(/[\s:.-]+$/, '');
    const area = bare.length <= 60 ? areaNamed(bare) : null;
    if (area || titleLine(line)) { markers.push({ at: pos, area }); take(pos, pos + line.length); }
    pos += line.length + 1;
  }
  // An area's label in front of its sentences, as a paragraph has it.
  for (const m of text.matchAll(LABEL)) {
    const area = areaNamed(m[1]);
    if (area && free(m.index, m.index + m[0].length)) { markers.push({ at: m.index, area }); take(m.index, m.index + m[0].length); }
  }
  const areaAt = (at: number) => markers.filter((m) => m.at <= at).sort((x, y) => y.at - x.at)[0]?.area ?? null;

  // Where a sentence found at `i` starts, its list marker with it, or -1 when `i` is mid-sentence.
  // A marker already taken is the end of the sentence before it ("cut from 9 days to\n3. Reconciled"), not this one's.
  const startOf = (i: number) => {
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    if (ONLY_MARKER.test(text.slice(lineStart, i)) && free(lineStart, i)) return lineStart;
    return /[.!?:]$/.test(text.slice(0, i).replace(/[ \t]+$/, '')) ? i : -1;
  };
  const endsSentence = (end: number, period: boolean) => {
    const rest = text.slice(end);
    return rest === '' || (period ? /^\s/.test(rest) : /^[ \t]*(?:\n|$)/.test(rest));
  };
  const pieces: Piece[] = [];
  for (const s of sentences) {
    // Read with the edit's own dash rule, so an entry's "ULOs--all" is still found as written.
    const core = spaceDashes(s.text).replace(/\.$/, '');
    if (!speaks(core)) continue;
    // Found with any spacing between its words, so a line wrapped anywhere, before "DAI" or "14", is still the sentence.
    const find = new RegExp(spaced(core), 'g');
    for (let m = find.exec(text); m; m = find.exec(text)) {
      const i = m.index;
      const period = text[i + m[0].length] === '.';
      const end = i + m[0].length + (period ? 1 : 0);
      const start = startOf(i);
      if (start >= 0 && endsSentence(end, period) && free(start, end)) {
        pieces.push({ kind: 'kept', sentence: s, area: areaAt(i), at: i });
        take(start, end);
        break;
      }
      find.lastIndex = i + 1;
    }
  }

  // What is left, as the Marine typed it: a sentence per line, or per sentence end within a line.
  for (let i = 0; i < text.length;) {
    if (taken[i]) { i += 1; continue; }
    let j = i;
    while (j < text.length && !taken[j]) j += 1;
    let at = i;
    for (const line of text.slice(i, j).split('\n')) {
      let cursor = 0;
      for (const part of line.split(SENTENCE_END)) {
        const offset = Math.max(0, line.indexOf(part, cursor));
        cursor = offset + part.length;
        // A marker alone ("1.", "a)") opens the next item; it is no sentence.
        if (ONLY_MARKER.test(part)) continue;
        const clean = part.replace(LEADING_MARKER, '').trim();
        if (speaks(clean)) pieces.push({ kind: 'typed', text: clean, area: areaAt(at + offset), at: at + offset });
      }
      at += line.length + 1;
    }
    i = j;
  }
  return pieces.sort((a, b) => a.at - b.at);
}
