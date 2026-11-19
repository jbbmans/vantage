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
  /** No narration: everything the film says is written on screen, so it needs no caption track. */
  textOnly?: boolean;
  /** What a text-only film writes on screen, in order: its text alternative, beside the player. */
  transcript?: string[];
}

const VIDEO_SLOTS: VideoSlot[] = [
  { id: 'trailer', title: 'Vantage, the trailer', description: 'Follow a Marine and a section leader through the dashboard, financial casework and the reports they can brief.', length: '1 min 40 sec', topic: 'getting-started' },
  { id: 'first-week', title: 'Your first week', description: 'Set your password from the sign-in email, work through the first-week checklist, secure your account, log your first entry and find your team.', length: '50 sec', topic: 'getting-started' },
  { id: 'quick-log', title: 'Quick Log', description: 'Press N on any page, type what you did, check what Vantage filled in, and save. Works without a connection too.', length: '40 sec', topic: 'records' },
  { id: 'visibility', title: 'Who can see what', description: 'Pick who can see each entry when you save it: only you, or your unit. See where that is shown and who has opened your record.', length: '45 sec', topic: 'records' },
  { id: 'record', title: 'Your record', description: 'What you are holding, what you contributed and what you logged yourself, kept separate, and how a case you worked becomes a private draft.', length: '40 sec', topic: 'records' },
  { id: 'import', title: 'Importing a spreadsheet', description: 'Bring in the spreadsheet your section already uses, check the preview, and see each row turn into an item in the queue. Importing it again changes nothing.', length: '45 sec', topic: 'work' },
  { id: 'queue', title: 'Working a case', description: 'Claim a case from the queue, follow the procedure, let Vantage do the math, and see every step saved to the case history under your name.', length: '1 min', topic: 'work' },
  { id: 'reading-a-balance', title: 'Reading a balance', description: 'Enter a document’s commitment, obligation, delivered and paid amounts, see what is still open and why, and open a case with the numbers carried over.', length: '40 sec', topic: 'work' },
  { id: 'report-studio', title: 'Writing a package', description: 'Write a JEPES or FITREP package from what you logged, check any cited entry while you write, and save a revision that keeps the records it cites.', length: '40 sec', topic: 'reports' },
  { id: 'analysis', title: 'Reading the analysis', description: 'What your record actually says before you use it: units kept separate, how often you log, and which entries are missing details.', length: '40 sec', topic: 'reports' },
  { id: 'unit-dashboard', title: 'Leading a section', description: 'Today as a section lead: what is unassigned, overdue, blocked or waiting, open work by procedure, and who is holding what.', length: '35 sec', topic: 'team' },
  { id: 'counseling', title: 'Counseling', description: 'Draft a counseling from a Marine’s page, share it for review or finalize it. They acknowledge it under Records → Counseling, which means they read it, not that they agree.', length: '40 sec', topic: 'team' },
  { id: 'setup', title: 'Setting up Vantage', description: 'First launch, the Unit Manager console, the settings to decide first, the chain of command, and bringing people in.', length: '55 sec', topic: 'admin' },
  { id: 'governance', title: 'Retention and privacy', description: 'Turn on a retention schedule, preview it, place a legal hold, and export the privacy inventory for your privacy impact assessment.', length: '45 sec', topic: 'admin' },
];

interface PublishedFilm { src: string; poster: string; captions?: string; seconds: number; published: string; voiced?: boolean; textOnly?: boolean; transcript?: string[] }

const length = (seconds: number) => (seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`);

export const VIDEOS: VideoSlot[] = VIDEO_SLOTS.map((slot) => {
  const film = (films as Record<string, PublishedFilm>)[slot.id];
  return film ? { ...slot, src: film.src, poster: film.poster, captions: film.captions, published: film.published, length: length(film.seconds), voiced: film.voiced !== false, textOnly: Boolean(film.textOnly), transcript: film.transcript } : slot;
});

export const TOPIC_LABELS: Record<VideoSlot['topic'], string> = {
  'getting-started': 'Getting started',
  records: 'Records',
  work: 'Work and the queue',
  reports: 'Reports',
  team: 'Leading a team',
  admin: 'Running a deployment',
};

/**
 * The day the current look arrived (Dress blues, docs/design/DESIGN_SYSTEM.md). A film published before it shows the
 * screens as they were, so the Field guide says so beside it; the tutorials always follow the build (ADR-0034).
 */
export const LOOK_SINCE = '2026-11-17';
export const olderThanLook = (slot: VideoSlot) => Boolean(slot.src && slot.published && slot.published < LOOK_SINCE);

export const publishedVideos = () => VIDEOS.filter((v): v is VideoSlot & { src: string } => Boolean(v.src));

export const videosByTopic = (topic: VideoSlot['topic']) => VIDEOS.filter((v) => v.topic === topic);
