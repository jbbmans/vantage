/**
 * Vantage — Marine Corps reference data.
 *
 * Ranks, billets, and the MARFORRES org tree live here as seed data rather than
 * as an enum in the code, because every one of them is a row a unit will want
 * to edit. A command that can't add its own billet titles stops getting used in
 * about a week.
 */

/**
 * grade   pay grade, the thing that actually sorts
 * abbr    what goes on a roster line
 * tier    enlisted | snco | warrant | officer — drives default permissions
 */
export const RANKS = [
  { grade: 'E-1', abbr: 'Pvt', name: 'Private', tier: 'enlisted', sort: 1 },
  { grade: 'E-2', abbr: 'PFC', name: 'Private First Class', tier: 'enlisted', sort: 2 },
  { grade: 'E-3', abbr: 'LCpl', name: 'Lance Corporal', tier: 'enlisted', sort: 3 },
  { grade: 'E-4', abbr: 'Cpl', name: 'Corporal', tier: 'nco', sort: 4 },
  { grade: 'E-5', abbr: 'Sgt', name: 'Sergeant', tier: 'nco', sort: 5 },
  { grade: 'E-6', abbr: 'SSgt', name: 'Staff Sergeant', tier: 'snco', sort: 6 },
  { grade: 'E-7', abbr: 'GySgt', name: 'Gunnery Sergeant', tier: 'snco', sort: 7 },
  { grade: 'E-8', abbr: 'MSgt', name: 'Master Sergeant', tier: 'snco', sort: 8 },
  { grade: 'E-8', abbr: '1stSgt', name: 'First Sergeant', tier: 'snco', sort: 9 },
  { grade: 'E-9', abbr: 'MGySgt', name: 'Master Gunnery Sergeant', tier: 'snco', sort: 10 },
  { grade: 'E-9', abbr: 'SgtMaj', name: 'Sergeant Major', tier: 'snco', sort: 11 },
  { grade: 'E-9', abbr: 'SMMC', name: 'Sergeant Major of the Marine Corps', tier: 'snco', sort: 12 },

  { grade: 'W-1', abbr: 'WO', name: 'Warrant Officer 1', tier: 'warrant', sort: 20 },
  { grade: 'W-2', abbr: 'CWO2', name: 'Chief Warrant Officer 2', tier: 'warrant', sort: 21 },
  { grade: 'W-3', abbr: 'CWO3', name: 'Chief Warrant Officer 3', tier: 'warrant', sort: 22 },
  { grade: 'W-4', abbr: 'CWO4', name: 'Chief Warrant Officer 4', tier: 'warrant', sort: 23 },
  { grade: 'W-5', abbr: 'CWO5', name: 'Chief Warrant Officer 5', tier: 'warrant', sort: 24 },

  { grade: 'O-1', abbr: '2ndLt', name: 'Second Lieutenant', tier: 'officer', sort: 30 },
  { grade: 'O-2', abbr: '1stLt', name: 'First Lieutenant', tier: 'officer', sort: 31 },
  { grade: 'O-3', abbr: 'Capt', name: 'Captain', tier: 'officer', sort: 32 },
  { grade: 'O-4', abbr: 'Maj', name: 'Major', tier: 'officer', sort: 33 },
  { grade: 'O-5', abbr: 'LtCol', name: 'Lieutenant Colonel', tier: 'officer', sort: 34 },
  { grade: 'O-6', abbr: 'Col', name: 'Colonel', tier: 'officer', sort: 35 },
  { grade: 'O-7', abbr: 'BGen', name: 'Brigadier General', tier: 'officer', sort: 36 },
  { grade: 'O-8', abbr: 'MajGen', name: 'Major General', tier: 'officer', sort: 37 },
  { grade: 'O-9', abbr: 'LtGen', name: 'Lieutenant General', tier: 'officer', sort: 38 },
  { grade: 'O-10', abbr: 'Gen', name: 'General', tier: 'officer', sort: 39 },
];

/**
 * Billets. `default_role` is the permission this billet implies when someone is
 * assigned to it — a Fire Team Leader gets their team, a Section Head gets the
 * whole section and everything under it. It's a default, not a lock: the role
 * on the assignment is what's actually enforced, and it can be overridden.
 */
