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
          'The whole design follows one idea: using Vantage to do the work should automatically create the useful record of that work. If you are logging things purely so they are logged, something is wrong with how it is set up.',
        ],
        also: ['purpose', 'why', 'point'],
      },
      {
        id: 'first-week',
        q: 'What should I do in my first week?',
        a: [
          'Log one thing a day, at the end of the day, for five days. Press N from anywhere and write a sentence.',
          'At the end of the week open Reports & Analytics → Analysis and look at what it produced. That tells you whether your entries carry numbers and outcomes, which is the only thing that matters about them.',
          'To learn one part of Vantage at a time, take its tutorial: Help → Field guide lists them under Tutorials, starting with Getting started.',
          'Do not try to backfill six months of history first. It is the fastest way to give up, and reconstructed entries are the weakest ones you will have.',
        ],
        also: ['getting started', 'onboarding', 'begin'],
      },
      {
        id: 'tutorials',
        q: 'Is there a tutorial?',
        a: [
          'One for each task, and each takes a few minutes: getting started, logging work, personnel, import and export, error reports, case diagnosis, duty, training, certificates, counselings, reports and analytics. You see only the ones for what you may do.',
          'A page that has one names it under its title, and Tutorials, near the top of this guide, lists them all. A tutorial opens beside the page rather than over it and takes you to the screens it is about, so you do the task as you read it; Show me points at each control.',
          'Turn the line under page titles off in Settings → Appearance. Search (⌘K) still finds every tutorial by name.',
        ],
        also: ['tutorial', 'walkthrough', 'how to', 'learn', 'guide', 'tour', 'training on vantage'],
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
          'No. Analysis shows how many entries you logged so you can see how complete your record is, but its headline figures are what the work produced, and there are no streaks.',
          'Twelve entries with numbers and outcomes beat ninety without. Today and Analysis lead with what the work produced; a count of your entries is a tally, not a rating.',
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
          'A new entry starts private, so only you can see it, unless you set New entries are to shared in Settings → Appearance; you choose for each entry under Who can see this. Leaders, Unit Managers and Vantage staff cannot read a private entry through the application.',
          'Choosing Share with unit under Who can see this makes a record visible to members of that unit who hold a role carrying the View shared records permission, and feeds the unit dashboard. Files on it, such as a training’s certificate, are open to exactly the same people. Some records are shared from the start: duty, with the unit it was stood for, and a counseling or award recommendation a leader writes for you, with the unit it was written in.',
          'Every time a leader opens your record the access is written to an audit log you can read yourself under Settings → Security, in Who has looked at your record. You do not have to ask anyone what they looked at.',
        ],
        also: ['privacy', 'visibility', 'private', 'share', 'leader see'],
      },
      {
        id: 'leaving-unit',
        q: 'What happens to my records if I leave the unit?',
        a: [
          'Entries you shared with that unit are frozen: they stay on your record, and they stay with that unit, read-only, as the record of work done for it, where its leaders who hold View shared records can still read them. Nobody can edit them any more.',
          'Nothing you wrote is deleted by a transfer, and nothing private was ever visible to them in the first place.',
        ],
        also: ['transfer', 'pcs', 'move unit'],
      },
      {
        id: 'offline',
        q: 'Can I log something with no signal?',
        a: [
          'Yes, from Log activity. With no connection its button reads Queue offline: the activity waits on this device and is sent when the connection returns. The header says Offline meanwhile, and once you are back online anything still waiting shows as a count you can open.',
          'The queue is per account on that device, so signing out does not hand your unsent entries to the next person who signs in.',
        ],
        also: ['no internet', 'airplane', 'sync', 'outbox'],
      },
      {
        id: 'delete',
        q: 'I deleted something by mistake.',
        a: [
          'Deleted records go to a recycle bin for 30 days rather than disappearing. For an activity, open Records → Activities, press Filters, and set the quality filter to Recycle bin (30 days) to find and restore it; for a training, an award or a counseling, use Undo on the message that confirms the delete.',
          'After 30 days a deleted entry is removed for good, unless a legal hold keeps it, so recover it sooner rather than later.',
        ],
        also: ['undo', 'recycle bin', 'restore', 'recover'],
      },
      {
        id: 'csv',
        q: 'Can I import or export a spreadsheet of records?',
        a: [
          'Yes, both. Records → Activities has Import activities and Export activities, and that CSV round-trips: a file exported from Vantage can be edited and imported back without creating duplicates, because rows carry a Vantage ID. Awards, training, counselings and duty each have Import and Export on their own page, and Import records in Settings → Your data reads every kind at once.',
          'A row with a Vantage ID updates your own entry. A row without one is added as new, unless it looks like an entry you already logged: those are skipped while Skip rows that look like entries already logged is ticked, as it is at first.',
        ],
        also: ['excel', 'upload', 'download', 'bulk'],
      },
    ],
  },
  {
    id: 'work',
    title: 'Work and the queue',
    lede: 'Tasks, projects, spreadsheets and the email behind them, and what you are asked.',
    topic: 'work',
    answers: [
      {
        id: 'workbook',
        q: 'How do I bring a workbook in?',
        a: [
          'Work → Queue → Import work brings taskers and cases into the queue and walks you through it. The file is quarantined and read, never executed: no macros, no external links, cached values only. Your original file is never modified. A workbook of your own records, such as awards, training or duty, goes through Import records in Settings → Your data instead.',
          'You see exactly what would be written before anything is written. Nothing lands until you say so.',
        ],
        also: ['excel', 'xlsx', 'spreadsheet', 'import'],
      },
      {
        id: 'reimport',
        q: 'What happens if I import the same file twice?',
        a: [
          'Nothing, as long as you import it for the same unit, or for Just me, as before. Each row is matched by the column you chose to identify it, so an identical reimport creates no duplicate work, and you can re-run an import you were unsure about without cleaning up afterwards.',
        ],
        also: ['duplicate', 'twice', 'again'],
      },
      {
        id: 'mangled-id',
        q: 'The spreadsheet wrecked my document numbers.',
        a: [
          'Vantage refuses a row whose identifier the spreadsheet stored in scientific notation, made too long to hold exactly, or replaced with an error such as #REF!, and tells you which rows and why, rather than guessing at a repair. A silently "fixed" identifier is worse than a rejected one.',
          'It cannot tell when a spreadsheet turned an identifier into a date or trimmed its leading zeros, so check those columns. Format the column as Text in the source system, export the file again, and reimport it.',
        ],
        also: ['scientific notation', 'leading zeros', 'mangled', 'rejected'],
      },
      {
        id: 'error-reports',
        q: 'How do I compare this week’s ULO report with last week’s?',
        a: [
          'Work → Error reports, if you read the unit’s shared records. File a report files the ULO, OCMT, UMT or another kind of report as it stood on its day, and the next one of its kind is compared with it: what is new, still open, reopened or resolved.',
          'Every figure opens the rows it counts, each with the file and row it came from. Filing a report never creates or changes a case; where the unit imported the same report into its queue, a row leads to its case.',
        ],
        also: ['ulo', 'ocmt', 'umt', 'error report', 'compare', 'unliquidated'],
      },
      {
        id: 'case-diagnosis',
        q: 'How does Vantage diagnose a case, and can I trust it?',
        a: [
          'By rules, from what is on the case and on file; no AI writes it. Each statement says how it is known: a known fact, a derived value, a recommendation, an unknown, or a decision a person must make.',
          'A recommendation names its source, and sources are weighed in order: official policy first, then official system guidance, an approved command SOP (which binds its own command only), a validated SME workflow, the FMRAC training reference, a validated historical case, an SME walkthrough not yet validated, and inference last. Work → Reference reads a balance and opens it as a case under the procedure that fits.',
        ],
        also: ['diagnosis', 'diagnoser', 'provenance', 'sop', 'policy', 'recommendation', 'fmra', 'balance'],
      },
      {
        id: 'claim',
        q: 'What does claiming a row do?',
        a: [
          'It marks the case as yours, so two people do not work it at once, and whoever holds a case records on it. Claiming alone is not credit for anything.',
          'Each step you record is credited to you in Records → Contributions as you record it, so the work and the evidence of the work are the same keystroke. On a case you worked, Prepare a private draft from my work puts a draft in Records → Drafts to keep in your record.',
        ],
        also: ['assign', 'take', 'own'],
      },
      {
        id: 'notifications',
        q: 'Where do I see what I was asked, and what happened on my records?',
        a: [
          'Notifications, from the bell at the top of every page, or G then B. Notices says what happened: a question or a review request for you, a decision on one of your records, someone naming you, a new comment on a record you are part of. Asked of you / You asked lists the questions and review requests waiting on your answer, and the ones you sent.',
          'A notice says what happened and where, never what anybody wrote. Open the record to read it there. A notice about something you can no longer open is not shown, and several new comments on one record are one notice until you open it.',
          'Discussion, Work updates and Announcements can be turned off in Settings → Notifications. The rest always arrive, because they are things you are asked to do or must know. Notices are kept for 180 days.',
        ],
        also: ['notices', 'bell', 'alerts', 'unread', 'mentions', 'asked of you', 'you asked', 'mute', 'turn off'],
      },
      {
        id: 'ask',
        q: 'How do I ask someone about a record?',
        a: [
          'Open the record and, in its discussion, choose Ask a question or Ask for review, then choose whom to ask. You can ask someone who already reads the record and belongs to its Unit Instance, or its Marine. Only the person asked answers, and you can withdraw it while it is open.',
          'A question is answered in words. A review comes back Looks right, or Needs changes with what needs changing. Requests and answers stay on the record as they were said. Open ones are listed under Notifications → Asked of you / You asked.',
          'On a counseling, sharing it with the Marine is the review, so ask a question instead. On a duty, a review request goes only to someone who may decide it. A work case takes questions and review requests but no free comments, because its notes are its own sealed history.',
          'Name someone in a comment with @ and their username, and they are told. At most 10 people in one message; Vantage says who was told, and which names matched nobody who reads the record.',
        ],
        also: ['question', 'review', 'clarification', 'mention', '@', 'comment', 'discussion', 'answer', 'withdraw'],
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
          'On Analysis, a narrative written to the character limit, a bullet package, a period-over-period comparison and a full analysis, all built from the same entries, with an analysis PDF. On Packages, an evaluation package written against the records it cites, saved as revisions. In the Report library, reports about you, a Marine or a unit, to print or take as a file.',
          'The CSV export round-trips back into import, so a report is never a dead end.',
        ],
        also: ['jepes', 'fitrep', 'pdf', 'narrative', 'bullets'],
      },
      {
        id: 'narrative-writer',
        q: 'How is my JEPES or FITREP narrative written?',
        a: [
          'For JEPES, as the billet accomplishments MCO 1616.1 Appendix E describes. They sit under the three command input lines (Individual Character; MOS and/or Mission Accomplishment; Leadership), each a dash, a past-tense verb, the number and the result, with acronyms spelled out once. Required annual training is held back, as the order says it is not an accomplishment. For FITREP, as the MRO worksheet asks: a Section C draft of major accomplishments, one list of dash bullets ordered by the section each line gives evidence for, results only, no superlatives, 1,232 characters; and beside it the worksheet’s PME and Other blocks. Readiness reads each entry for the same FITREP attribute the draft does.',
          'The writer weighs every entry, gives each area its strongest sentence first, totals the same work when it would not all fit, and credits your case histories. On Analysis, select any sentence to see the entries behind it and why it made the cut. You can keep it, leave it out, ask for another wording or edit the text yourself. The reviewer grades the result and says what would make it stronger, and whether each point comes from an order, guidance or style.',
          'It writes your input, not your evaluation: marks, word pictures, rankings and recommendations are your reporting chain’s. It runs inside Vantage and sends nothing anywhere.',
        ],
        also: ['narrative', 'writer', 'jepes', 'fitrep', 'billet accomplishments', 'section c', 'appendix e', 'reviewer', 'bullets'],
      },
      {
        id: 'provenance',
        q: 'What happens if a record changes after I cited it?',
        a: [
          'The save is refused, and the records that changed are listed; select one under the cited records to see it as it stands now. Once you select I have read the updated facts, save again: a record that was deleted or moved is no longer cited, and the rest are read as they stand now. If none is left, choose another before you save.',
          'This is enforced on the server inside the same transaction as the save, so an exported revision is provably the thing that was reviewed rather than a snapshot that drifted.',
        ],
        also: ['provenance', 'changed', 'stale', 'revision'],
      },
      {
        id: 'summing',
        q: 'Why will it not add these two numbers together?',
        a: [
          'Because they are not the same unit. Vantage never sums across unlike units: twelve MIPRs and thirty ULOs are forty-two of nothing.',
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
      {
        id: 'custom-dates',
        q: 'Can I choose my own dates?',
        a: [
          'Yes. On Records, Analysis, the Report library, Duty and Today, open Period and choose Custom dates, then set From and To. The page uses the two days as soon as both are set, and its exports, PDFs and Print or file use them too.',
          'A range runs from the first day to the last, both counted, and can be up to 731 days. If the last day is before the first, the field says so and the page keeps the range it had.',
          'The dates are in the page’s address, so a bookmark or a link you send opens on the same days. A period such as Last 90 days is remembered as your choice; custom dates are not, so the page opens on your usual period next time.',
        ],
        also: ['date range', 'from', 'to', 'custom', 'period', 'dates'],
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
          'Its Output tab counts only entries people shared with the unit, and Casework, Duty and Training count only the cases, duty and training shared with it. Personnel is the roster as it stands today.',
          'A quiet figure may mean a quiet window or may mean nobody shared anything, and those are different problems. A figure that is a button, such as a total, a bar or a column, opens the records it counts, where you may read them. Some, such as Members and Needs attention on the Output tab, are counts only and open nothing.',
        ],
        also: ['team view', 'roster', 'workload'],
      },
      {
        id: 'roles',
        q: 'How do roles work?',
        a: [
          'A role is granted in one unit. A role above the default Marine role also applies in every unit beneath that one, never above it; the Marine role stays in its own unit. The unit leader holds every permission in that unit and the units beneath it, except approving their own duty, which only a role that names it gives.',
          'Authorization is decided on the server from your session. A hidden button is not a permission, and nothing is granted by the interface.',
        ],
        also: ['permission', 'admin', 'access'],
      },
      {
        id: 'counseling',
        q: 'How does counseling work?',
        a: [
          'Write a counseling from the Marine’s page. Save it as a draft only you see, share it with the Marine for review, or finalize it. A Marine reads a draft you shared and answers in its comments; they acknowledge it once it is final. What the two of you say in its comments before it is final stays between you.',
          'Once final, a counseling changes only by amendment: say what changed and why. What it said before is kept in its amendment history, and the Marine is asked to acknowledge the amended text. Acknowledging means they read it, not that they agree.',
          'Print a counseling, or download it as a PDF, on the COUNSELING WORKSHEET: sections A to G, each Vantage field in its box. Boxes Vantage does not hold, such as date of rank, billet MOS and the signatures, stay blank, and the PDF lets you type into them. The record stays the source; the PDF is one way to read it.',
          'Each EDIPI box prints that person’s EDIPI from their own Vantage profile: the one on their account (from their CAC or their unit’s roster), or one they typed in Settings → Profile. If yours is not there, Vantage asks for it before you print or download, and saves it to your profile. Nobody else can set yours, and it is never used to sign in. Vantage shows only its last four digits, except on the print page and in the PDF, which print it whole, and only on the copy for the Marine and the counselor.',
          'Your own notes of a counseling you received are always final and yours to edit.',
        ],
        also: ['acknowledge', 'counsel', '6105', 'navmc 2795', 'worksheet', 'counseling worksheet', 'edipi', 'amend', 'draft'],
      },
      {
        id: 'invite',
        q: 'How do I add somebody?',
        a: [
          'Invitations are links that work once, for seven days. Enter an email address and, where email is set up, Send invitation emails it; otherwise Create link gives you a link to copy and hand over.',
          'A join code, made on Administration → Invitations, lets a whole formation join at once: each Marine enters it in Settings, under Join with a code. Enroll an existing account, on Personnel → Roster, adds a Marine you already lead in another unit you manage.',
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
          'Yes, add one. Settings → Security. Face ID, Windows Hello or a hardware key then signs you in without typing anything, and it cannot be phished: there is no code for anyone to talk you into reading out.',
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
          'Settings → Security lists it under Who has looked at your record. Every open of your record by somebody else is in it, a download of a file on one of your records included.',
        ],
        also: ['access log', 'who viewed', 'audit'],
      },
    ],
  },
  {
    id: 'deployment',
    title: 'Running a deployment',
    lede: 'For Vantage Administrators and Unit Managers: configuration, governance and scale.',
    topic: 'admin',
    answers: [
      {
        id: 'metrics-config',
        q: 'We are not a comptroller shop. Can we change what is measured?',
        a: [
          'Yes. The Unit Manager console renames the money metric, defines the value types and which of them roll into a headline total, and sets the activity categories and unit suggestions.',
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
          'Place a legal hold in the Unit Manager console. A hold names its scope and its reason, and held records are skipped by disposition until it is released.',
        ],
        also: ['preserve', 'litigation', 'freeze'],
      },
      {
        id: 'privacy-inventory',
        q: 'I need a data inventory for a privacy assessment.',
        a: [
          'The Unit Manager console builds one from the live database every time you open it, and exports as Markdown for a PIA.',
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
          'Yes, and it is off until Vantage staff turn it on, because it needs mTLS terminated in front of the application.',
          'Identity comes from the certificate with EDIPI as the only join key. There is no name matching, because two Marines share a name and nobody shares a DoD ID.',
        ],
        also: ['piv', 'smart card', 'certificate', 'edipi'],
      },
      {
        id: 'ai',
        q: 'Is the AI on, and where does the text go?',
        a: [
          'It is off unless Vantage staff enable it, and it runs against the GenAI.mil gateway rather than a commercial provider.',
          'Nothing generated is authoritative. It drafts; a person reviews and decides. Where AI is offered it sits on the page you are already working on rather than in a destination of its own.',
        ],
        also: ['genai', 'assist', 'llm'],
      },
      {
        id: 'system-of-record',
        q: 'Where are official evaluations recorded?',
        a: [
          'On Marine Online (MOL). Your JEPES score and your fitness reports are recorded there, and official submissions go through the authoritative systems. Vantage keeps the working record behind them and drafts the input from it.',
        ],
        also: ['official', 'mol', 'authoritative', 'dod', 'system of record'],
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
