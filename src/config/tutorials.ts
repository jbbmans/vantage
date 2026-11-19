import type { Requirement } from './nav';
import type { PermissionKey } from '../../shared/permissions';
import type { TutorialId } from '../../shared/tutorials';

/**
 * Who a tutorial or one of its steps is for. The menu's own rule (src/config/nav.ts, Requirement), so a tutorial never
 * leads somewhere the menu hides, and where a step needs more, a permission held in at least one unit. It only decides
 * what is offered: the server decides every action, as it always does.
 */
export interface TutorialGate extends Requirement {
  /** Holds at least one of these permissions in at least one unit. */
  anyOf?: PermissionKey[];
  /**
   * File attachments are on for the service. This is all the client knows: Vantage can still withhold them from one Unit
   * Instance (ADR-0014), which the page then says, so a step's words allow for it.
   */
  attachments?: boolean;
}

export interface TutorialStep {
  /** What to do, in a few words: "Record the duty". */
  title: string;
  /** At most two plain sentences, true of this build. */
  body: string;
  /**
   * The page the step happens on: an app path, or a pattern with a parameter for a page reached from another (a
   * Marine's page, "/team/:id"). A query names one tab of a page ("/settings?tab=data").
   */
  at: string;
  /** Where "Go to" leads when `at` has a parameter: the page it is opened from. */
  from?: string;
  /** The place, said as the menu says it, where placeName cannot (a tab of a page: "Settings → Your data"). */
  place?: string;
  /** The control the step is about: its data-tutorial name. "Show me" scrolls to it and outlines it. */
  anchor?: string;
  /** That control's visible name, as the step's words name it. A browser test checks the two agree. */
  control?: string;
  /** A step offered only to some: a reviewer's step only to a reviewer. */
  when?: TutorialGate;
}

export interface Tutorial {
  id: TutorialId;
  title: string;
  /** One sentence: what you can do once you have followed it. */
  outcome: string;
  /** The pages it is offered on, in the line under the title, as patterns like a step's `at`. */
  pages: string[];
  when?: TutorialGate;
  steps: TutorialStep[];
  /** Field guide answers that go further (src/config/help.ts). */
  help?: string[];
  /** Other words people search with for it. */
  keywords?: string;
}

/**
 * The tutorials (ADR-0034): short, one task each, offered on the page the task is
 * done on, and followed in the real application rather than watched. In the order of shared/tutorials.ts.
 */