export const BILLETS = [
  // Tactical leadership
  { title: 'Fire Team Leader', category: 'Tactical', default_role: 'team_lead', echelon: 'fire_team' },
  { title: 'Squad Leader', category: 'Tactical', default_role: 'team_lead', echelon: 'squad' },
  { title: 'Platoon Sergeant', category: 'Tactical', default_role: 'unit_leader', echelon: 'platoon' },
  { title: 'Platoon Commander', category: 'Tactical', default_role: 'unit_leader', echelon: 'platoon' },
  { title: 'Company Gunnery Sergeant', category: 'Tactical', default_role: 'unit_leader', echelon: 'company' },
  { title: 'First Sergeant', category: 'Command', default_role: 'unit_leader', echelon: 'company' },
  { title: 'Sergeant Major', category: 'Command', default_role: 'unit_leader', echelon: 'command' },
  { title: 'Commanding Officer', category: 'Command', default_role: 'unit_leader', echelon: 'command' },
  { title: 'Executive Officer', category: 'Command', default_role: 'unit_leader', echelon: 'command' },
  { title: 'Officer in Charge', category: 'Command', default_role: 'unit_leader', echelon: 'section' },
  { title: 'Staff Non-Commissioned Officer in Charge', category: 'Command', default_role: 'unit_leader', echelon: 'section' },
  { title: 'Non-Commissioned Officer in Charge', category: 'Command', default_role: 'team_lead', echelon: 'section' },

  // Comptroller / financial management — the G-8 side
  { title: 'Comptroller', category: 'Comptroller', default_role: 'unit_leader', echelon: 'section' },
  { title: 'Deputy Comptroller', category: 'Comptroller', default_role: 'unit_leader', echelon: 'section' },
  { title: 'Budget Officer', category: 'Comptroller', default_role: 'unit_leader', echelon: 'section' },
  { title: 'Accounting Chief', category: 'Comptroller', default_role: 'team_lead', echelon: 'section' },
  { title: 'Budget Chief', category: 'Comptroller', default_role: 'team_lead', echelon: 'section' },
  { title: 'Fiscal Chief', category: 'Comptroller', default_role: 'team_lead', echelon: 'section' },
  { title: 'Financial Management Resource Analyst', category: 'Comptroller', default_role: 'member', echelon: 'section' },
  { title: 'Budget Analyst', category: 'Comptroller', default_role: 'member', echelon: 'section' },
  { title: 'Audit Readiness Analyst', category: 'Comptroller', default_role: 'member', echelon: 'section' },
  { title: 'Disbursing Chief', category: 'Comptroller', default_role: 'team_lead', echelon: 'section' },
  { title: 'Disbursing Clerk', category: 'Comptroller', default_role: 'member', echelon: 'section' },

  // Staff sections
  { title: 'Operations Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Training Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Administrative Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Supply Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Logistics Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Communications Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Intelligence Chief', category: 'Staff', default_role: 'team_lead', echelon: 'section' },
  { title: 'Career Planner', category: 'Staff', default_role: 'member', echelon: 'section' },
  { title: 'Command Language Program Manager', category: 'Staff', default_role: 'member', echelon: 'section' },

  // Individual contributor / collateral
  { title: 'Clerk', category: 'Staff', default_role: 'member', echelon: 'section' },
  { title: 'Analyst', category: 'Staff', default_role: 'member', echelon: 'section' },
  { title: 'Rifleman', category: 'Tactical', default_role: 'member', echelon: 'fire_team' },
  { title: 'Instructor', category: 'Training', default_role: 'team_lead', echelon: 'section' },
  { title: 'Class Leader', category: 'Training', default_role: 'team_lead', echelon: 'section' },
  { title: 'Student', category: 'Training', default_role: 'member', echelon: 'section' },
];

/** Echelons, largest to smallest. Used for indent depth and roster grouping. */
export const ECHELONS = [
  { key: 'command', label: 'Command', depth: 0 },
  { key: 'msc', label: 'Major Subordinate Command', depth: 1 },
  { key: 'regiment', label: 'Regiment / Group', depth: 2 },
  { key: 'battalion', label: 'Battalion / Squadron', depth: 3 },
  { key: 'company', label: 'Company / Battery', depth: 4 },
  { key: 'section', label: 'Section / Shop', depth: 4 },
  { key: 'platoon', label: 'Platoon', depth: 5 },
  { key: 'squad', label: 'Squad', depth: 6 },
  { key: 'fire_team', label: 'Fire Team', depth: 7 },
];

/**
 * MARFORRES down to the level a user actually sits at.
 *
 * `code` is the stable key — units get renamed and reflagged constantly, and
 * anything referencing a unit by name will break the first time that happens.
 * The G-8 section under the Command Element is expanded further because that's
 * where this build is being used from; every other MSC is stubbed at the level
 * where a unit admin would take over and fill in their own structure.
 */
