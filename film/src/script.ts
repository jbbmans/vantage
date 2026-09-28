/**
 * Every film, as the cards that appear on screen. There is no narration: the text carries the film, and the
 * music is timed to it. A scene holds one or more cards, shown one after another over the same picture.
 */

export interface Scene {
  id: string;
  /** What appears on screen, one card at a time. A card may hold a short list after a line break. */
  cards: string[];
  /** A floor, in seconds, for scenes whose action needs longer than their words. */
  min?: number;
  /** What the score does at the start of this scene. */
  cue?: 'hit' | 'lift' | 'drop' | 'build' | 'resolve';
}

export type Mode = 'major' | 'minor';

export interface Music {
  /** MIDI note of the key's tonic, in the octave around middle C. */
  tonic: number;
  mode: Mode;
  bpm: number;
  /** Scale degrees, 1-based: [1, 6, 3, 7] is i–VI–III–VII in minor. */
  progression: number[];
  groove: 'pulse' | 'four' | 'half' | 'drive' | 'swing' | 'still';
  lead: 'piano' | 'pluck' | 'bell' | 'keys' | 'arp16';
  seed: number;
}

export interface Film {
  id: string;
  title: string;
  /** Published slot in src/config/videos.ts. */
  slot: string;
  kind: 'ad' | 'hero' | 'chapter';
  /** Field guide number, for chapters. */
  n?: number;
  accent: string;
  music: Music;
  scenes: Scene[];
}

export const AD: Film = {
  id: 'ad', title: 'Vantage', slot: 'ad', kind: 'ad', accent: '#3fd0bd',
  music: { tonic: 57, mode: 'minor', bpm: 100, progression: [1, 6, 3, 7], groove: 'drive', lead: 'piano', seed: 11 },
  scenes: [
    { id: 'ad-work', cue: 'build', cards: ['You reconciled 30 ULOs this week.'] },
    { id: 'ad-gap', cards: ['And caught a $1,275 funding gap before it turned into a problem.'] },
    { id: 'ad-later', cue: 'drop', cards: ['Six months later you need it for your JEPES or FITREP, and you can’t find half of it.'] },
    { id: 'ad-scatter', cards: ['It’s in a spreadsheet, an old email, and a sticky note somewhere.'], min: 5 },
    { id: 'ad-logo', cue: 'hit', cards: [''], min: 3.4 },
    { id: 'ad-capture', cue: 'lift', cards: ['Type what you did in plain English.', 'It pulls out the numbers. You check them and save.'], min: 9 },
    { id: 'ad-queue', cards: ['Your section’s work is in one list. Claim something and it’s yours.'], min: 5 },
    { id: 'ad-history', cards: ['Everything you do on it is logged with your name and the date.'] },
    { id: 'ad-report', cue: 'lift', cards: ['When it goes into your JEPES or FITREP, it’s already logged.'] },
    { id: 'ad-lead', cards: ['Leaders can see what’s overdue or stuck without asking around.'] },
    { id: 'ad-private', cards: ['Your entries stay private unless you share them.'] },
    { id: 'ad-end', cue: 'resolve', cards: [''], min: 5 },
  ],
};

export const HERO: Film = {
  id: 'hero', title: 'Vantage, the tour', slot: 'tour', kind: 'hero', accent: '#3fd0bd',
  music: { tonic: 62, mode: 'minor', bpm: 84, progression: [1, 6, 3, 7], groove: 'pulse', lead: 'piano', seed: 3 },
  scenes: [
    { id: 'open', cards: ['Most of the work a Marine does never gets written down anywhere.'], min: 5 },
    { id: 'detail', cards: ['30 reconciliations. A funding gap caught in time.'], min: 5 },
    { id: 'scatter', cards: ['By the next morning it’s in a spreadsheet, an inbox, or someone’s head.'], min: 5.5 },
    { id: 'title', cue: 'hit', cards: [''], min: 3.6 },
    { id: 'capture', cue: 'lift', cards: ['Log what you did in one line. Vantage reads the numbers and shows you before saving.'], min: 7.5 },
    { id: 'queue', cards: ['All of your section’s work in one queue. Claim a case and it’s on your list.'], min: 5.5 },
    { id: 'case', cards: ['Cases follow written procedures with sources. They close when the result is verified.'] },
    { id: 'balance', cue: 'build', cards: ['Enter a document’s figures and Vantage shows you what’s still open.'], min: 5.5 },
    { id: 'sealed', cards: ['Every action on a case is saved to its history with a name and date.'] },
    { id: 'credit', cue: 'lift', cards: ['Credit goes to whoever did the work, not whoever held the case.'] },
    { id: 'report', cards: ['What you logged is ready to put into your JEPES or FITREP, with a link back to each entry.'] },
    { id: 'lead', cards: ['Leaders get a view of the whole section.'] },
    { id: 'trust', cue: 'drop', cards: ['Private by default. Can run on your own network.'] },
    { id: 'end', cue: 'resolve', cards: [''], min: 5 },
  ],
};