export const TUTORIALS: Tutorial[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    outcome: 'You can see what needs you, log what you did, find any page or record, and protect your sign-in.',
    pages: ['/'],
    help: ['first-week', 'quick-log', 'notifications', 'passkey', 'mfa'],
    keywords: 'start begin first week new onboarding tour basics',
    steps: [
      {
        title: 'See what needs you', at: '/', anchor: 'today-your-work', control: 'Your work',
        body: 'Your work, on Today, lists what you are asked and what you hold, each with its next useful step. When you hold nothing, it lists work open to claim, and Find work opens the queue.',
      },
      {
        title: 'Log what you did', at: '/', anchor: 'log-activity', control: 'Log activity',
        body: 'Choose Log activity, or press N, and write what you did in one sentence; on a phone it is the + at the foot of the screen. Check the fields Vantage filled in, then choose Save activity.',
      },
      {
        title: 'Find any page or record', at: '/', anchor: 'search', control: 'Search',
        body: 'Choose Search, or press ⌘K (Ctrl+K on Windows), and type a page’s name to go there, or a word to find work, records, people and the reference. The menu lists the same pages, grouped by what they are for, and on a phone it opens from More.',
      },
      {
        title: 'Check the bell', at: '/', anchor: 'notifications-bell', control: 'Notifications',
        body: 'Notifications, the bell at the top, collects the questions and reviews asked of you, decisions on your records and mentions. See all opens the full list, with the questions you asked others.',
      },
      {
        title: 'Protect your sign-in', at: '/settings?tab=security', place: 'Settings → Security', when: { notDemo: true }, anchor: 'add-passkey', control: 'Add passkey',
        body: 'Add passkey lets you sign in with Face ID, Windows Hello or a security key, and Set up under Authenticator app adds a six-digit code. Vantage may ask you to confirm it is you first.',
      },
    ],
  },
  {
    id: 'logging-work',
    title: 'Logging work',
    outcome: 'You can record what you did in a sentence, choose who sees it, fix it later, and see the casework already credited to you.',
    pages: ['/record/activities', '/record/contributions'],
    help: ['quick-log', 'strong-entry', 'who-can-see', 'delete', 'offline'],
    keywords: 'log activity entry quick log record bullet write sentence',
    steps: [
      {
        title: 'Log an activity', at: '/record/activities', anchor: 'log-activity', control: 'Log activity',
        body: 'Choose Log activity, or press N, and write one sentence with the number and the result, such as “Processed 12 MIPRs, zero returns”. Check the fields Vantage filled in, then choose Save activity.',
      },
      {
        title: 'Choose who can see it', at: '/record/activities', anchor: 'activity-edit', control: 'Edit',
        body: 'Edit opens an entry again, to fix it or change Who can see this. Only me keeps it to you, and Share with unit lets the unit’s leaders who read its shared records see it and count it.',
      },
      {
        title: 'Use the full form', at: '/record/activities', anchor: 'new-activity', control: 'New activity',
        body: 'New activity opens the full form, with an end date, a project and evidence links. When what you write in Log activity reads like an award or a training, it offers Save as award or Save as training.',
      },
      {
        title: 'Get back a deleted entry', at: '/record/activities', anchor: 'activity-filters', control: 'Filters',
        body: 'Choose Filters, change All entries to Recycle bin (30 days) to see the activities you deleted, and choose Restore on one. After 30 days it is removed for good, unless a legal hold keeps it.',
      },
      {
        title: 'See credit for casework', at: '/record/contributions',
        body: 'Steps you record on a case in Work → Queue are listed here by case, credited to you, so you never log them again. On a case you worked, Prepare a private draft from my work puts a draft in Records → Drafts to keep in your record.',
      },
    ],
  },
  {
    id: 'personnel',
    title: 'Personnel',
    outcome: 'You can find and open a Marine’s record on your units’ rosters and, where you manage members, change their assignment and bring Marines in.',
    pages: ['/team', '/team/roster', '/team/:id', '/team/invitations'],
    when: { unit: true, anyOf: ['VIEW_RECORDS', 'MANAGE_MEMBERS'] },
    help: ['invite', 'roles', 'leaving-unit'],
    keywords: 'roster members marines billet supervisor team people',
    steps: [
      {
        title: 'Find a Marine on the roster', at: '/team/roster', when: { team: 'roster' }, anchor: 'roster-search', control: 'Search roster',
        body: 'Search roster finds a Marine in the unit in view by name, rank, MOS, billet or supervisor; with several units, choose one from View at the top. The tabs under it show only those with no supervisor, no billet or an assignment ending in 90 days.',
      },
      {
        title: 'Open a Marine’s page', at: '/team/roster', when: { team: 'roster' }, anchor: 'roster-open', control: 'Open',
        body: 'Open on a Marine’s row shows their page, starting with their billet, supervisor, check-in day, responsibilities and roles. Each visit to a Marine’s page is logged.',
      },
      {
        title: 'Change a billet or supervisor', at: '/team/:id?tab=personnel', from: '/team/roster', place: 'the Marine’s Personnel tab', when: { team: 'roster', notDemo: true, anyOf: ['MANAGE_MEMBERS'] },
        anchor: 'personnel-change', control: 'Change',
        body: 'Where you may change a Marine’s assignment, Change beside it sets the billet, dates, supervisor and check-in day. Save changes it now and adds it to their history, and Save draft keeps it to you and changes nothing.',
      },
      {
        title: 'Change several Marines at once', at: '/team/roster', when: { team: 'roster', notDemo: true, anyOf: ['MANAGE_MEMBERS'] }, anchor: 'roster-select', control: 'Select',
        body: 'Select the box beside each Marine you may change, then choose Change all and pick one change, such as a supervisor, a billet or a move. Preview says what would happen to each, and nothing is applied unless every one of them can be.',
      },
      {
        title: 'Bring Marines into the unit', at: '/team/invitations', when: { team: 'invites' }, anchor: 'join-code-create', control: 'Create join code',
        body: 'Create join code makes one code that a whole formation enters in Settings, under Join with a code, and Vantage shows it only once. For one Marine, the Invite panel above it makes a link that works once, for seven days.',
      },
    ],
  },
  {
    id: 'import-export',
    title: 'Import and export',
    outcome: 'You can bring records in from a file without making copies, and take your records out as a file.',
    pages: ['/settings?tab=data', '/record/activities', '/career/training', '/career/awards', '/career/counseling', '/record/duty', '/work/queue'],
    help: ['csv', 'workbook', 'reimport', 'mangled-id'],
    keywords: 'import export csv excel spreadsheet workbook download upload zip json file copy',
    steps: [
      {
        title: 'Import your records', at: '/settings?tab=data', place: 'Settings → Your data', anchor: 'import-records', control: 'Import records',
        body: 'Import records reads a Vantage export, a CSV or an Excel workbook, shows what each row will become and leaves out what you already have. Nothing is written until you import, and Recent imports can undo one.',
      },
      {
        title: 'Take a copy of everything', at: '/settings?tab=data', place: 'Settings → Your data', anchor: 'export-everything', control: 'Everything (ZIP)',
        body: 'Everything (ZIP) downloads all the data tied to your account, its files included, and Choose what to export takes only the kinds you tick. Vantage may ask you to confirm it is you first.',
      },
      {
        title: 'Export one kind of record', at: '/career/awards', anchor: 'export-category', control: 'Export',
        body: 'Awards, Training, Counseling and Duty each have Export, for your records of that kind as a CSV, an Excel workbook or a Vantage file. Import beside it brings an edited file back through the same review.',
      },
      {
        title: 'Export activities and bring them back', at: '/record/activities', anchor: 'export-activities', control: 'Export activities',
        body: 'Export activities downloads your own activities of the period in view as a CSV. Import activities brings an edited copy back, and a row that keeps its Vantage ID updates that entry instead of adding a copy.',
      },
      {
        title: 'Import work into the queue', at: '/work/queue', anchor: 'import-work', control: 'Import work',
        body: 'Import work brings taskers and cases from a spreadsheet into the queue, for you alone or for a unit you may post work to, and previews what is new, updated or refused before anything is written. Importing the same file again for the same place adds nothing.',
      },
    ],
  },
  {
    id: 'error-reports',
    title: 'Error reports',
    outcome: 'You can see, report to report, what is new, still open, reopened or resolved in your unit’s error reports, down to the rows behind each figure, and, where you may post work, file them.',
    pages: ['/work/error-reports'],
    when: { unitRecords: true },
    help: ['error-reports', 'workbook', 'mangled-id'],
    keywords: 'ulo ocmt umt error report compare spreadsheet unliquidated obligations sync',
    steps: [
      {
        title: 'File a report', at: '/work/error-reports', when: { anyOf: ['CREATE_SHARED_WORK'] }, anchor: 'error-reports-file', control: 'File a report',
        body: 'File a report asks which report it is, the day it stands on and the file, then which column identifies each error and what the others hold. The preview writes nothing: file the rows, then choose Open the comparison.',
      },
      {
        title: 'Open a series', at: '/work/error-reports', anchor: 'error-reports-series', control: 'Open',
        body: 'Each kind of report a unit files is a series, listed for the unit in view and the units beneath it. Open one to compare its reports.',
      },
      {
        title: 'Compare two reports', at: '/work/error-reports', anchor: 'error-reports-compare', control: 'Compared with',
        body: 'The latest report is compared with the one before it: what is New, Still open, Reopened or Resolved. Choose another Report or Compared with to compare any two that stand.',
      },
      {
        title: 'Open the rows behind a figure', at: '/work/error-reports', anchor: 'error-reports-figure', control: 'Open',
        body: 'Choose a figure, such as Open, to list exactly the rows it counts, each with the file and row it came from. Where the unit imported the same report into its queue, a row’s Open the case leads to its case.',
      },
    ],
  },
  {
    id: 'case-diagnosis',
    title: 'Case diagnosis',
    outcome: 'You can read a balance, open it as a case, and tell from its diagnosis what is known, what is recommended and on whose authority, and what a person must decide.',
    pages: ['/reference?tab=diagnose', '/work/items/:id'],
    help: ['case-diagnosis', 'claim', 'ai'],
    keywords: 'diagnose diagnoser balance fmra procedure provenance sop policy recommendation case reference',
    steps: [
      {
        title: 'Read a balance', at: '/reference?tab=diagnose', place: 'Reference → Diagnose', anchor: 'diagnoser-figures', control: 'Diagnose a balance',
        body: 'Under Diagnose a balance, enter one document’s commitment, obligation, delivered and paid amounts, or load one of the examples. The reading beside it says what is still open and the procedure that fits.',
      },
      {
        title: 'Open it as a case', at: '/reference?tab=diagnose', place: 'Reference → Diagnose', anchor: 'diagnoser-open-case', control: 'Open the case',
        body: 'When the reading names a procedure, enter the Document number under Work it as a case and choose Open the case. It opens in your hands under that procedure, private to you or on a unit’s queue you may post work to.',
      },
      {
        title: 'Read the diagnosis', at: '/work/items/:id', from: '/work/queue', anchor: 'case-diagnosis', control: 'Diagnosis',
        body: 'On a case, the Diagnosis panel works it out by rules from what is on it and on file, and no AI writes it. When it asks you to Confirm the issue type, it says why: an import read the procedure from the row’s words alone, or the error text or the figures point to another.',
      },
      {
        title: 'See how each statement is known', at: '/work/items/:id', from: '/work/queue', anchor: 'case-diagnosis-labels',
        body: 'Under the headline, each label is counted: Known fact, Derived value, Recommendation, Unknown and Human decision required. Every statement below carries one, a known fact says where it came from, and a recommendation names its source.',
      },
      {
        title: 'Weigh the sources', at: '/work/items/:id', from: '/work/queue', anchor: 'case-diagnosis-sources', control: 'Sources weighed, in order',
        body: 'Open Sources weighed, in order: official policy is weighed first and inference, by Vantage or by AI, always last. An approved command SOP binds its own command only.',
      },
      {
        title: 'Hold up a resolved case as an example', at: '/work/items/:id', from: '/work/queue', when: { anyOf: ['REASSIGN_WORK', 'MANAGE_RECORDS'] },
        anchor: 'case-diagnosis-example', control: 'Validate as an example',
        body: 'On a resolved, verified case of your unit that you did not resolve, Validate as an example asks what it shows the next person. Cases of the same issue type then offer it as a validated historical case.',
      },
    ],
  },
  {
    id: 'duty',
    title: 'Duty',
    outcome: 'You can record the duty you stood, follow it through review to what it counts for, and, where you review duty, decide what others submitted.',
    pages: ['/record/duty'],
    when: { unit: true, notDemo: true },
    help: ['roles', 'ask'],
    keywords: 'duty watch stood points hours review approve return scoring',
    steps: [
      {
        title: 'Record a duty you stood', at: '/record/duty', anchor: 'duty-record', control: 'Record duty',
        body: 'Choose Record duty, then the duty type and the day and 24-hour time it began and ended. The form shows its hours and points under your Unit Instance’s scoring before you send it.',
      },
      {
        title: 'See what it counts for', at: '/record/duty', anchor: 'duty-totals', control: 'Approved points',
        body: 'A duty you record is Submitted and counts for nothing until a reviewer approves it. Approved points adds up only approved duty, and Awaiting review counts what still waits.',
      },
      {
        title: 'Open a duty to see where it stands', at: '/record/duty?who=mine', place: 'Records → Duty, Yours', anchor: 'duty-view', control: 'View',
        body: 'View shows how a duty was scored, where it stands and its review history. If a reviewer returned it, the duty says why, and Correct it lets you fix it and send it back.',
      },
      {
        title: 'Move an activity that was duty', at: '/record/duty', anchor: 'duty-suggestion-record', control: 'Record as duty',
        body: 'An activity you logged that reads like duty you stood is offered under your totals. Record as duty gives it a duty type and times, and Keep as activity stops the suggestion.',
      },
      {
        title: 'Open the duty waiting for you', at: '/record/duty', when: { anyOf: ['REVIEW_DUTY'] }, anchor: 'duty-review-tab', control: 'To review',
        body: 'To review lists the submitted duty waiting in the units where you review duty, longest-waiting first, and never your own.',
      },
      {
        title: 'Approve, return or reject', at: '/record/duty?who=review', place: 'Records → Duty, To review', when: { anyOf: ['REVIEW_DUTY'] }, anchor: 'duty-approve', control: 'Approve',
        body: 'Approve counts a duty at its calculated points, and Return… and Reject… each ask for a reason its Marine reads. A duty’s title opens every choice you have on it, such as approving with a note or with different points.',
      },
    ],
  },
  {
    id: 'training',
    title: 'Training',
    outcome: 'You can record a course or other training, check its course code against the approved catalogs, and choose who can see it.',
    pages: ['/career/training'],
    help: ['who-can-see'],
    keywords: 'training course pme marinenet cdet certification hours ceu catalog',
    steps: [
      {
        title: 'Record a training', at: '/career/training', anchor: 'training-new', control: 'New training',
        body: 'Choose New training and type its course code, such as CDET 8010: if an approved catalog lists it, choose Use these details. Fill in the title if it is still empty, then choose Add training.',
      },
      {
        title: 'See what was verified', at: '/career/training', anchor: 'training-open',
        body: 'Choose a training’s title in the list to open it. Under its details, Vantage says which values an approved catalog verified and which you entered by hand.',
      },
      {
        title: 'Choose who can see it', at: '/career/training', anchor: 'training-edit', control: 'Edit',
        body: 'Edit opens a training again, and under Who can see this, Share with unit lets leaders who read the unit’s shared records see it and its files. Only me keeps it to you.',
      },
    ],
  },
  {
    id: 'certificates',
    title: 'Certificates',
    outcome: 'You can attach a certificate to a training, say what it is, correct or remove it, and know who can open it.',
    pages: ['/career/training', '/team/:id?tab=career'],
    when: { attachments: true },
    help: ['who-can-see', 'audit'],
    keywords: 'certificate evidence attachment file upload proof diploma completion',
    steps: [
      {
        title: 'Attach a certificate', at: '/career/training', anchor: 'training-open',
        body: 'Open a training by its title, choose Add evidence, say what it is, such as Certificate, choose the file, then Attach. Vantage takes only the file types and size the form names, and where it has turned files off for your Unit Instance, the training says so.',
      },
      {
        title: 'Correct or remove a file', at: '/career/training', anchor: 'training-open',
        body: 'In the open training, Edit details changes what a file is and its description, never the file itself. Remove asks first, and a removed file cannot be brought back from the page.',
      },
      {
        title: 'Know who can open it', at: '/settings?tab=security', place: 'Settings → Security', anchor: 'access-log', control: 'Who has looked at your record',
        body: 'Whoever can open the training can open its files: you, and if you shared it, leaders who read the unit’s shared records. When someone else downloads one, it is listed under Who has looked at your record.',
      },
      {
        title: 'Open a Marine’s evidence', at: '/team/:id?tab=career', from: '/team/roster', place: 'the Marine’s Awards and training tab', when: { team: 'roster', anyOf: ['VIEW_MEMBER_DETAIL'] }, anchor: 'member-training-open',
        body: 'On a Marine’s page, open Awards and training and choose a training they shared to see its evidence. If your role also carries Edit others’ records, you can add and correct their files there, where their Unit Instance allows files.',
      },
    ],
  },
  {
    id: 'counselings',
    title: 'Counselings',
    outcome: 'You can read, acknowledge and print a counseling written for you, and, if you counsel Marines, write one and take it to final.',
    pages: ['/career/counseling', '/team/:id?tab=counseling'],
    help: ['counseling', 'ask'],
    keywords: 'counseling counselling navmc 2795 worksheet acknowledge edipi print pdf',
    steps: [
      {
        title: 'Open a counseling', at: '/career/counseling', anchor: 'counseling-list', control: 'Counselings',
        body: 'Counselings lists the counselings written for you and the ones you wrote, each with where it stands. Choose a summary to read it and answer in its comments.',
      },
      {
        title: 'Acknowledge it once it is final', at: '/career/counseling', anchor: 'counseling-acknowledge', control: 'Acknowledge',
        body: 'A final counseling written for you shows To acknowledge and an Acknowledge button. Acknowledging confirms you read it, not that you agree.',
      },
      {
        title: 'Add your EDIPI once', at: '/settings?tab=profile', place: 'Settings → Profile', anchor: 'edipi-for-forms', control: 'EDIPI for your forms',
        body: 'Counseling worksheets print your EDIPI from your profile, for counselings you received and ones you gave. Type it once under EDIPI for your forms, unless your account already carries one.',
      },
      {
        title: 'Print it or download the PDF', at: '/career/counseling',
        body: 'In an open counseling, Worksheet shows it on the COUNSELING WORKSHEET. Print opens it laid out for paper in a new tab, with a PDF button beside Print.',
      },
      {
        title: 'Write a counseling for a Marine', at: '/team/:id', from: '/team/roster', when: { team: 'roster', anyOf: ['COUNSEL'] }, anchor: 'counseling-new-for-marine', control: 'New counseling',
        body: 'Open the Marine from Personnel → Roster and choose New counseling. Write it, then choose Save draft, Share with Marine so they can read it and comment, or Finalize to ask for their acknowledgement.',
      },
      {
        title: 'Take a draft to final', at: '/team/:id?tab=counseling', from: '/team/roster', place: 'the Marine’s Counseling tab', when: { team: 'roster', anyOf: ['COUNSEL'] }, anchor: 'counseling-share', control: 'Share with Marine',
        body: 'On the Marine’s Counseling tab, a draft offers Share with Marine, so they can read it and comment. Finalize asks them to acknowledge it, and after that only Amend… changes it.',
      },
    ],
  },
  {
    id: 'reports',
    title: 'Reports',
    outcome: 'You can write an evaluation package against the records it cites, save it as a revision, and print any report or take it as a file.',
    pages: ['/reports', '/reports/library'],
    help: ['report-kinds', 'provenance', 'about-me'],
    keywords: 'report package jepes fitrep evaluation revision print pdf library cite export',
    steps: [
      {
        title: 'Start a package', at: '/reports', anchor: 'package-new', control: 'New report',
        body: 'Choose New report, give it a title and the period it covers, and choose Start. Only records dated inside that period can be cited, and the period stays as you set it.',
      },
      {
        title: 'Choose the records it cites', at: '/reports', anchor: 'package-cite', control: 'Choose',
        body: 'In the open package, Choose, beside the cited records, lists what you may cite: tick the ones it rests on and confirm. Only your activities, training, awards and final counselings dated inside its period are offered.',
      },
      {
        title: 'Write against them', at: '/reports', anchor: 'package-section',
        body: 'Write each section in its box, and choose a cited record to check it as it stands now. If a record changed after you cited it, the save is refused: read the new facts, choose I have read the updated facts, and save again.',
      },
      {
        title: 'Save a revision', at: '/reports', anchor: 'package-save', control: 'Save revision',
        body: 'Save revision keeps this wording with the records it cites, once at least one is cited. Export revision downloads it as a text file, and History lists every revision.',
      },
      {
        title: 'Run a report', at: '/reports/library', anchor: 'run-report', control: 'Run report',
        body: 'In the Report library, choose a report, whom it is about where that is offered, and its filters, then choose Run report. It shows as it prints, with its period, its filters and its handling line.',
      },
      {
        title: 'Print it or take a file', at: '/reports/library', anchor: 'report-print', control: 'Print',
        body: 'Print opens the report laid out for paper in a new tab. Download takes it as a PDF, a spreadsheet, an Excel workbook or a Vantage file, and a line beside it says when you may take fewer.',
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    outcome: 'You can read what your record and your unit’s figures show, switch any chart to its table, and open the records behind a figure.',
    pages: ['/reports/analysis', '/team/dashboard'],
    help: ['report-kinds', 'summing', 'unit-dashboard'],
    keywords: 'analytics analysis chart figures trends metrics table drill',
    steps: [
      {
        title: 'Open the full analysis', at: '/reports/analysis', anchor: 'analysis-full', control: 'Full analysis',
        body: 'Choose a period, then Full analysis. It sets what your record shows in that period beside the period before.',
      },
      {
        title: 'Read a chart as a table', at: '/reports/analysis', anchor: 'figure-table', control: 'Table',
        body: 'Each chart is headed by the question it answers, with a sentence that gives the answer. Table shows the same figures as a table, and Chart goes back.',
      },
      {
        title: 'Open the records behind a figure', at: '/reports/analysis', anchor: 'figure-records',
        body: 'Choose a bar, a column or a figure in a table to list the entries it counts, then choose one to open it. A figure that counts nothing is not a button.',
      },
      {
        title: 'Choose what the dashboard shows', at: '/team/dashboard', when: { team: 'dashboard' }, anchor: 'dashboard-show',
        body: 'In the Unit dashboard, Output, Casework, Duty, Training and Personnel each show one side of the unit, over the window beside them. Output counts only entries shared with the unit, and Personnel is the roster as it stands today.',
      },
      {
        title: 'Open what a unit figure counts', at: '/team/dashboard', when: { team: 'dashboard' }, anchor: 'figure-records',
        body: 'Choose a total, a bar or a column to list the records it counts, then choose one to open it where you may. A figure that is not a button, such as Members, opens nothing.',
      },
      {
        title: 'Print or file what is on screen', at: '/team/dashboard', when: { team: 'dashboard' }, anchor: 'dashboard-print', control: 'Print or file',
        body: 'Print or file opens the matching report in the Report library, already run for what is on screen. Print and Download then work as they do for any report.',
      },
    ],
  },
];
