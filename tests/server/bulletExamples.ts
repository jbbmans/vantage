import type { EntryInput } from '../../shared/writer/facts.ts';

/**
 * Fixed examples the writer is held to: entries of the kind Marines log in six fields of work, each with the exact
 * JEPES bullet (MCO 1616.1, Appendix E) and the exact FITREP Section C bullet it writes. A change to the writer that
 * moves any of them is a change to what every Marine's record says, so it shows up here first, line by line.
 *
 * Between them they cover a count the title does not hold, in front of its noun or as the object of the verb, or in
 * parentheses when it fits neither; a count of one already stated, or stated by the outcome; each kind of dollars and
 * its one connecting word; each kind of outcome (a grade, something the Marine did, a measure, a clause of its own);
 * time, distance, people and things; a gerund, present tense and first-person title put right; and a name that holds a
 * unit's word ("Toys for Tots") left alone.
 */
export interface BulletExample { domain: Domain; entry: EntryInput; jepes: string; fitrep: string }

export const DOMAINS = ['finance', 'admin', 'motor transport', 'supply', 'training', 'leadership'] as const;
export type Domain = (typeof DOMAINS)[number];

export const BULLET_EXAMPLES: BulletExample[] = [
  // Finance.
  {
    domain: 'finance',
    entry: { title: 'Processed MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated', result: 'zero returned for correction' },
    jepes: 'Processed 22 MIPRs obligating $240,000 for the G-8; zero returned for correction.',
    fitrep: 'Processed 22 MIPRs obligating $240K for the G-8; zero returned for correction.',
  },
  {
    domain: 'finance',
    entry: { title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report' },
    jepes: 'Reconciled 14 ULOs totaling $48,250 in DAI; all cleared on the next report.',
    fitrep: 'Reconciled 14 ULOs totaling $48.3K in DAI; all cleared on the next report.',
  },
  {
    domain: 'finance',
    entry: { title: 'Deobligated dormant MIPR balances', quantity: 3, unit_label: 'MIPRs', dollar_amount: 18250, dollar_type: 'saved', result: 'funds returned before the year closed' },
    jepes: 'Deobligated dormant MIPR balances (3 MIPRs), saving $18,250; funds returned before the year closed.',
    fitrep: 'Deobligated dormant MIPR balances (3 MIPRs), saving $18.3K; funds returned before the year closed.',
  },
  {
    domain: 'finance',
    entry: { title: 'Processing MIPRs for Q4', quantity: 4, unit_label: 'MIPRs' },
    jepes: 'Processed 4 MIPRs for Q4.',
    fitrep: 'Processed 4 MIPRs for Q4.',
  },
  {
    domain: 'finance',
    entry: { title: 'Reviewed GPC statements for the S-4', quantity: 12, unit_label: 'statements', dollar_amount: 2875, dollar_type: 'reviewed' },
    jepes: 'Reviewed 12 GPC statements covering $2,875 for the S-4.',
    fitrep: 'Reviewed 12 GPC statements covering $2,875 for the S-4.',
  },
  {
    domain: 'finance',
    entry: { title: 'I reconciled 30 ULOs totaling $1,118.38 in SABRS', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled' },
    jepes: 'Reconciled 30 ULOs totaling $1,118.38 in SABRS.',
    fitrep: 'Reconciled 30 ULOs totaling $1,118.38 in SABRS.',
  },
  {
    domain: 'finance',
    entry: { title: 'Cleared 2-Way UMTs on the Q4 report', quantity: 4, unit_label: 'UMTs', dollar_amount: 6206.4, dollar_type: 'reconciled', system: 'SABRS' },
    jepes: 'Cleared 4 2-Way UMTs totaling $6,206 on the Q4 report in SABRS.',
    fitrep: 'Cleared 4 2-Way UMTs totaling $6,206 on the Q4 report in SABRS.',
  },
  {
    domain: 'finance',
    entry: { title: 'Built a UMT tracker in Excel', result: 'cut the weekly review from 3 hours to 1 hour' },
    jepes: 'Built a UMT tracker in Excel, cutting the weekly review from 3 hours to 1 hour.',
    fitrep: 'Built a UMT tracker in Excel, cutting the weekly review from 3 hours to 1 hour.',
  },
  // Admin.
  {
    domain: 'admin',
    entry: { title: 'Processed unit diary entries in MCTFS', quantity: 120, unit_label: 'entries', result: 'zero errors on the monthly audit' },
    jepes: 'Processed 120 unit diary entries in MCTFS, resulting in zero errors on the monthly audit.',
    fitrep: 'Processed 120 unit diary entries in MCTFS; zero errors on the monthly audit.',
  },
  {
    domain: 'admin',
    entry: { title: 'Audited OMPFs for the battalion', quantity: 85, unit_label: 'OMPFs', result: 'zero discrepancies at the IG inspection' },
    jepes: 'Audited 85 OMPFs for the battalion, resulting in zero discrepancies at the IG inspection.',
    fitrep: 'Audited 85 OMPFs for the battalion; zero discrepancies at the IG inspection.',
  },
  {
    domain: 'admin',
    entry: { title: 'Drafted award recommendations for the CO', quantity: 6, unit_label: 'recommendations', result: 'all six approved at the first review' },
    jepes: 'Drafted 6 award recommendations for the CO; all six approved at the first review.',
    fitrep: 'Drafted 6 award recommendations for the CO; all six approved at the first review.',
  },
  {
    domain: 'admin',
    entry: { title: 'Routed DTS vouchers for TAD travel', quantity: 48, unit_label: 'vouchers', dollar_amount: 52300, dollar_type: 'reviewed', result: 'average turnaround cut from 9 days to 3' },
    jepes: 'Routed 48 DTS vouchers covering $52,300 for TAD travel; average turnaround cut from 9 days to 3.',
    fitrep: 'Routed 48 DTS vouchers covering $52.3K for TAD travel; average turnaround cut from 9 days to 3.',
  },
  {
    domain: 'admin',
    entry: { title: 'Prepared fitness report packages for the reporting seniors', quantity: 15, unit_label: 'packages', result: 'none returned late' },
    jepes: 'Prepared 15 fitness report packages for the reporting seniors; none returned late.',
    fitrep: 'Prepared 15 fitness report packages for the reporting seniors; none returned late.',
  },
  {
    domain: 'admin',
    entry: { title: 'Managing the battalion correspondence log', result: 'reduced overdue taskers by 40%' },
    jepes: 'Managed the battalion correspondence log, reducing overdue taskers by 40%.',
    fitrep: 'Managed the battalion correspondence log, reducing overdue taskers by 40%.',
  },
  {
    domain: 'admin',
    entry: { title: 'Updated emergency contact information (RED) for the company', quantity: 140, unit_label: 'Marines' },
    jepes: 'Updated emergency contact information (RED) for the company (140 Marines).',
    fitrep: 'Updated emergency contact information (RED) for the company (140 Marines).',
  },
  {
    domain: 'admin',
    entry: { title: 'Ran the S-1 customer service desk', quantity: 300, unit_label: 'hours', result: 'served 450 Marines' },
    jepes: 'Ran the S-1 customer service desk (300 hours), serving 450 Marines.',
    fitrep: 'Ran the S-1 customer service desk (300 hours), serving 450 Marines.',
  },
  // Motor transport.
  {
    domain: 'motor transport',
    entry: { title: 'Performed PMCS on the motor pool', quantity: 40, unit_label: 'vehicles', result: '100% mission readiness' },
    jepes: 'Performed PMCS on the motor pool (40 vehicles), resulting in 100% mission readiness.',
    fitrep: 'Performed PMCS on the motor pool (40 vehicles); 100% mission readiness.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Conducted PMCS on the battalion\'s MTVRs', quantity: 12, unit_label: 'MTVRs' },
    jepes: 'Conducted PMCS on the battalion\'s 12 MTVRs.',
    fitrep: 'Conducted PMCS on the battalion\'s 12 MTVRs.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Inspected the vehicles for corrosion', quantity: 30, unit_label: 'vehicles', result: 'found and fixed 4 cracked frames' },
    jepes: 'Inspected 30 vehicles for corrosion, finding and fixing 4 cracked frames.',
    fitrep: 'Inspected 30 vehicles for corrosion, finding and fixing 4 cracked frames.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Drove convoy operations to Twentynine Palms', quantity: 1200, unit_label: 'miles', result: 'no mishaps' },
    jepes: 'Drove convoy operations to Twentynine Palms (1,200 miles), resulting in no mishaps.',
    fitrep: 'Drove convoy operations to Twentynine Palms (1,200 miles); no mishaps.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Licensed drivers on the JLTV', quantity: 18, unit_label: 'drivers' },
    jepes: 'Licensed 18 drivers on the JLTV.',
    fitrep: 'Licensed 18 drivers on the JLTV.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Dispatched vehicles through GCSS-MC', quantity: 220, unit_label: 'dispatches', result: 'zero late returns' },
    jepes: 'Dispatched vehicles through GCSS-MC (220 dispatches), resulting in zero late returns.',
    fitrep: 'Dispatched vehicles through GCSS-MC (220 dispatches); zero late returns.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Recovered a disabled 7-ton during the field exercise', result: 'returned it to service in 6 hours' },
    jepes: 'Recovered a disabled 7-ton during the field exercise, returning it to service in 6 hours.',
    fitrep: 'Recovered a disabled 7-ton during the field exercise, returning it to service in 6 hours.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Rebuilt the motor pool tool room inventory', quantity: 600, unit_label: 'tools', dollar_amount: 85000, dollar_type: 'impact', result: 'zero losses at the quarterly inventory' },
    jepes: 'Rebuilt the motor pool tool room inventory (600 tools), valued at $85,000; zero losses at the quarterly inventory.',
    fitrep: 'Rebuilt the motor pool tool room inventory (600 tools), valued at $85K; zero losses at the quarterly inventory.',
  },
  // Supply.
  {
    domain: 'supply',
    entry: { title: 'Conducted a wall-to-wall inventory of the armory', quantity: 450, unit_label: 'weapons', result: '100% accountability' },
    jepes: 'Conducted a wall-to-wall inventory of the armory (450 weapons), resulting in 100% accountability.',
    fitrep: 'Conducted a wall-to-wall inventory of the armory (450 weapons); 100% accountability.',
  },
  {
    domain: 'supply',
    entry: { title: 'Requisitioned repair parts in GCSS-MC', quantity: 75, unit_label: 'parts', dollar_amount: 132000, dollar_type: 'obligated' },
    jepes: 'Requisitioned 75 repair parts obligating $132,000 in GCSS-MC.',
    fitrep: 'Requisitioned 75 repair parts obligating $132K in GCSS-MC.',
  },
  {
    domain: 'supply',
    entry: { title: 'Turned in excess equipment to DLA Disposition', quantity: 38, unit_label: 'items', dollar_amount: 410000, dollar_type: 'impact' },
    jepes: 'Turned in excess equipment to DLA Disposition (38 items), valued at $410,000.',
    fitrep: 'Turned in excess equipment to DLA Disposition (38 items), valued at $410K.',
  },
  {
    domain: 'supply',
    entry: { title: 'Reconciled the CMR for the company', dollar_amount: 1500000, dollar_type: 'reconciled', result: 'closed 12 discrepancies' },
    jepes: 'Reconciled the CMR for the company, totaling $1.5M; closed 12 discrepancies.',
    fitrep: 'Reconciled the CMR for the company, totaling $1.5M; closed 12 discrepancies.',
  },
  {
    domain: 'supply',
    entry: { title: 'Issued organizational clothing to new joins', quantity: 64, unit_label: 'Marines' },
    jepes: 'Issued organizational clothing to new joins (64 Marines).',
    fitrep: 'Issued organizational clothing to new joins (64 Marines).',
  },
  {
    domain: 'supply',
    entry: { title: 'Processed GPC purchases for the battalion', quantity: 41, unit_label: 'purchases', dollar_amount: 27800, dollar_type: 'obligated', result: 'zero findings in the annual audit' },
    jepes: 'Processed 41 GPC purchases obligating $27,800 for the battalion, resulting in zero findings in the annual audit.',
    fitrep: 'Processed 41 GPC purchases obligating $27.8K for the battalion; zero findings in the annual audit.',
  },
  {
    domain: 'supply',
    entry: { title: 'Located missing serialized items', quantity: 9, unit_label: 'items', dollar_amount: 64000, dollar_type: 'saved' },
    jepes: 'Located 9 missing serialized items, saving $64,000.',
    fitrep: 'Located 9 missing serialized items, saving $64K.',
  },
  {
    domain: 'supply',
    entry: { title: 'Organized the supply warehouse', result: 'cut issue time from 20 minutes to 5' },
    jepes: 'Organized the supply warehouse, cutting issue time from 20 minutes to 5.',
    fitrep: 'Organized the supply warehouse, cutting issue time from 20 minutes to 5.',
  },
  // Training.
  {
    domain: 'training',
    entry: { title: 'Trained junior Marines on DAI', quantity: 3, unit_label: 'Marines', result: 'all three now process requisitions without review' },
    jepes: 'Trained 3 junior Marines on DAI; all three now process requisitions without review.',
    fitrep: 'Trained 3 junior Marines on DAI; all three now process requisitions without review.',
  },
  {
    domain: 'training',
    entry: { title: 'Completed Sergeants Course', result: '3.8 GPA' },
    jepes: 'Completed Sergeants Course, with a 3.8 GPA.',
    fitrep: 'Completed Sergeants Course, with a 3.8 GPA.',
  },
  {
    domain: 'training',
    entry: { title: 'Instructed MCMAP classes', quantity: 40, unit_label: 'hours', result: 'certified 25 Marines in tan belt' },
    jepes: 'Instructed MCMAP classes (40 hours), certifying 25 Marines in tan belt.',
    fitrep: 'Instructed MCMAP classes (40 hours), certifying 25 Marines in tan belt.',
  },
  {
    domain: 'training',
    entry: { title: 'Coordinated rifle range qualification for the company', quantity: 120, unit_label: 'Marines', result: '98% qualified on the first attempt' },
    jepes: 'Coordinated rifle range qualification for the company (120 Marines); 98% qualified on the first attempt.',
    fitrep: 'Coordinated rifle range qualification for the company (120 Marines); 98% qualified on the first attempt.',
  },
  {
    domain: 'training',
    entry: { title: 'Taught land navigation to the platoon', quantity: 30, unit_label: 'Marines' },
    jepes: 'Taught land navigation to the platoon (30 Marines).',
    fitrep: 'Taught land navigation to the platoon (30 Marines).',
  },
  {
    domain: 'training',
    entry: { title: 'Built a training schedule in MCTIMS', result: 'every Marine current on annual training' },
    jepes: 'Built a training schedule in MCTIMS; every Marine current on annual training.',
    fitrep: 'Built a training schedule in MCTIMS; every Marine current on annual training.',
  },
  {
    domain: 'training',
    entry: { title: 'Studied for the Staff NCO Career Course', quantity: 60, unit_label: 'hours' },
    jepes: 'Studied 60 hours for the Staff NCO Career Course.',
    fitrep: 'Studied 60 hours for the Staff NCO Career Course.',
  },
  {
    domain: 'training',
    entry: { title: 'Ran the battalion swim qualification', quantity: 200, unit_label: 'Marines', result: 'qualified 185 at the first attempt' },
    jepes: 'Ran the battalion swim qualification (200 Marines), qualifying 185 at the first attempt.',
    fitrep: 'Ran the battalion swim qualification (200 Marines), qualifying 185 at the first attempt.',
  },
  // Leadership.
  {
    domain: 'leadership',
    entry: { title: 'Led section PT: 10 km hike', quantity: 10, unit_label: 'km', result: 'Planned the route and the water points for eight Marines' },
    jepes: 'Led section PT: 10 km hike, planning the route and the water points for eight Marines.',
    fitrep: 'Led section PT: 10 km hike, planning the route and the water points for eight Marines.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Mentored junior Marines through their first evaluations', quantity: 4, unit_label: 'Marines', result: 'all four promoted on time' },
    jepes: 'Mentored 4 junior Marines through their first evaluations; all four promoted on time.',
    fitrep: 'Mentored 4 junior Marines through their first evaluations; all four promoted on time.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Counseled Marines on financial readiness', quantity: 12, unit_label: 'Marines', result: 'two cleared GTCC delinquencies' },
    jepes: 'Counseled 12 Marines on financial readiness; two cleared GTCC delinquencies.',
    fitrep: 'Counseled 12 Marines on financial readiness; two cleared GTCC delinquencies.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', result: 'Sorted and shelved the weekly delivery' },
    jepes: 'Volunteered 6 hours at the base food pantry, sorting and shelving the weekly delivery.',
    fitrep: 'Volunteered 6 hours at the base food pantry, sorting and shelving the weekly delivery.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Served as acting section chief', quantity: 3, unit_label: 'months', result: 'section closed every tasker on time' },
    jepes: 'Served 3 months as acting section chief; section closed every tasker on time.',
    fitrep: 'Served 3 months as acting section chief; section closed every tasker on time.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Supervised a working party of Marines', quantity: 8, unit_label: 'Marines', result: 'moved the battalion armory in two days' },
    jepes: 'Supervised a working party of 8 Marines, moving the battalion armory in two days.',
    fitrep: 'Supervised a working party of 8 Marines, moving the battalion armory in two days.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Organized a Toys for Tots drive', quantity: 400, unit_label: 'toys', result: 'collected 400 toys for families in Twentynine Palms' },
    jepes: 'Organized a Toys for Tots drive, collecting 400 toys for families in Twentynine Palms.',
    fitrep: 'Organized a Toys for Tots drive, collecting 400 toys for families in Twentynine Palms.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Ran the Marine of the Quarter board', quantity: 5, unit_label: 'candidates', result: 'board recommended the selectee the same day' },
    jepes: 'Ran the Marine of the Quarter board (5 candidates); board recommended the selectee the same day.',
    fitrep: 'Ran the Marine of the Quarter board (5 candidates); board recommended the selectee the same day.',
  },
  // The edges: a dollar figure at a unit's boundary, an outcome that states the dollars, a label before the noun
  // ("Page 11"), a verb pair, a vague count ("a few"), a verb in the outcome, "all" of a thing counted in items, a
  // modifier that is not the unit ("parts requisitions"), a spelled count, an outcome with its own verb and count, a
  // count the outcome states, and a verb and preposition with people.
  {
    domain: 'finance',
    entry: { title: 'Obligated MIPRs for the fourth quarter spend plan', quantity: 12, unit_label: 'MIPRs', dollar_amount: 999960, dollar_type: 'obligated' },
    jepes: 'Obligated 12 MIPRs totaling $999,960 for the fourth quarter spend plan.',
    fitrep: 'Obligated 12 MIPRs totaling $1M for the fourth quarter spend plan.',
  },
  {
    domain: 'finance',
    entry: { title: 'Recovered overpayments from DTS vouchers', quantity: 14, unit_label: 'vouchers', dollar_amount: 40000, dollar_type: 'saved', result: 'saved the command $40K' },
    jepes: 'Recovered overpayments from 14 DTS vouchers, saving the command $40K.',
    fitrep: 'Recovered overpayments from 14 DTS vouchers, saving the command $40K.',
  },
  {
    domain: 'admin',
    entry: { title: 'Drafted Page 11 entries for the company', quantity: 30, unit_label: 'entries' },
    jepes: 'Drafted 30 Page 11 entries for the company.',
    fitrep: 'Drafted 30 Page 11 entries for the company.',
  },
  {
    domain: 'admin',
    entry: { title: 'Reviewed and approved travel claims', quantity: 22, unit_label: 'claims', result: 'all paid within 30 days' },
    jepes: 'Reviewed and approved 22 travel claims; all paid within 30 days.',
    fitrep: 'Reviewed and approved 22 travel claims; all paid within 30 days.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Inspected a few vehicles before the convoy', quantity: 6, unit_label: 'vehicles', result: 'found and fixed 2 leaking hoses' },
    jepes: 'Inspected 6 vehicles before the convoy, finding and fixing 2 leaking hoses.',
    fitrep: 'Inspected 6 vehicles before the convoy, finding and fixing 2 leaking hoses.',
  },
  {
    domain: 'motor transport',
    entry: { title: 'Led the convoy to Twentynine Palms', quantity: 12, unit_label: 'vehicles', result: 'no vehicles broke down on the route' },
    jepes: 'Led the convoy to Twentynine Palms (12 vehicles); no vehicles broke down on the route.',
    fitrep: 'Led the convoy to Twentynine Palms (12 vehicles); no vehicles broke down on the route.',
  },
  {
    domain: 'supply',
    entry: { title: 'Accounted for all serialized gear in the cage', quantity: 300, unit_label: 'items', result: 'zero missing at the change of command inventory' },
    jepes: 'Accounted for all serialized gear in the cage (300 items), resulting in zero missing at the change of command inventory.',
    fitrep: 'Accounted for all serialized gear in the cage (300 items); zero missing at the change of command inventory.',
  },
  {
    domain: 'supply',
    entry: { title: 'Processed parts requisitions for the motor pool', quantity: 75, unit_label: 'parts', dollar_amount: 132000, dollar_type: 'obligated' },
    jepes: 'Processed parts requisitions for the motor pool (75 parts), obligating $132,000.',
    fitrep: 'Processed parts requisitions for the motor pool (75 parts), obligating $132K.',
  },
  {
    domain: 'training',
    entry: { title: 'Trained twenty-five Marines on the M27', quantity: 25, unit_label: 'Marines', result: 'all qualified on the first day' },
    jepes: 'Trained 25 Marines on the M27; all qualified on the first day.',
    fitrep: 'Trained 25 Marines on the M27; all qualified on the first day.',
  },
  {
    domain: 'training',
    entry: { title: 'Ran swim qualification for the company', quantity: 30, unit_label: 'Marines', result: '28 Marines passed on the first attempt' },
    jepes: 'Ran swim qualification for the company (30 Marines); 28 Marines passed on the first attempt.',
    fitrep: 'Ran swim qualification for the company (30 Marines); 28 Marines passed on the first attempt.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Mentored newly joined Marines in the section', quantity: 4, unit_label: 'Marines', result: 'all 4 earned their MCMAP tan belt' },
    jepes: 'Mentored newly joined Marines in the section; all 4 earned their MCMAP tan belt.',
    fitrep: 'Mentored newly joined Marines in the section; all 4 earned their MCMAP tan belt.',
  },
  {
    domain: 'leadership',
    entry: { title: 'Briefed at the Marines Memorial Club', quantity: 40, unit_label: 'Marines' },
    jepes: 'Briefed at the Marines Memorial Club (40 Marines).',
    fitrep: 'Briefed at the Marines Memorial Club (40 Marines).',
  },
];

