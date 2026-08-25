/**
 * Vantage — Marine Corps reference data.
 *
 * Ranks, billets, and the initial MARFORRES unit live here as seed data rather than
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
 * The single unit that exists on a fresh installation.
 *
 * `code` is the stable key. No subordinate organization is assumed or shipped:
 * the Unit Leader builds the structure that actually exists at their command.
 */
export const UNIT_TREE = {
  code: 'MFR',
  name: 'Marine Forces Reserve',
  short_name: 'MARFORRES',
  echelon: 'command',
  location: 'New Orleans, LA',
  children: [],
};

/** Flatten the tree into insertable rows with parent codes attached. */
export function flattenUnits(node = UNIT_TREE, parent = null, out = []) {
  const { children = [], ...unit } = node;
  out.push({ ...unit, parent_code: parent });
  for (const child of children) flattenUnits(child, unit.code, out);
  return out;
}
