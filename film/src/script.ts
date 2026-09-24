/**
 * The films, as data.
 *
 * One source for everything that has to agree: the words ElevenLabs speaks, the captions, the
 * length of every scene, and where the score lands its hits. Change a line here and the voice,
 * the cut, the captions and the music all follow on the next render — nothing is timed by hand.
 *
 * Scene timing: a scene lasts `lead` seconds of air, then each of its lines (with `gap` after it),
 * then `tail`, and never less than `min`. Line durations come from the recorded voice; before a
 * voice exists they are estimated from the word count so the cut can be worked on.
 *
 * Every claim in these scripts has to be true of the product as it ships. The films run on the
 * synthetic demo, so every name and figure on screen is invented.
 */

export interface Line {
  id: string;
  text: string;
  /** Seconds of silence after the line, before the next one in the same scene. */
  gap?: number;
}

export interface Scene {
  id: string;
  lines: Line[];
  /** Air before the first line. */
  lead?: number;
  /** Air after the last line. */
  tail?: number;
  /** A floor, for scenes whose picture needs longer than their words. */
  min?: number;
  /** What the score does at the start of this scene. */
  cue?: 'hit' | 'rise' | 'lift' | 'hush' | 'resolve';
}

export interface Film {
  id: string;
  title: string;
  /** Published slot in src/config/videos.ts. */
  slot: string;
  scenes: Scene[];
  /** The score's key and tempo; chapters share the hero's palette at lower intensity. */
  score: { key: 'D' | 'F' | 'A'; bpm: number; intensity: number };
}

/** The narrator: Brian, "deep, resonant and comforting", on ElevenLabs' highest-fidelity model. */
export const VOICE = {
  voiceId: 'nPczCjzI2devNBz1zQrb',
  name: 'Brian',
  model: 'eleven_multilingual_v2',
  settings: { stability: 0.55, similarity_boost: 0.8, style: 0.18, use_speaker_boost: true, speed: 0.96 },
} as const;

export const HERO: Film = {
  id: 'hero',
  title: 'Vantage — Every action. A clearer picture.',
  slot: 'tour',
  score: { key: 'D', bpm: 72, intensity: 1 },
  scenes: [
    { id: 'open', lead: 1.6, tail: 0.3, cue: 'hush', lines: [
      { id: 'open-1', text: 'Somewhere tonight, a Marine is finishing work that no one will ever see.' },
    ] },
    { id: 'detail', lead: 0.2, tail: 0.4, lines: [
      { id: 'detail-1', text: 'Thirty reconciliations. A funding gap, caught in time.' },
    ] },
    { id: 'scatter', lead: 0.2, tail: 0.6, lines: [
      { id: 'scatter-1', text: 'By morning, most of it is gone.', gap: 0.3 },
      { id: 'scatter-2', text: 'Into a spreadsheet. An inbox. Somebody’s memory.' },
    ] },
    { id: 'title', lead: 1.0, tail: 2.0, min: 5, cue: 'hit', lines: [
      { id: 'title-1', text: 'Vantage keeps it.' },
    ] },
    { id: 'capture', lead: 0.3, tail: 0.6, cue: 'lift', lines: [
      { id: 'capture-1', text: 'Say what you did, once. Vantage reads the numbers, and shows you before it saves.' },
    ] },
    { id: 'queue', lead: 0.2, tail: 0.5, lines: [
      { id: 'queue-1', text: 'Your section’s work, in one queue. Claim it, and it’s yours.' },
    ] },
    { id: 'case', lead: 0.2, tail: 0.6, lines: [
      { id: 'case-1', text: 'Cases follow cited procedures. Evidence before action. Resolved only when verified.' },
    ] },
    { id: 'balance', lead: 0.2, tail: 0.8, cue: 'rise', lines: [
      { id: 'balance-1', text: 'Open commitments. Undelivered orders.', gap: 0.2 },
      { id: 'balance-2', text: 'Read in the order the money moves.' },
    ] },
    { id: 'sealed', lead: 0.2, tail: 0.6, lines: [
      { id: 'sealed-1', text: 'Every entry, signed into the history. Nothing important happens quietly.' },
    ] },
    { id: 'credit', lead: 0.2, tail: 0.6, cue: 'lift', lines: [
      { id: 'credit-1', text: 'And the credit goes to the Marine who did the work.' },
    ] },
    { id: 'report', lead: 0.2, tail: 0.6, lines: [
      { id: 'report-1', text: 'When evaluation season comes, the record is already written, and every line cites its source.' },
    ] },
    { id: 'lead', lead: 0.2, tail: 0.7, lines: [
      { id: 'lead-1', text: 'Leaders see the whole section at a glance.' },
    ] },
    { id: 'trust', lead: 0.3, tail: 0.8, cue: 'hush', lines: [
      { id: 'trust-1', text: 'Private by default. Built to run on your own network.' },
    ] },
    { id: 'end', lead: 0.4, tail: 3.2, min: 6, cue: 'resolve', lines: [
      { id: 'end-1', text: 'Vantage. Give good work a lasting record.' },
    ] },
  ],
};

