/**
 * The walkthrough videos, and the single list both the public site and the in-app field guide read.
 *
 * Every entry is a placeholder until somebody sets `src`. That is deliberate and it is the whole
 * design of this file: the slots exist, they are named, they are laid out and they say plainly that
 * the recording is not made yet — so the page never shows an empty box, and nobody has to touch a
 * component to publish one. Drop the file in `public/videos/`, set `src`, and it plays.
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

export const VIDEOS: VideoSlot[] = [
  {
    id: 'tour',
    title: 'What Vantage is, in three minutes',
    description: 'The whole product end to end: log the work, see what it produced, and turn it into a report somebody can check.',
    length: '3 min',
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
    title: 'Quick Log: writing a record in one sentence',
    description: 'Type what you did in plain English. Vantage reads the quantity, the value and the area out of the sentence, and shows you what it understood before it saves anything.',
    length: '2 min',
    topic: 'records',
  },
  {
    id: 'visibility',
    title: 'Private, unit, and who can see what',
    description: 'How visibility actually works, why records are private until you share them, and what a leader can and cannot see.',
    length: '3 min',
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
    title: 'Working the queue',
    description: 'Claim a row, work it, and record the outcome so it lands in your record once rather than being typed twice.',
    length: '4 min',
    topic: 'work',
  },
  {
    id: 'report-studio',
    title: 'Report Studio and where the facts come from',
    description: 'Write a package against chosen records, and see what happens when one of those records changes after you cited it.',
    length: '6 min',
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
    title: 'The unit picture for leaders',
    description: 'What a section leader sees each morning, and how to tell a quiet week from a week nobody logged.',
    length: '4 min',
    topic: 'team',
  },
  {
    id: 'counseling',
    title: 'Counseling and acknowledgement',
    description: 'Recording a counseling, what the Marine sees, and why acknowledged text cannot change afterwards.',
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
    description: 'Setting a retention schedule with its authority, placing a legal hold, and exporting the data inventory for a privacy assessment.',
    length: '6 min',
    topic: 'admin',
  },
];

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