/**
 * Entries the independent review of these examples turned up, each with the exact bullet it now writes: words that
 * guess a count ("several", "a dozen", "20+"), a gerund the lexicon does not know, a result with two verbs, an outcome
 * that keeps its own clause (a second verb, a subject of its own, nothing after its verb), "funds" or "money" as the
 * object of a money verb, and a count of what was saved. The FITREP text is the same unless it is given.
 */
export interface EdgeCase { entry: EntryInput; jepes: string; fitrep?: string }

export const EDGE_CASES: EdgeCase[] = [
  { entry: { title: 'Processed several MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs' }, jepes: 'Processed 22 MIPRs for the G-8.' },
  { entry: { title: 'Inspected a dozen vehicles', quantity: 12, unit_label: 'vehicles' }, jepes: 'Inspected 12 vehicles.' },
  { entry: { title: 'Reviewed hundreds of travel claims', quantity: 300, unit_label: 'claims' }, jepes: 'Reviewed 300 travel claims.' },
  { entry: { title: 'Trained 20+ Marines on the M27', quantity: 24, unit_label: 'Marines' }, jepes: 'Trained 24 Marines on the M27.' },
  { entry: { title: 'Digitizing the training records', quantity: 400, unit_label: 'records' }, jepes: 'Digitized 400 training records.' },
  { entry: { title: 'Processed leave and liberty requests', quantity: 25, unit_label: 'requests' }, jepes: 'Processed 25 leave and liberty requests.' },
  { entry: { title: 'Processed DTS and GPC reconciliations', quantity: 18, unit_label: 'reconciliations' }, jepes: 'Processed 18 DTS and GPC reconciliations.' },
  {
    entry: { title: 'Reviewed GPC statements', quantity: 12, unit_label: 'statements', dollar_amount: 2875, dollar_type: 'reviewed', result: 'covering $2,875 in purchases' },
    jepes: 'Reviewed 12 GPC statements, covering $2,875 in purchases.',
  },
  { entry: { title: 'Rebuilt the PCS tracker', result: 'cut late returns from 12 to 2' }, jepes: 'Rebuilt the PCS tracker, cutting late returns from 12 to 2.' },
  { entry: { title: 'Audited files', quantity: 40, unit_label: 'files', result: 'corrected old records' }, jepes: 'Audited 40 files, correcting old records.' },
  {
    entry: { title: 'Audited OMPFs for the battalion', quantity: 85, unit_label: 'OMPFs', result: 'identified 4 errors and replaced the pages' },
    jepes: 'Audited 85 OMPFs for the battalion, identifying 4 errors and replacing the pages.',
  },
  {
    entry: { title: 'Audited OMPFs for the battalion', quantity: 85, unit_label: 'OMPFs', result: 'found 6 missing pages, corrected all' },
    jepes: 'Audited 85 OMPFs for the battalion; found 6 missing pages, corrected all.',
  },
  {
    entry: { title: 'Rebuilt the DTS routing process', result: 'processed vouchers increased from 40 to 60 a week' },
    jepes: 'Rebuilt the DTS routing process; processed vouchers increased from 40 to 60 a week.',
  },
  { entry: { title: 'Submitted the Q4 budget', result: 'completed ahead of schedule' }, jepes: 'Submitted the Q4 budget; completed ahead of schedule.' },
  { entry: { title: 'Briefed the budget', result: 'the CO approved funding' }, jepes: 'Briefed the budget; the CO approved funding.' },
  {
    entry: { title: 'Volunteered for the no-notice audit response team', result: 'produced all 120 supporting documents within 48 hours' },
    jepes: 'Volunteered for the no-notice audit response team, producing all 120 supporting documents within 48 hours.',
  },
  {
    entry: { title: 'Obligated funds for the range upgrade', dollar_amount: 45000, dollar_type: 'obligated' },
    jepes: 'Obligated $45,000 for the range upgrade.', fitrep: 'Obligated $45K for the range upgrade.',
  },
  {
    entry: { title: 'Saved the battalion money by consolidating orders', dollar_amount: 12000, dollar_type: 'saved' },
    jepes: 'Saved the battalion $12,000 by consolidating orders.', fitrep: 'Saved the battalion $12K by consolidating orders.',
  },
  {
    entry: { title: 'FY26 year-end close', quantity: 1200, unit_label: 'documents', dollar_amount: 441300, dollar_type: 'saved' },
    jepes: 'Saved $441,300 (1,200 documents), in support of the FY26 year-end close.',
    fitrep: 'Saved $441.3K (1,200 documents), supporting the FY26 year-end close.',
  },
  {
    entry: { title: 'Deobligated dormant MIPR balances', quantity: 3, unit_label: 'MIPRs', dollar_amount: 18250, dollar_type: 'saved', result: 'returning funds to the G-8' },
    jepes: 'Deobligated dormant MIPR balances (3 MIPRs), saving $18,250 and returning funds to the G-8.',
    fitrep: 'Deobligated dormant MIPR balances (3 MIPRs), saving $18.3K and returning funds to the G-8.',
  },
  {
    entry: { title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'cleared $48,250 in aged balances' },
    jepes: 'Reconciled 14 ULOs in DAI, clearing $48,250 in aged balances.',
    fitrep: 'Reconciled 14 ULOs in DAI, clearing $48.3K in aged balances.',
  },
];
