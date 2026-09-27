import films from './films.generated.json';

export interface VideoSlot {
  id: string;
  title: string;
  description: string;
  /** Roughly how long, for the person deciding whether to start it. */
  length: string;
  topic: 'getting-started' | 'records' | 'work' | 'reports' | 'team' | 'admin';
  /** Set this to publish. Relative to the site root, or an absolute URL. */
  src?: string;
  /** Poster frame. Falls back to a drawn placeholder when absent. */
  poster?: string;
  captions?: string;
  /** ISO date, used only once the video is real. */
  published?: string;
  voiced?: boolean;
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
    description: 'Accept your invitation, then work through the first-week list on Today: protect your sign-in, check your profile, log your first activity, and meet your team and the command above it.',
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
    id: 'visibility',
    title: 'Private, unit, and who can see what',
    description: 'Choose who can see each entry when you save it, see where Vantage says so in plain words, and see who has opened your record.',
    length: '25 sec',
    topic: 'records',
  },
  {
    id: 'import',
    title: 'Importing a spreadsheet',
    description: 'Bring in the sheet your section already works from, see exactly what will be written before anything is, trace each case back to its row, and watch the same file change nothing the second time.',
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
    id: 'record',
    title: 'Your Record, and what counts',
    description: 'What you hold, what you contributed and what you logged yourself, kept apart and counted honestly; and how a case you worked becomes a private draft built only from your own facts.',
    length: '35 sec',
    topic: 'records',
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
    description: 'What your record shows before you claim it: figures kept apart by what they measure, a plain summary, coverage and data quality, and the entries behind a figure.',
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
    description: 'Record a counseling from a Marine’s page; they acknowledge it from Career, which confirms they read it, not that they agree, and both of you hold the same dated record.',
    length: '3 min',
    topic: 'team',
  },
  {
    id: 'setup',
    title: 'Standing up a deployment',
    description: 'First launch and the owner account, the Owner console, the settings worth deciding first, the chain of command, and bringing people in by invitation or roster.',
    length: '7 min',
    topic: 'admin',
  },
  {
    id: 'governance',
    title: 'Retention, holds and the privacy inventory',
    description: 'Turn on a retention schedule with its authority, preview what is eligible, place a legal hold, and export the privacy inventory for the PIA.',
    length: '27 sec',
    topic: 'admin',
  },
];

interface PublishedFilm { src: string; poster: string; captions: string; seconds: number; published: string; voiced?: boolean }

const length = (seconds: number) => (seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`);

export const VIDEOS: VideoSlot[] = VIDEO_SLOTS.map((slot) => {
  const film = (films as Record<string, PublishedFilm>)[slot.id];
  return film ? { ...slot, src: film.src, poster: film.poster, captions: film.captions, published: film.published, length: length(film.seconds), voiced: film.voiced !== false } : slot;
});

export const TOPIC_LABELS: Record<VideoSlot['topic'], string> = {
  'getting-started': 'Getting started',
  records: 'Records',
  work: 'Work and the queue',
  reports: 'Reports',
  team: 'Leading a team',
  admin: 'Running a deployment',
};

export const publishedVideos = () => VIDEOS.filter((v): v is VideoSlot & { src: string } => Boolean(v.src));

export const videosByTopic = (topic: VideoSlot['topic']) => VIDEOS.filter((v) => v.topic === topic);