/**
 * The chapters: how-to films for the field guide, recorded on the real application and cut in the
 * hero's style. `steps` pair each line with what the browser does while it is spoken.
 */
export const CHAPTERS: Film[] = [
  {
    id: 'quick-log', title: 'Quick Log: a record in one sentence', slot: 'quick-log',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 'ql-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 'ql-0', text: 'Quick Log.' }] },
      { id: 'ql-open', lead: 0.2, tail: 0.5, lines: [{ id: 'ql-1', text: 'The fastest way to keep a record. Press N, anywhere in Vantage.' }] },
      { id: 'ql-type', lead: 0.2, tail: 0.6, min: 5.5, lines: [{ id: 'ql-2', text: 'Write it the way you’d say it out loud.' }] },
      { id: 'ql-read', lead: 0.2, tail: 0.6, lines: [{ id: 'ql-3', text: 'Vantage reads the count, the dollar value and what kind of value it is, the system, and the date.' }] },
      { id: 'ql-save', lead: 0.2, tail: 0.8, lines: [{ id: 'ql-4', text: 'Check what it understood, then save. It lands in your record, dated, and yours.' }] },
      { id: 'ql-offline', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 'ql-5', text: 'No signal? It waits on your device, and syncs when you’re back.' }] },
    ],
  },
  {
    id: 'queue', title: 'Working a case', slot: 'queue',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 'q-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 'q-0', text: 'Working a case.' }] },
      { id: 'q-queue', lead: 0.2, tail: 0.5, lines: [{ id: 'q-1', text: 'Work arrives as a queue your whole section can see.' }] },
      { id: 'q-claim', lead: 0.2, tail: 0.6, lines: [{ id: 'q-2', text: 'Claim a case, and it’s on your list at once. Claiming isn’t credit. The work is.' }] },
      { id: 'q-step', lead: 0.2, tail: 0.6, lines: [{ id: 'q-3', text: 'The procedure shows the next step, and the form asks only for what that step needs.' }] },
      { id: 'q-calc', lead: 0.2, tail: 0.7, lines: [{ id: 'q-4', text: 'Record what you found, and Vantage calculates the candidate, citing every input.' }] },
      { id: 'q-decide', lead: 0.2, tail: 0.7, lines: [{ id: 'q-5', text: 'Decide, with your reason. A step that needs evidence first says so, before it refuses.' }] },
      { id: 'q-history', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 'q-6', text: 'Every entry is signed into the history. Hand it on, and each of you keeps exactly what you did.' }] },
    ],
  },
  {
    id: 'reading-a-balance', title: 'Reading a balance', slot: 'reading-a-balance',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 'b-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 'b-0', text: 'Reading a balance.' }] },
      { id: 'b-ref', lead: 0.2, tail: 0.5, lines: [{ id: 'b-1', text: 'The Reference is the FMRA desk reference, inside Vantage, with every statement cited.' }] },
      { id: 'b-enter', lead: 0.2, tail: 0.6, min: 5, lines: [{ id: 'b-2', text: 'Enter a document’s commitment, obligation, delivered, and paid.' }] },
      { id: 'b-read', lead: 0.2, tail: 0.7, lines: [{ id: 'b-3', text: 'Vantage names the open condition, the causes worth ruling out, who can act, and what would prove the fix.' }] },
      { id: 'b-dash', lead: 0.2, tail: 0.6, lines: [{ id: 'b-4', text: 'A dash on a report isn’t a zero. Mark it not shown.' }] },
      { id: 'b-case', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 'b-5', text: 'Open a case, and the figures come with it, labelled with where they came from.' }] },
    ],
  },
  {
    id: 'record', title: 'Your Record, and what counts', slot: 'record',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 'r-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 'r-0', text: 'Your Record.' }] },
      { id: 'r-three', lead: 0.2, tail: 0.6, lines: [{ id: 'r-1', text: 'It keeps three things apart. What you hold, which isn’t credit. What you contributed, counted from the work itself. And what you logged yourself.' }] },
      { id: 'r-count', lead: 0.2, tail: 0.6, lines: [{ id: 'r-2', text: 'One document counts once, however many entries it took.' }] },
      { id: 'r-draft', lead: 0.2, tail: 0.6, lines: [{ id: 'r-3', text: 'From any case you worked, prepare a private draft, built only from your own facts.' }] },
      { id: 'r-keep', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 'r-4', text: 'Keep it, and it lands in your record, with a link back to the case.' }] },
    ],
  },
  {
    id: 'report-studio', title: 'Report Studio', slot: 'report-studio',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 's-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 's-0', text: 'Report Studio.' }] },
      { id: 's-intro', lead: 0.2, tail: 0.5, lines: [{ id: 's-1', text: 'Report Studio turns your record into JEPES or FITREP input.' }] },
      { id: 's-period', lead: 0.2, tail: 0.6, lines: [{ id: 's-2', text: 'Choose the period, and the entries it should cite.' }] },
      { id: 's-facts', lead: 0.2, tail: 0.6, lines: [{ id: 's-3', text: 'Write against facts you can open and check.' }] },
      { id: 's-save', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 's-4', text: 'Save, and the revision is locked to exactly what was reviewed.' }] },
    ],
  },
  {
    id: 'unit-dashboard', title: 'Leading a section', slot: 'unit-dashboard',
    score: { key: 'D', bpm: 72, intensity: 0.45 },
    scenes: [
      { id: 'l-title', lead: 0.6, tail: 0.4, min: 3, cue: 'hit', lines: [{ id: 'l-0', text: 'Leading a section.' }] },
      { id: 'l-today', lead: 0.2, tail: 0.5, lines: [{ id: 'l-1', text: 'As a section lead, Today puts your section first: what’s unassigned, overdue, blocked, and waiting, and on what.' }] },
      { id: 'l-proc', lead: 0.2, tail: 0.6, lines: [{ id: 'l-2', text: 'See how many open commitments, undelivered orders and UMTs you’re carrying.' }] },
      { id: 'l-work', lead: 0.2, tail: 0.6, lines: [{ id: 'l-3', text: 'Workload shows who holds what, beside what each count means.' }] },
      { id: 'l-limits', lead: 0.2, tail: 2.2, cue: 'resolve', lines: [{ id: 'l-4', text: 'Counts never measure effort. And zero recorded is never zero work.' }] },
    ],
  },
];

export const FILMS: Film[] = [HERO, ...CHAPTERS];

/** Before a voice exists: roughly the pace Brian reads at. */
export const estimateSeconds = (text: string) => {
  const words = text.trim().split(/\s+/).length;
  const pauses = (text.match(/[.,;:?!—]/g) || []).length;
  return words / 2.45 + pauses * 0.12 + 0.25;
};
