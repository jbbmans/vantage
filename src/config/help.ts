import type { VideoSlot } from './videos';

export interface Answer {
  id: string;
  q: string;
  a: string[];
  also?: string[];
}

export interface HelpSection {
  id: string;
  title: string;
  lede: string;
  topic: VideoSlot['topic'];
  answers: Answer[];
}

export const HELP: HelpSection[] = [
  {
    id: 'start',
    title: 'Starting out',
    lede: 'What this is for, and what to do in the first week.',
    topic: 'getting-started',
    answers: [
      {
        id: 'what-is-vantage',
        q: 'What is Vantage actually for?',
        a: [
          'Every evaluation you will ever get is written from whatever is in front of the writer at the time. Vantage keeps the evidence: dated, quantified work with an outcome attached.',
          'The whole design follows one idea — using Vantage to do the work should automatically create the useful record of that work. If you are logging things purely so they are logged, something is wrong with how it is set up.',
        ],
        also: ['purpose', 'why', 'point'],
      },
      {
        id: 'first-week',
        q: 'What should I do in my first week?',
        a: [
          'Log one thing a day, at the end of the day, for five days. Press N from anywhere and write a sentence.',
          'At the end of the week open Reports and look at what it produced. That tells you whether your entries carry numbers and outcomes, which is the only thing that matters about them.',
          'Do not try to backfill six months of history first. It is the fastest way to give up, and reconstructed entries are the weakest ones you will have.',
        ],
        also: ['getting started', 'onboarding', 'begin'],
      },
      {
        id: 'strong-entry',
        q: 'What makes a strong entry?',
        a: [
          'A number. How many, how much, how long. "Processed MIPRs" is a billet description; "processed 12 MIPRs, zero returns" is evidence.',
          'An outcome. What changed because you did it. Entries with no result are the first cut from any package.',
          'An area. JEPES marks character, MOS and leadership separately; FITREPs mark fourteen attributes across five sections. An entry with no area gets marked from impression instead of evidence.',
        ],
        also: ['good entry', 'quality', 'bullet'],
      },
      {
        id: 'record-count',
        q: 'Does logging more make me look better?',
        a: [
          'No, and Vantage will not tell you it does. Record count is never reported as productivity anywhere in the product, and there are no streaks.',
          'Twelve entries with numbers and outcomes beat ninety without. The dashboard reports what the work produced, not how many rows you typed.',
        ],
        also: ['how many', 'gamification'],
      },
    ],
  },
  {
    id: 'records',
    title: 'Records',
    lede: 'Capturing work, and who can see it.',
    topic: 'records',
    answers: [
      {
        id: 'quick-log',
        q: 'How does Quick Log read my sentence?',
        a: [
          'Write it the way you would say it out loud: "Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday." Vantage pulls out the date, the quantity, the value and a likely evaluation area, and shows you what it understood before anything is saved.',
          'It is a parser, not an oracle. Check the fields it filled. Anything it got wrong you change in place, and the correction does not need to be made twice.',
        ],
        also: ['n key', 'sentence', 'parse', 'natural language'],
      },
      {
        id: 'who-can-see',
        q: 'Who can see my records?',
        a: [
          'Every record is private by default. Only you can see it. Leaders, unit owners and the instance operator cannot read a private entry through the application.',
          'Marking a record "shared with unit" makes it visible to members of that unit who hold a role carrying the View shared records permission, and feeds the unit dashboard.',
          'Every time a leader opens your record the access is written to an audit log you can read yourself under Settings → Security. You do not have to ask anyone what they looked at.',
        ],
        also: ['privacy', 'visibility', 'private', 'share', 'leader see'],
      },
      {
        id: 'leaving-unit',
        q: 'What happens to my records if I leave the unit?',
        a: [
          'Entries you shared with that unit are frozen. They stay on your record permanently; they stop appearing to the unit you left.',
          'Nothing you wrote is deleted by a transfer, and nothing private was ever visible to them in the first place.',
        ],
        also: ['transfer', 'pcs', 'move unit'],
      },
      {
        id: 'offline',
        q: 'Can I log something with no signal?',
        a: [
          'Yes. Entries queue on the device and sync when the network returns. The header shows a count of anything still waiting.',
          'The queue is per account on that device, so signing out does not hand your unsent entries to the next person who signs in.',
        ],
        also: ['no internet', 'airplane', 'sync', 'outbox'],
      },
      {
        id: 'delete',
        q: 'I deleted something by mistake.',
        a: [
          'Deleted records go to a recycle bin rather than disappearing. Open Records and switch the quality filter to Deleted to find and restore it.',
          'The bin is purged on a schedule set by the deployment owner, so recover it sooner rather than later.',
        ],
        also: ['undo', 'recycle bin', 'restore', 'recover'],
      },
      {
        id: 'csv',
        q: 'Can I import or export a spreadsheet of records?',
        a: [
          'Yes, both. Records → Import CSV brings rows in, and the CSV export round-trips: a file exported from Vantage can be edited and imported back without creating duplicates, because rows carry a Vantage ID.',
          'A row with no Vantage ID is treated as new. A row with one updates the record it names.',
        ],
        also: ['excel', 'upload', 'download', 'bulk'],
      },
    ],
  },
  {
    id: 'work',
    title: 'Work and the queue',
    lede: 'Tasks, projects, spreadsheets and the email behind them.',
    topic: 'work',
    answers: [
      {
        id: 'workbook',
        q: 'How do I bring a workbook in?',
        a: [
          'Work → import walks you through it. The file is quarantined and read, never executed: no macros, no external links, cached values only. Your original file is never modified.',
          'You see exactly what would be written before anything is written. Nothing lands until you say so.',
        ],
        also: ['excel', 'xlsx', 'spreadsheet', 'import'],
      },
      {
        id: 'reimport',
        q: 'What happens if I import the same file twice?',
        a: [
          'Nothing. An identical reimport creates no duplicate work. This is deliberate — it means you can re-run an import you were unsure about without cleaning up afterwards.',
        ],
        also: ['duplicate', 'twice', 'again'],
      },
      {
        id: 'mangled-id',
        q: 'The spreadsheet wrecked my document numbers.',
        a: [
          'Vantage refuses those rows and tells you which ones and why, rather than guessing at a repair. An identifier a spreadsheet has turned into a date or trimmed the leading zeros off is not recoverable by inference, and a silently "fixed" identifier is worse than a rejected one.',
          'Fix the column formatting in the source file and reimport.',
        ],
        also: ['scientific notation', 'leading zeros', 'mangled', 'rejected'],
      },
      {
        id: 'claim',
        q: 'What does claiming a row do?',
        a: [
          'It marks the row as yours so two people do not work it at once, and it is what lets the action you take write into your own record when you finish.',
          'That is the point of the queue: the work and the evidence of the work are the same keystroke.',
        ],
        also: ['assign', 'take', 'own'],
      },
    ],
  },
  {
    id: 'reports',
    title: 'Reports',
    lede: 'Turning the record into something somebody can check.',
    topic: 'reports',
    answers: [
      {
        id: 'report-kinds',
        q: 'What can Vantage produce?',
        a: [
          'A narrative written to the character limit, a bullet package, a period-over-period comparison, and a full analysis with a working-paper PDF. All four are built from the same entries.',
          'The CSV export round-trips back into import, so a report is never a dead end.',
        ],
        also: ['jepes', 'fitrep', 'pdf', 'narrative', 'bullets'],
      },
      {
        id: 'provenance',
        q: 'What happens if a record changes after I cited it?',
        a: [
          'The save is refused, and you are shown what changed. Once you have read it, the save goes through.',
          'This is enforced on the server inside the same transaction as the save, so an exported revision is provably the thing that was reviewed rather than a snapshot that drifted.',
        ],
        also: ['provenance', 'changed', 'stale', 'revision'],
      },
      {
        id: 'summing',
        q: 'Why will it not add these two numbers together?',
        a: [
          'Because they are not the same unit. Vantage never sums across unlike units — twelve MIPRs and thirty ULOs are forty-two of nothing.',
          'The same rule applies to typed value: headline totals sum the types the deployment marks as summable, and anything else is reported on its own line. Funds that crossed your desk are not funds you moved.',
        ],
        also: ['total', 'sum', 'add', 'units', 'dollars'],
      },
      {
        id: 'about-me',
        q: 'Somebody wrote a report about me. Can I see it?',
        a: [
          'You can read it. You cannot rewrite it. A report written about a person is theirs to read and the author’s to change.',
        ],
        also: ['my report', 'read', 'edit'],
      },
    ],
  },
  {
    id: 'team',
    title: 'Leading a team',
    lede: 'Roster, roles, counseling and what a leader can actually see.',
    topic: 'team',
    answers: [
      {
        id: 'unit-dashboard',
        q: 'What does the unit dashboard show?',
        a: [
          'Only entries people shared with the unit. It is built from shared records and nothing else, so a quiet dashboard may mean a quiet week or may mean nobody shared anything — and those are different problems.',
        ],
        also: ['team view', 'roster', 'workload'],
      },
      {
        id: 'roles',
        q: 'How do roles work?',
        a: [
          'Roles are per unit. A role you hold in one unit confers nothing in another, including sub-units. The unit leader holds every permission inside that unit.',
          'Authorization is decided on the server from your session. A hidden button is not a permission, and nothing is granted by the interface.',
        ],
        also: ['permission', 'admin', 'access'],
      },
      {
        id: 'counseling',
        q: 'How does counseling work?',
        a: [
          'A counseling you record asks the Marine to acknowledge it. Once they have acknowledged it, the text they acknowledged cannot be changed — not by you, not by an owner.',
          'The counseled Marine acknowledges and nothing more; the record belongs to its author.',
        ],
        also: ['acknowledge', 'counsel', '6105'],
      },
      {
        id: 'invite',
        q: 'How do I add somebody?',
        a: [
          'Invitations are links valid for seven days. If email is configured on the deployment they are sent for you; otherwise copy the link and hand it over.',
          'You can also enrol an account that already exists on the deployment into your unit.',
        ],
        also: ['add marine', 'invitation', 'join'],
      },
    ],
  },
  {
    id: 'security',
    title: 'Signing in and security',
    lede: 'Passwords, passkeys and what to do when something looks wrong.',
    topic: 'admin',
    answers: [
      {
        id: 'password',
        q: 'What password should I use?',
        a: [
          'Fifteen characters or more. A sentence you can remember beats symbols you cannot.',
        ],
        also: ['passphrase', 'length'],
      },
      {
        id: 'passkey',
        q: 'What is a passkey and should I add one?',
        a: [
          'Yes, add one. Settings → Security. Face ID, Windows Hello or a hardware key then signs you in without typing anything, and it cannot be phished — there is no code for anyone to talk you into reading out.',
        ],
        also: ['webauthn', 'face id', 'fingerprint', 'yubikey'],
      },
      {
        id: 'mfa',
        q: 'What about an authenticator app?',
        a: [
          'Supported, with recovery codes. Each recovery code works once. Store them somewhere that is not the device running the authenticator.',
        ],
        also: ['totp', '2fa', 'two factor', 'recovery codes'],
      },
      {
        id: 'audit',
        q: 'How do I see who looked at my record?',
        a: [
          'Settings → Security carries the access log. Every read of your record by somebody else is in it.',
        ],
        also: ['access log', 'who viewed', 'audit'],
      },
    ],
  },
  {
    id: 'deployment',
    title: 'Running a deployment',
    lede: 'For the owner: configuration, governance and scale.',
    topic: 'admin',
    answers: [
      {
        id: 'metrics-config',
        q: 'We are not a comptroller shop. Can we change what is measured?',
        a: [
          'Yes. The owner console renames the money metric, defines the value types and which of them roll into a headline total, and sets the activity categories and unit suggestions.',
          'Records keep whatever key they were saved with, so retiring a type never rewrites history.',
        ],
        also: ['dollars', 'customise', 'categories', 'configure'],
      },
      {
        id: 'retention',
        q: 'How long are records kept?',
        a: [
          'Exactly as long as the schedule you set says, and no schedule is on until you turn it on. Each schedule requires a citation, because a retention rule with no authority behind it is somebody’s guess.',
          'Disposition previews what it would do before it runs, and every run is logged including the ones that removed nothing.',
        ],
        also: ['disposition', 'delete', 'schedule', 'records management'],
      },
      {
        id: 'legal-hold',
        q: 'How do I freeze records against disposition?',
        a: [
          'Place a legal hold in the owner console. A hold names its scope and its reason, and held records are skipped by disposition until it is released.',
        ],
        also: ['preserve', 'litigation', 'freeze'],
      },
      {
        id: 'privacy-inventory',
        q: 'I need a data inventory for a privacy assessment.',
        a: [
          'The owner console builds one from the live database every time you open it, and exports as Markdown for a PIA.',
          'It is read from the schema rather than maintained by hand, so it cannot quietly stop being true the way a written document does. It also reports its own gaps.',
        ],
        also: ['pia', 'privacy act', 'inventory', 'sorn'],
      },
      {
        id: 'scale',
        q: 'How many people can one instance hold?',
        a: [
          'Comfortably around 1,000 to 1,500. That is measured rather than guessed: 250 people answered in 8.9ms at the 95th percentile, 1,000 in 70.7ms, 2,000 in 124.8ms, and 5,000 in 297.7ms.',
          'Anything you do about your own record stays under a millisecond at every size tested. What degrades is the whole-unit rollup.',
          'Run it yourself with the scale-check script; the numbers above are reproducible.',
        ],
        also: ['how big', 'performance', 'sqlite', 'limit', 'slow'],
      },
      {
        id: 'cac',
        q: 'Can people sign in with a CAC?',
        a: [
          'Yes, and it is off until the owner turns it on, because it needs mTLS terminated in front of the application.',
          'Identity comes from the certificate with EDIPI as the only join key — no name matching, because two Marines share a name and nobody shares a DoD ID.',
        ],
        also: ['piv', 'smart card', 'certificate', 'edipi'],
      },
      {
        id: 'ai',
        q: 'Is the AI on, and where does the text go?',
        a: [
          'It is off unless the owner enables it, and it runs against the GenAI.mil gateway rather than a commercial provider.',
          'Nothing generated is authoritative. It drafts; a person reviews and decides. Where AI is offered it sits on the page you are already working on rather than in a destination of its own.',
        ],
        also: ['genai', 'assist', 'llm'],
      },
      {
        id: 'system-of-record',
        q: 'Is Vantage a system of record?',
        a: [
          'No. Vantage is an independent project and is not an official Department of Defense or U.S. Marine Corps system of record. It organizes source material and drafts; official submissions belong in the authoritative systems.',
        ],
        also: ['official', 'mol', 'authoritative', 'dod'],
      },
    ],
  },
];

/** Flattened, for search. */
export const ALL_ANSWERS = HELP.flatMap((s) => s.answers.map((a) => ({ ...a, section: s.title, sectionId: s.id })));

export function searchHelp(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return ALL_ANSWERS
    .map((entry) => {
      const hay = `${entry.q} ${entry.a.join(' ')} ${(entry.also || []).join(' ')} ${entry.section}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (entry.q.toLowerCase().includes(t) ? 3 : 0) + (hay.includes(t) ? 1 : 0), 0);
      return { entry, score, matchedAll: terms.every((t) => hay.includes(t)) };
    })
    .filter((r) => r.matchedAll)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.entry);
}
