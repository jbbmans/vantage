/**
 * What changed, for the people who use Vantage: newest first, in their words rather than the code's. "What's new" shows
 * these, and marks the menu until someone has read the newest. Add an entry for a change a Marine would notice; the
 * engineering record stays in docs/PROGRESS.md.
 */
export interface Change { date: string; title: string; items: string[] }

export const CHANGES: Change[] = [
  {
    date: '2026-10-07',
    title: 'Organizations, and who can do what',
    items: [
      'Vantage is one service now, and your command is an organization on it: its units, people, roster feed, retention and audit trail are its own, kept apart from every other command’s.',
      'Your account is yours, not your command’s. It moves with you, and your private entries, career plan and export stay with it.',
      'The owner console runs one organization at a time, for its owners and administrators: people and roles, units and leaders, the personnel feed, retention and holds. Organization roles manage the structure; they do not read anyone’s records.',
      'Vantage staff have a console of their own, the admin dashboard. They see your organization as a name and its counts, and look inside only when your owners approve it: read-only, for a few hours, and in your audit trail.',
      'A role can be granted until a date, for an acting billet or a leave period, and it ends on its own.',
      '“Why can they?” on a Marine’s Roles tab, and in the owner console, names every grant behind what someone can do: the role and where it was granted, the chain of command, leadership, and organization administration.',
      'A forgotten password or a lost authenticator is now Vantage support’s to reset (Need help? on the sign-in page), because an account can belong to more than one organization.',
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