export const UNIT_TREE = {
  code: 'MARFORRES',
  name: 'Marine Forces Reserve',
  short_name: 'MARFORRES',
  echelon: 'command',
  location: 'New Orleans, LA',
  children: [
    {
      code: 'MARFORRES-CE',
      name: 'Marine Forces Reserve Command Element',
      short_name: 'Command Element',
      echelon: 'msc',
      location: 'NAS JRB New Orleans, Belle Chasse, LA',
      children: [
        { code: 'CE-G1', name: 'G-1 Manpower', short_name: 'G-1', echelon: 'section' },
        { code: 'CE-G3', name: 'G-3 Operations and Training', short_name: 'G-3', echelon: 'section' },
        { code: 'CE-G4', name: 'G-4 Logistics', short_name: 'G-4', echelon: 'section' },
        { code: 'CE-G6', name: 'G-6 Communications', short_name: 'G-6', echelon: 'section' },
        {
          code: 'CE-G8',
          name: 'G-8 Comptroller',
          short_name: 'G-8',
          echelon: 'section',
          children: [
            { code: 'G8-BUDGET', name: 'Budget Branch', short_name: 'Budget', echelon: 'section' },
            { code: 'G8-ACCT', name: 'Accounting Branch', short_name: 'Accounting', echelon: 'section' },
            { code: 'G8-AUDIT', name: 'Audit Readiness Branch', short_name: 'Audit Readiness', echelon: 'section' },
            { code: 'G8-FMRAC', name: 'Fiscal Management Resource Analysis Cell', short_name: 'FMRAC', echelon: 'fire_team' },
          ],
        },
      ],
    },
    {
      code: 'FHG',
      name: 'Force Headquarters Group',
      short_name: 'FHG',
      echelon: 'msc',
      location: 'New Orleans, LA',
      children: [
        { code: 'FHG-HQ', name: 'Headquarters Company', short_name: 'HQ Co', echelon: 'company' },
        { code: 'FHG-ANGLICO', name: 'Air Naval Gunfire Liaison Companies', short_name: 'ANGLICO', echelon: 'battalion' },
        { code: 'FHG-INTEL', name: 'Intelligence Support Battalion', short_name: 'Intel Spt Bn', echelon: 'battalion' },
        { code: 'FHG-MIU', name: 'Marine Innovation Unit', short_name: 'MIU', echelon: 'battalion' },
      ],
    },
    {
      code: '4TH-MARDIV',
      name: '4th Marine Division',
      short_name: '4th MarDiv',
      echelon: 'msc',
      location: 'New Orleans, LA',
      children: [
        { code: '4MARDIV-HQ', name: 'Headquarters Battalion', short_name: 'HQ Bn', echelon: 'battalion' },
        { code: '23D-MAR', name: '23d Marine Regiment', short_name: '23d Marines', echelon: 'regiment' },
        { code: '24TH-MAR', name: '24th Marine Regiment', short_name: '24th Marines', echelon: 'regiment' },
        { code: '25TH-MAR', name: '25th Marine Regiment', short_name: '25th Marines', echelon: 'regiment' },
        { code: '14TH-MAR', name: '14th Marine Regiment', short_name: '14th Marines', echelon: 'regiment' },
        { code: '4TH-TANK', name: '4th Reconnaissance Battalion', short_name: '4th Recon Bn', echelon: 'battalion' },
      ],
    },
    {
      code: '4TH-MAW',
      name: '4th Marine Aircraft Wing',
      short_name: '4th MAW',
      echelon: 'msc',
      location: 'New Orleans, LA',
      children: [
        { code: '4MAW-HQ', name: 'Marine Wing Headquarters Squadron 4', short_name: 'MWHS-4', echelon: 'battalion' },
        { code: 'MAG-41', name: 'Marine Aircraft Group 41', short_name: 'MAG-41', echelon: 'regiment' },
        { code: 'MAG-49', name: 'Marine Aircraft Group 49', short_name: 'MAG-49', echelon: 'regiment' },
        { code: 'MACG-48', name: 'Marine Air Control Group 48', short_name: 'MACG-48', echelon: 'regiment' },
      ],
    },
    {
      code: '4TH-MLG',
      name: '4th Marine Logistics Group',
      short_name: '4th MLG',
      echelon: 'msc',
      location: 'New Orleans, LA',
      children: [
        { code: '4MLG-HQ', name: 'Headquarters and Service Battalion', short_name: 'H&S Bn', echelon: 'battalion' },
        { code: 'CLR-4', name: 'Combat Logistics Regiment 4', short_name: 'CLR-4', echelon: 'regiment' },
        { code: 'CLR-45', name: 'Combat Logistics Regiment 45', short_name: 'CLR-45', echelon: 'regiment' },
        { code: '4TH-DENTAL', name: '4th Dental Battalion', short_name: '4th Dental Bn', echelon: 'battalion' },
        { code: '4TH-MEDICAL', name: '4th Medical Battalion', short_name: '4th Medical Bn', echelon: 'battalion' },
      ],
    },
  ],
};

/** Flatten the tree into insertable rows with parent codes attached. */
export function flattenUnits(node = UNIT_TREE, parent = null, out = []) {
  const { children = [], ...unit } = node;
  out.push({ ...unit, parent_code: parent });
  for (const child of children) flattenUnits(child, unit.code, out);
  return out;
}
