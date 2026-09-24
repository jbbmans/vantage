/**
 * The walkthrough films, and the single list both the public site and the in-app field guide read.
 *
 * The slots are the library's plan: named, laid out, and honest that a film is not made yet, so the
 * page never shows an empty box. A slot plays only once the film pipeline has published it: `npm run
 * film` (film/README.md) records the real application in the synthetic demo, voices the script, scores
 * and renders it, writes public/videos/films/<id>.{mp4,jpg,vtt}, and lists it in
 * films.generated.json. Nothing is published while its narration is still an estimate.
 *
 * Two rules that matter more than they look:
 *
 *   1. A slot with no `src` is never described to a search engine. Schema.org VideoObject markup
 *      pointing at a video that does not exist is structured data that lies, and Google treats that
 *      as a reason to distrust the rest of the page. `publishedVideos()` is the only thing SEO
 *      code may read.
 *   2. `id` is the stable handle. It is what a deep link (`/help#video-quick-log`) and any future
 *      owner-console override key off, so renaming one breaks links — change `title` instead.
 */

import films from './films.generated.json';

export interface VideoSlot {
  /** Stable handle. Used in anchors and as the override key. Never rename casually. */
  id: string;
  title: string;
  /** What somebody learns by watching. Shown under the title and used as the schema description. */
  description: string;
  /** Roughly how long, for the person deciding whether to start it. */
  length: string;
  /** Which part of the product this belongs to; groups the slots in the field guide. */
  topic: 'getting-started' | 'records' | 'work' | 'reports' | 'team' | 'admin';
  /** Set this to publish. Relative to the site root, or an absolute URL. */
  src?: string;
  /** Poster frame. Falls back to a drawn placeholder when absent. */
  poster?: string;
  /** Captions. A video without them is not finished — see the note in the field guide. */
  captions?: string;
  /** ISO date, used only once the video is real. */
  published?: string;
}

const VIDEO_SLOTS: VideoSlot[] = [
  {
    id: 'tour',
    title: 'Vantage, the film',
    description: 'What Vantage keeps, and why: a sentence becomes a record, a case follows a cited procedure to a verified outcome, the history is sealed, the credit goes to whoever did the work, and the section lead sees it all at a glance.',
    length: '90 sec',
    topic: 'getting-started',
  },
  {
    id: 'first-week',
    title: 'Your first week',
    description: 'What to do on day one, what to do by Friday, and what you should be able to see by the end of the month.',
    length: '4 min',
    topic: 'getting-started',
  },
  {
    id: 'quick-log',
    title: 'Quick Log: a record in one sentence',
    description: 'Press N anywhere and write what you did the way you would say it. Vantage reads the count, the dollar value and its kind, the system and the date, shows you what it understood, and saves it to your record, even with no signal.',
    length: '40 sec',
    topic: 'records',
  },
  {
    id: 'record',
    title: 'Your Record, and what counts',
    description: 'What you hold, what you contributed and what you logged yourself, kept apart and counted honestly; and how a case you worked becomes a private draft built only from your own facts.',
    length: '35 sec',
    topic: 'records',
  },
  {
    id: 'visibility',
    title: 'Private, unit, and who can see what',
    description: 'Check the record audience, the intended unit, and the saved visibility setting.',
    length: '25 sec',
    topic: 'records',
  },
  {
    id: 'import',
    title: 'Importing a spreadsheet',
    description: 'Bring a workbook in, see exactly what will be written before it is written, and understand why importing the same file twice changes nothing.',
    length: '5 min',
    topic: 'work',
  },
  {
    id: 'queue',
    title: 'Working a case',
    description: 'Claim a case from the section’s queue, follow the procedure’s next step, record what you found, calculate the candidate from cited inputs, decide with a reason, and hand it on, with every entry signed into the history.',
    length: '50 sec',
    topic: 'work',
  },
  {
    id: 'reading-a-balance',
    title: 'Reading a balance',
    description: 'The FMRA desk reference inside Vantage. Enter a document’s commitment, obligation, delivered and paid figures, read the open condition, the causes to rule out and who can act, and open a case with the figures recorded as read.',
    length: '40 sec',
    topic: 'work',
  },
  {
    id: 'report-studio',
    title: 'Report Studio',
    description: 'Turn your record into JEPES or FITREP input: choose the period and the entries it cites, write against facts you can open and check, and save a revision locked to exactly what was reviewed.',
    length: '25 sec',
    topic: 'reports',
  },
  {
    id: 'analysis',
    title: 'Reading the full analysis',
    description: 'What each figure means, why unlike units are never added together, and how to open any number to see what is behind it.',
    length: '5 min',
    topic: 'reports',
  },
  {
    id: 'unit-dashboard',
    title: 'Leading a section',
    description: 'Today as a section lead: what is unassigned, overdue, blocked and waiting, open balances by procedure, and the workload beside what each count can and cannot tell you.',
    length: '30 sec',
    topic: 'team',
  },
  {
    id: 'counseling',
    title: 'Counseling and acknowledgement',
    description: 'Record a counseling, review the next steps, and check the acknowledgement state.',
    length: '3 min',
    topic: 'team',
  },
  {
    id: 'setup',
    title: 'Standing up a deployment',
    description: 'First run, the owner account, units and roles, and the settings worth deciding before anybody else signs in.',
    length: '7 min',
    topic: 'admin',
  },
  {
    id: 'governance',
    title: 'Retention, holds and the privacy inventory',
    description: 'Review retention scope, authority, holds, and a sample privacy inventory.',
    length: '27 sec',
    topic: 'admin',
  },
];

interface PublishedFilm { src: string; poster: string; captions: string; seconds: number; published: string }

const length = (seconds: number) => (seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`);

/** The slots, with a source only where the film pipeline has published a finished film. */
export const VIDEOS: VideoSlot[] = VIDEO_SLOTS.map((slot) => {
  const film = (films as Record<string, PublishedFilm>)[slot.id];
  return film ? { ...slot, src: film.src, poster: film.poster, captions: film.captions, published: film.published, length: length(film.seconds) } : slot;
});

export const TOPIC_LABELS: Record<VideoSlot['topic'], string> = {
  'getting-started': 'Getting started',
  records: 'Records',
  work: 'Work and the queue',
  reports: 'Reports',
  team: 'Leading a team',
  admin: 'Running a deployment',
};

/** Only videos that actually exist. The single source SEO and any index may read. */
export const publishedVideos = () => VIDEOS.filter((v): v is VideoSlot & { src: string } => Boolean(v.src));

export const videosByTopic = (topic: VideoSlot['topic']) => VIDEOS.filter((v) => v.topic === topic);
