import { PERMISSIONS, has } from './permissions.ts';

/**
 * Three access levels, in the words people use for them.
 *
 * Underneath, Vantage keeps its per-team roles and permission bits (shared/permissions.ts), and a
 * unit can still build its own roles. The levels are how a person is described and managed day to
 * day: what they are in each team, and what they are across the organization.
 *
 *   Personal       their own record, work, goals and career; sees their team and its totals.
 *   Team leader    leads a team's work and people. Per-person workload and shared records, with
 *                  every open of a member's record logged. Assigns work, posts goals, counsels, and
 *                  brings people onto the team.
 *   Administrator  runs the organization, or a team outright: people, access levels, teams, sign-in
 *                  resets, audit, retention and settings. An organization administrator is one for
 *                  every team; a team administrator is one for that team only.
 */
export type AccessLevel = 'personal' | 'leader' | 'administrator';

export const ACCESS_LEVELS: Array<{ key: AccessLevel; label: string; summary: string; can: string[]; cannot: string[] }> = [
  {
    key: 'personal', label: 'Personal',
    summary: 'Their own record, work, goals and career.',
    can: ['Work and claim items in their teams', 'Keep a record of work, education, training, volunteering and more', 'Set goals and plan their career', 'See who is on their team and the team’s totals'],
    cannot: ['Open another person’s record', 'Assign or reassign someone else’s work', 'Change anyone’s access'],
  },
  {
    key: 'leader', label: 'Team leader',
    summary: 'Leads a team’s work and people.',
    can: ['Everything Personal can', 'See each member’s workload and shared records (every open is logged)', 'Assign and reassign work, post team goals, counsel', 'Correct shared records, export team data, read the team’s access log', 'Invite people to the team and remove them'],
    cannot: ['Make anyone a leader or an administrator', 'Reset sign-ins or change organization settings'],
  },
  {
    key: 'administrator', label: 'Administrator',
    summary: 'Runs the organization, or a team outright.',
    can: ['Everything a Team leader can', 'Set people’s access level and move them between teams', 'Manage the team’s roles and sub-teams', 'Reset sign-ins, suspend and restore accounts (organization administrators)'],
    cannot: ['Read anyone’s private entries or drafts', 'Edit the audit log', 'Make another team administrator (the team’s owner or an organization administrator does)'],
  },
];

export const ACCESS_LABEL: Record<AccessLevel, string> = { personal: 'Personal', leader: 'Team leader', administrator: 'Administrator' };
const RANK: Record<AccessLevel, number> = { personal: 0, leader: 1, administrator: 2 };
export const higherLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] >= RANK[b] ? a : b);

/** A person's level in one team, read from the permissions they hold there. */
export function levelFromBits(bits: number): AccessLevel {
  if (bits & PERMISSIONS.ADMINISTRATOR) return 'administrator';
  if (has(bits, PERMISSIONS.VIEW_MEMBER_DETAIL) || has(bits, PERMISSIONS.MANAGE_MEMBERS) || has(bits, PERMISSIONS.REASSIGN_WORK)) return 'leader';
  return 'personal';
}

/** The system role each level is granted through. Personal is the team's default role. */
export const LEVEL_ROLE_KEY: Record<AccessLevel, string | null> = { personal: null, leader: 'team-leader', administrator: 'team-administrator' };
export const levelRank = (level: AccessLevel) => RANK[level];