const chapter = (id: string, n: number, title: string, accent: string, music: Music, scenes: Scene[]): Film => ({
  id, title, slot: id, kind: 'chapter', n, accent, music,
  scenes: [{ id: `${id}-title`, cue: 'hit', cards: [''] }, ...scenes, { id: `${id}-end`, cue: 'resolve', cards: [''] }],
});

export const CHAPTERS: Film[] = [
  chapter('quick-log', 1, 'Quick Log', '#3fd0bd',
    { tonic: 64, mode: 'major', bpm: 104, progression: [1, 5, 6, 4], groove: 'four', lead: 'bell', seed: 21 }, [
      { id: 'ql-open', cards: ['Press N from any page.'] },
      { id: 'ql-type', cards: ['Type it the way you’d say it.'], min: 5.5 },
      { id: 'ql-read', cards: ['Vantage fills in the count, the dollar amount, the system and the date.'], min: 6 },
      { id: 'ql-save', cards: ['Look it over, fix anything that’s off, and save.'], min: 7 },
      { id: 'ql-offline', cue: 'drop', cards: ['No connection? It saves on your device and syncs later.'], min: 8 },
    ]),
  chapter('queue', 2, 'Working a case', '#5b8def',
    { tonic: 55, mode: 'minor', bpm: 92, progression: [1, 4, 6, 5], groove: 'half', lead: 'pluck', seed: 22 }, [
      { id: 'q-queue', cards: ['Your section’s open work is all in one queue.'] },
      { id: 'q-claim', cards: ['Claim a case and it moves to your list.', 'Claiming a case doesn’t give you credit. The work you log on it does.'], min: 8 },
      { id: 'q-step', cards: ['The procedure shows the next step and only asks for what that step needs.'], min: 7 },
      { id: 'q-calc', cards: ['Enter what you found and Vantage does the math, showing every number it used.'], min: 7 },
      { id: 'q-decide', cards: ['If a step needs evidence first, it tells you up front.'], min: 8 },
      { id: 'q-history', cue: 'lift', cards: ['Everything you do goes into the case history under your name.', 'If you hand the case off, you each keep credit for your own part.'], min: 8 },
    ]),
  chapter('reading-a-balance', 3, 'Reading a balance', '#7cc4ff',
    { tonic: 65, mode: 'major', bpm: 88, progression: [1, 2, 6, 5], groove: 'swing', lead: 'keys', seed: 23 }, [
      { id: 'b-ref', cards: ['The FMRA desk reference is built in, with a source for everything in it.'] },
      { id: 'b-enter', cards: ['Enter the commitment, obligation, delivered and paid amounts.'], min: 5 },
      { id: 'b-read', cards: ['Vantage shows what’s still open, what could be causing it, who can fix it, and what proves it’s fixed.'], min: 7 },
      { id: 'b-dash', cards: ['A dash on a report doesn’t mean zero. Mark it as “not shown.”'], min: 5 },
      { id: 'b-case', cards: ['Open a case from here and the numbers carry over, along with where they came from.'], min: 8 },
    ]),
  chapter('record', 4, 'Your record', '#5fe0a8',
    { tonic: 60, mode: 'major', bpm: 96, progression: [6, 4, 1, 5], groove: 'pulse', lead: 'piano', seed: 24 }, [
      { id: 'r-three', cards: ['Your record keeps three things separate.', 'Work you’re holding. That isn’t credit yet.', 'Work you contributed to, counted from the case itself.', 'Things you logged yourself.'] },
      { id: 'r-count', cards: ['A document only counts once, no matter how many entries it took.'], min: 5 },
      { id: 'r-draft', cards: ['From any case you worked, you can start a private draft using only your own facts.'], min: 6 },
      { id: 'r-keep', cards: ['Save it and it’s added to your record with a link to the case.'], min: 5 },
    ]),
  chapter('report-studio', 5, 'Report Studio', '#e8b35a',
    { tonic: 58, mode: 'major', bpm: 90, progression: [1, 3, 4, 5], groove: 'swing', lead: 'keys', seed: 25 }, [
      { id: 's-intro', cards: ['Report Studio helps you put what you’ve logged into your JEPES or FITREP.'], min: 5 },
      { id: 's-period', cards: ['Pick the period and the entries you want to cite.'], min: 6 },
      { id: 's-facts', cards: ['Click any cited entry to check it while you write.', 'If one of those entries changes while you’re writing, it won’t save until you look at it again.'], min: 9 },
      { id: 's-save', cards: ['Each saved version is locked to exactly what it cited.'] },
    ]),
  chapter('unit-dashboard', 6, 'Leading a section', '#5b8def',
    { tonic: 62, mode: 'minor', bpm: 100, progression: [1, 7, 6, 7], groove: 'drive', lead: 'pluck', seed: 26 }, [
      { id: 'l-today', cards: ['If you lead a section, Today shows your section first.', 'What’s unassigned, overdue, blocked, or waiting on someone else.'] },
      { id: 'l-proc', cards: ['How many open commitments, undelivered orders and UMTs you have.'] },
      { id: 'l-work', cards: ['Workload shows who’s holding what, and explains what each number means.'], min: 5 },
      { id: 'l-limits', cards: ['These counts don’t measure effort. Zero logged doesn’t mean zero done.'], min: 5 },
    ]),
  chapter('first-week', 7, 'Your first week', '#3fd0bd',
    { tonic: 55, mode: 'major', bpm: 108, progression: [1, 4, 6, 5], groove: 'four', lead: 'bell', seed: 27 }, [
      { id: 'fw-invite', cards: ['Day one, you’ll get an email with your username and a link to set your password.'], min: 9 },
      { id: 'fw-list', cards: ['Today has a short checklist for your first week. Items check off as you do them.'] },
      { id: 'fw-secure', cards: ['Start by adding a passkey or an authenticator app to your account.'], min: 5 },
      { id: 'fw-profile', cards: ['Check your profile and make sure your rank is right.'], min: 5 },
      { id: 'fw-first', cards: ['Log one thing you did. One line is enough.'], min: 6.5 },
      { id: 'fw-team', cards: ['By Friday, open Team to see your people, your chain of command, and shared goals.'], min: 7 },
    ]),
  chapter('visibility', 8, 'Who can see what', '#a99bff',
    { tonic: 57, mode: 'minor', bpm: 84, progression: [1, 6, 4, 5], groove: 'still', lead: 'piano', seed: 28 }, [
      { id: 'v-choose', cards: ['When you save an entry, you pick who can see it.'], min: 6 },
      { id: 'v-private', cards: ['Only me: nobody else can open it. Not your leaders, not the site owner.'] },
      { id: 'v-unit', cards: ['My unit: it counts on the unit dashboard for leaders over that unit.'] },
      { id: 'v-says', cards: ['Every entry shows who can see it, right at the top.'], min: 6 },
      { id: 'v-never', cards: ['Drafts and career plans are always private.', 'When a leader opens your record, that gets logged.'] },
    ]),
  chapter('import', 9, 'Importing a spreadsheet', '#7cc4ff',
    { tonic: 64, mode: 'minor', bpm: 110, progression: [1, 6, 3, 7], groove: 'four', lead: 'arp16', seed: 29 }, [
      { id: 'i-bring', cards: ['Bring in the spreadsheet your section already uses. Your original file isn’t changed.'], min: 6 },
      { id: 'i-map', cards: ['Vantage reads the column headers and guesses what each one is. Fix any it got wrong.'] },
      { id: 'i-preview', cards: ['You see a preview of every row before anything is saved.'] },
      { id: 'i-run', cards: ['Each row becomes an item in the queue, linked back to its row in the file.'], min: 9 },
      { id: 'i-again', cards: ['Import the same file again and nothing gets duplicated.'], min: 6 },
    ]),
  chapter('analysis', 10, 'Reading the analysis', '#e8b35a',
    { tonic: 60, mode: 'minor', bpm: 90, progression: [1, 4, 7, 3], groove: 'half', lead: 'keys', seed: 30 }, [
      { id: 'a-open', cards: ['The Analysis tab shows what your record actually says before you use it.'] },
      { id: 'a-units', cards: ['Hours, kilometers and dollars are kept separate and never added together.'] },
      { id: 'a-summary', cards: ['The summary shows how often you log, your longest gap, and where your pace puts you.'] },
      { id: 'a-coverage', cards: ['Coverage points out entries missing details, so you can fix them before a report uses them.'] },
      { id: 'a-behind', cards: ['Click any number on Today to see the entries behind it.'], min: 5 },
    ]),
  chapter('counseling', 11, 'Counseling', '#5fe0a8',
    { tonic: 65, mode: 'major', bpm: 80, progression: [1, 6, 4, 5], groove: 'still', lead: 'piano', seed: 31 }, [
      { id: 'c-record', cards: ['Record a counseling from the Marine’s page: what went well, what to work on, and goals.'], min: 10 },
      { id: 'c-save', cards: ['Once it’s saved, it’s on their record with the date and your name.'], min: 5 },
      { id: 'c-ack', cards: ['They open it under Career and acknowledge it.', 'Acknowledging means they read it. It doesn’t mean they agree.'], min: 7 },
      { id: 'c-both', cards: ['You both see the same record, marked acknowledged.'] },
    ]),
  chapter('setup', 12, 'Setting up Vantage', '#3fd0bd',
    { tonic: 62, mode: 'major', bpm: 96, progression: [1, 5, 6, 4], groove: 'pulse', lead: 'pluck', seed: 32 }, [
      { id: 'su-first', cards: ['On first launch, create the owner account and your first unit.'], min: 11 },
      { id: 'su-console', cards: ['The Owner console is where you manage settings, accounts, units, email, retention and backups.'], min: 5 },
      { id: 'su-settings', cards: ['Get settings right before anyone else signs in, starting with whether people can sign themselves up.'], min: 7 },
      { id: 'su-units', cards: ['Build your chain of command. Teams go under their command, and permissions flow down, not up.'], min: 9 },
      { id: 'su-people', cards: ['Add people by invite, by importing a roster, or by emailing everyone their sign-in details.'], min: 10 },
    ]),
  chapter('governance', 13, 'Retention and privacy', '#a99bff',
    { tonic: 58, mode: 'minor', bpm: 86, progression: [1, 6, 7, 1], groove: 'pulse', lead: 'keys', seed: 33 }, [
      { id: 'g-sched', cards: ['Retention is off until you turn it on, one record type at a time. Each schedule lists its authority.'], min: 9 },
      { id: 'g-preview', cards: ['Preview what would be deleted before anything runs.'], min: 5 },
      { id: 'g-hold', cards: ['A legal hold blocks any deletion it covers, even if a schedule says otherwise.'], min: 7 },
      { id: 'g-inventory', cards: ['The privacy inventory is built from the live database, so it stays current.'], min: 6 },
      { id: 'g-export', cards: ['Export it for your privacy impact assessment.'], min: 5 },
    ]),
];

export const FILMS: Film[] = [AD, HERO, ...CHAPTERS];

/** How long a card needs on screen to be read comfortably, before the music's rounding. */
export const readingSeconds = (text: string, kind: Film['kind']) => {
  if (!text.trim()) return 0;
  const words = text.trim().split(/\s+/).length;
  return (kind === 'ad' ? 0.9 : 1.1) + words * (kind === 'ad' ? 0.27 : 0.3);
};
