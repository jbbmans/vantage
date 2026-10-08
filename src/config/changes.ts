/**
 * What changed, for the people who use Vantage: newest first, in their words rather than the code's. "What's new" shows
 * these, and marks the menu until someone has read the newest. Add an entry for a change a Marine would notice; the
 * engineering record stays in docs/PROGRESS.md.
 */
export interface Change { date: string; title: string; items: string[] }

export const CHANGES: Change[] = [
  {
    date: '2026-10-08',
    title: 'Unit Managers and Vantage Administrators',
    items: [
      'The people who run your Unit Instance are its Unit Managers. A Lead Unit Manager also decides who holds those roles and whether Vantage support must ask before looking. The console they use is now the Unit Manager console.',
      'Vantage staff are Vantage Administrators, Vantage Support and Vantage Auditors, and their console is the Vantage Administrator console. None of them reads your records by holding that role.',
      'Nobody gives themselves more reach. A Unit Manager cannot grant themselves a role that reads Marines’ records, name themselves a unit’s leader, or join with their own code for such a role: another Unit Manager or the chain of command does it, and the audit trail shows who.',
      'A Vantage Administrator never names themselves your Unit Instance’s Lead Unit Manager, and a Unit Instance role lasts only while its holder belongs to a unit of it.',
    ],
  },
  {
    date: '2026-10-08',
    title: 'One account through every transfer',
    items: [
      'When you transfer, your new command invites the email address you already use. Sign in and accept it, and you join with your own account: your record, private entries, career plan and history come with you.',
      'The Roles tab on your page in Team shows every unit you have belonged to and when, with your billets and primary unit. Leaders see the part inside their own command, never where else you served.',
      'If your CAC is linked, Confirm with your CAC works wherever Vantage asks you to confirm it is you, so accounts made from a card or the roster no longer need a password for that.',
      'Once your card has signed you in, its link to your account is yours: your command cannot move it. Vantage support corrects it if your card is reissued, and you are told whenever it changes.',
      'If you serve in two commands, your profile is kept by the one that holds your primary unit, and only Vantage support or your own reset link unlocks your account.',
    ],
  },
  {
    date: '2026-10-07',
    title: 'Unit Instances, and who can do what',
    items: [
      'Your command on Vantage is a Unit Instance: its units, people, roster feed, retention and audit trail are its own, kept apart from every other command’s.',
      'Your account is yours, not your command’s. It moves with you, and your private entries, career plan and export stay with it.',
      'The Unit Manager console runs one Unit Instance at a time, for its owners and administrators: people and roles, units and leaders, the personnel feed, retention and holds. Its roles manage the structure; they do not read anyone’s records.',
      'Vantage staff have a console of their own, the Vantage Administrator console. They see your Unit Instance as a name and its counts, and look inside only when your owners approve it: read-only, for a few hours, and in your audit trail.',
      'A role can be granted until a date, for an acting billet or a leave period, and it ends on its own.',
      '“Why can they?” on a Marine’s Roles tab, and in the Unit Manager console, names every grant behind what someone can do: the role and where it was granted, the chain of command, leadership, and Unit Instance administration.',
      'A forgotten password or a lost authenticator is now Vantage support’s to reset (Need help? on the sign-in page), because an account can belong to more than one Unit Instance.',
      'Vantage is being readied to run on the Marine Corps Enterprise Network. There, it has no public website, shows the DoD notice before sign-in, and accounts come from an invitation, the personnel roster or a CAC rather than signing up.',
      'If you serve in two commands, you work in both, and neither sees the other. Nobody can move a Marine, a record, a project, a contact, a report or an imported sheet from one command into the other, and a Marine joins a new command by invitation rather than being pulled in.',
    ],
  },
  {
    date: '2026-10-05',
    title: 'FITREP and fixes',
    items: [
      'FITREP input follows the MRO worksheet: a Section C draft of dash bullets with no headings, as Section C reads, and the worksheet’s PME and Other blocks beside it, each with its own Copy.',
      'Each entry is read for the FITREP attribute it gives your reporting senior evidence for, and Readiness reads it the same way, so the coverage and the draft agree. Select a sentence to see its attribute.',
      'JEPES command input you submitted, and FITREPs you wrote, land under Section H: Fulfillment of Evaluation Responsibilities.',
      'Readiness no longer tells everyone to complete resident PME. It asks for your PME status, and tells a Sergeant with distance PME what else MARADMIN 630/24 requires.',
      'Readiness puts the sections with no evidence on one card, says what evidence for each missing attribute looks like, and offers your annual period end date where a MARADMIN confirms it.',
      'The demo’s section lead has a FITREP record of their own to explore.',
      'A personnel extract that lists a Marine for the first time, already separated, turns off their account (within the mass-separation guard).',
      'An import keyed by a document number no longer overwrites a case that came from a different report. The import wizard can key a sheet by two columns.',
    ],
  },
  {
    date: '2026-10-04',
    title: 'Everyday use',
    items: [
      'A new narrative writer: JEPES input in MCO 1616.1’s own form (a dash, a past-tense verb, the number, the result) under the three command input lines, and FITREP input as a Section C draft.',
      'Select any sentence to see the entries it came from and why it made the cut; keep it, leave it out, or ask for another wording.',
      'A reviewer grades the narrative out of 100 and says what would make it stronger, and what each point rests on: an order, guidance or style.',
      'Credit from your case histories (documents researched, outcomes verified, cases resolved) is written in, and required annual training is held back, as the order says.',
      'Quick Log shows your entry as the narrative will write it, and coaches it as you type. Duplicates, unfinished work and old awards are held out of the input.',
      'Pages open on the last 12 months, so 1 October no longer reads as if nobody had done anything. A period you chose still wins.',
      'On a phone, Today, Work, a log button and your Record sit at the bottom where a thumb reaches. If you lead a team, Team takes the Record’s place.',
      'Due dates say how long: “tomorrow”, “in 4 days”, “1 day overdue”.',
      '⌘K switches the theme, lists the shortcuts, imports activities and downloads your record as a PDF.',
      'Undo after you log an activity, and after you delete a task, project, goal, training, award or counseling.',
      'Today’s cards read “Dollars reconciled” and “Hours logged”, and reminders say how many: “3 readiness fields incomplete”.',
      'On a phone, the Activities filters fold behind one button and the demo banner takes one line.',
      'Packages explain themselves, in four steps beside the list.',
      'Settings names time zones by place: “New York · EDT”, “Okinawa / Tokyo”.',
      'Goals say whether they are on pace for the time gone, with a tick on the bar where an even pace would be.',
      'Tasks show who set them and who holds them by name, titles take two lines on a phone, and due dates say “tomorrow”.',
      'Goal cards read “21 of 30 UMTs”; project cards say “2 of 5 tasks done” and open from their title.',
      'On a phone, the Team roster is a list you can read, with each Marine’s billet, roles and controls in reach.',
      'Dates and times read one way everywhere: “05 Sep 26”, “28 Sep 26 1432”.',
      'Quick Log fills in the outcome when your sentence ends with one: “…, all cleared on the next report”.',
      'On an entry’s page, each thing it is missing opens Edit.',
      'Each package section prompts for what it asks.',
    ],
  },
  {
    date: '2026-10-03',
    title: 'Fixes and trust',
    items: [
      'FITREP packages count Quick Log entries again. They had been filed under “Unassigned”.',
      'Quick Log reads “Sep 30”, “last Friday”, “$1.2 million” and “3/4 of the backlog” the way you meant them.',
      'A Marine listed again in the next personnel extract has their account turned back on.',
      'An amount typed with commas on a case (“1,118.38”) is saved.',
      'Goal and FITREP countdowns are no longer a day off in the evening.',
      'Security fixes to sign-in, uploads and goals. The new Security page says how to report anything else.',
      'Security, privacy and accessibility pages, linked from sign-in.',
    ],
  },
];

export const LATEST_CHANGE = CHANGES[0].date;
