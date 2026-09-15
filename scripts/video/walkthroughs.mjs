/**
 * What each walkthrough shows, as data.
 *
 * Each entry pairs an `id` from src/config/videos.ts with the steps that demonstrate it. Keep them
 * short: nobody finishes a six-minute tutorial about a text box. Every caption is written for
 * somebody who has never opened Vantage, and every one of them has to be true — these run against
 * the real application, so a caption that overstates what happened is immediately visible.
 */

const H = { 'x-vantage-client': '1' };
const PASSWORD = 'cobalt-orbit-velvet-anchor-927';
const OWNER = { username: 'boletz', first_name: 'John', last_name: 'Boletz', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' };

/** Plausible history, so the screens are not empty and not obviously fake. */
const HISTORY = [
  ['Reconciled 30 ULOs totaling $1,118.38 in DAI', 'Fiscal & Financial', 30, 'ULOs', 1118.38, 'reconciled', 'cleared the aged backlog'],
  ['Processed 12 MIPRs with zero returns', 'Fiscal & Financial', 12, 'MIPRs', 84200, 'obligated', 'all accepted first pass'],
  ['Validated 48 UMTs against the general ledger', 'Fiscal & Financial', 48, 'UMTs', 0, 'reviewed', 'three discrepancies found and corrected'],
  ['Recovered $9,400 in expiring year funds', 'Fiscal & Financial', 1, 'action', 9400, 'saved', 'funds reobligated before expiry'],
  ['Briefed the section on the FY close-out timeline', 'Leadership', 14, 'Marines', 0, null, 'everyone left with their own deadline'],
  ['Trained two junior Marines on DAI reconciliation', 'Leadership', 2, 'Marines', 0, null, 'both now work the queue unsupervised'],
];

export async function seedOwner(page) {
  const status = await (await page.request.get('/api/auth/setup')).json();
  if (status.needsSetup) {
    await page.request.post('/api/auth/setup', {
      headers: H,
      data: { ...OWNER, password: PASSWORD, rank_id: 'Cpl', mos: '3451', email: 'boletz@example.mil' },
    });
  }
  await page.request.post('/api/auth/login', { headers: H, data: { username: OWNER.username, password: PASSWORD } });

  const today = new Date();
  for (const [title, category, qty, unit, dollars, dollarType, result] of HISTORY) {
    const day = new Date(today);
    day.setDate(day.getDate() - Math.floor(Math.random() * 40) - 1);
    await page.request.post('/api/records/activities', {
      headers: H,
      data: {
        title, category, date: day.toISOString().slice(0, 10),
        quantity: qty, unit_label: unit,
        dollar_amount: dollars || null, dollar_type: dollarType,
        result, visibility: 'unit', unit_id: 'G8', status: 'completed',
      },
    }).catch(() => undefined);
  }
}

export const WALKTHROUGHS = [
  {
    id: 'quick-log',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Quick Log', caption: 'Press N anywhere in Vantage to log what you just did.', run: (v) => v.press('n'), hold: 700 },
      {
        caption: 'Write it the way you would say it out loud. No form to work out first.',
        run: (v) => v.type('textarea', 'Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday', 38),
        hold: 1400,
      },
      { caption: 'Vantage reads the date, the count, the value and the evaluation area out of that sentence.', hold: 2600 },
      { caption: 'You check what it understood before anything is saved. Nothing is filed behind your back.', hold: 2400 },
      { caption: 'Press Escape to throw it away — a draft you abandon is never stored.', run: (v) => v.press('Escape'), hold: 1200 },
    ],
  },
  {
    id: 'tour',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Today', caption: 'Vantage opens on what needs you now, not on an empty dashboard.', hold: 2200 },
      { caption: 'The figures report what the work produced. Record count is never shown as productivity.', run: (v) => v.scrollTo(420), hold: 2100 },
      { eyebrow: 'Records', caption: 'Every outcome you logged, with the numbers attached.', run: (v) => v.goto('/records'), hold: 2400 },
      { caption: 'Private by default. Sharing with your unit is a decision you make per record.', run: (v) => v.scrollTo(300), hold: 2000 },
      { eyebrow: 'Reports', caption: 'The same entries become a narrative, a bullet package, and a PDF.', run: (v) => v.goto('/reports'), hold: 2800 },
      { caption: 'Every figure traces back to the record behind it. Nothing here is typed twice.', hold: 2200 },
    ],
  },
  {
    id: 'visibility',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Privacy', caption: 'Every record you write is private until you decide otherwise.', run: (v) => v.goto('/records'), hold: 2000 },
      { caption: 'Open one and the visibility is stated plainly, not buried in a settings page.', run: (v) => v.scrollTo(240), hold: 2400 },
      {
        eyebrow: 'Your audit log',
        caption: 'Every time a leader opens your record, it is written here for you to read.',
        run: (v) => v.goto('/settings?tab=security'),
        hold: 2600,
      },
      { caption: 'You never have to ask anyone what they looked at.', run: (v) => v.scrollTo(400), hold: 2200 },
    ],
  },
  {
    id: 'report-studio',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Reports', caption: 'When an evaluation comes due, the evidence is already here.', run: (v) => v.goto('/reports'), hold: 2200 },
      { caption: 'A narrative written to the character limit, from records you can point at.', hold: 2600 },
      { caption: 'Switch the view to see the same facts as a bullet package.', run: (v) => v.scrollTo(360), hold: 2400 },
      { caption: 'Unlike units are never added together. Twelve MIPRs and thirty ULOs are not forty-two of anything.', hold: 3000 },
    ],
  },
  {
    id: 'unit-dashboard',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Team', caption: 'A section leader opens one screen to see where the work actually is.', run: (v) => v.goto('/team'), hold: 2400 },
      { caption: 'Built only from records people chose to share. A quiet week and an unshared week look different.', run: (v) => v.scrollTo(320), hold: 2800 },
      { caption: 'Roles are per unit. One you hold here confers nothing anywhere else.', run: (v) => v.goto('/team?tab=roles'), hold: 2400 },
    ],
  },
  {
    id: 'governance',
    seed: seedOwner,
    steps: [
      { eyebrow: 'Owner console', caption: 'Records management is set here, and every schedule starts switched off.', run: (v) => v.goto('/operator?tab=retention'), hold: 2600 },
      { caption: 'A schedule needs its authority cited. One without is somebody’s guess.', run: (v) => v.scrollTo(300), hold: 2600 },
      {
        eyebrow: 'Privacy inventory',
        caption: 'Built from the live database every time you open it, so it cannot quietly stop being true.',
        run: (v) => v.goto('/operator?tab=privacy'),
        hold: 2800,
      },
      { caption: 'It reports its own gaps, and exports as Markdown for a privacy assessment.', run: (v) => v.scrollTo(340), hold: 2400 },
    ],
  },
];
