/**
 * Vantage — the Instance Operator.
 *
 * Finding 4 split v3.3's single ADMINISTRATOR concept in two, because it was
 * doing two unrelated jobs. One of them — full authority inside one unit — is
 * the Unit Owner, and it lives on `units.owner_user_id` where a role edit
 * cannot revoke it. The other is this: the person running the container.
 *
 * Three properties matter, and each is a deliberate constraint:
 *
 *   Designated by environment, not by a role. `VANTAGE_OPERATOR_ID` holds
 *   immutable account UUIDs and takes precedence; `VANTAGE_OPERATOR` is a
 *   canonical-username compatibility fallback. The environment can be changed
 *   only by whoever can restart the process, which is the correct authority
 *   for "who runs this box". Account creation is operator-gated and usernames
 *   are unique under the same comparison used here.
 *
 *   Cannot silently read unit records. The operator has to be able to recover
 *   a lost Unit Owner and take backups, which means they can reach the disk.
 *   Pretending otherwise would be theatre. What Vantage can honestly promise
 *   is that a read THROUGH THE APPLICATION is never silent: it writes a
 *   high-visibility instance-audit row that the affected Unit Owner sees in
 *   their own audit view. The operator's power is not reduced; it is made
 *   loud.
 *
 *   Holds no permission bits. `permissionsIn` returns zero for an operator in
 *   a unit they do not belong to, exactly as it does for a stranger. Operator
 *   status gates a small, explicit set of instance routes and nothing else, so
 *   there is no path by which it leaks into a record query.
 *
 * Personal scope (finding 6) is not readable by the operator through any route
 * at all — not loudly, not at all. See tests/tenancy.test.mjs.
 */

import { normalizeUsername } from './identity.js';

const parseNames = (raw) =>
  String(raw || '')
    .split(/[,\s]+/)
    .map(normalizeUsername)
    .filter(Boolean);

const parseIds = (raw) =>
  String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Usernames designated as Instance Operators. Empty is a valid answer. */
export function operatorUsernames() {
  return parseNames(process.env.VANTAGE_OPERATOR);
}

/** Preferred binding: immutable account UUIDs, not mutable login names. */
export function operatorUserIds() {
  return parseIds(process.env.VANTAGE_OPERATOR_ID);
}

export function isInstanceOperator(user) {
  if (!user) return false;
  const ids = operatorUserIds();
  if (ids.length) return Boolean(user.id && ids.includes(String(user.id)));
  if (!user.username) return false;
  const names = operatorUsernames();
  if (!names.length) return false;
  return names.includes(normalizeUsername(user.username));
}

/**
 * Bootstrap allowance. `users.is_admin` is retired to instance-operator
 * bootstrap only (finding 4): on a brand-new install, before anyone has had a
 * chance to set an operator binding, the first account created by /api/setup
 * can still perform recovery. The moment either operator variable is set, the
 * legacy flag stops meaning anything.
 */
export function isBootstrapOperator(db, user) {
  if (!user) return false;
  if (operatorUserIds().length || operatorUsernames().length) return isInstanceOperator(user);
  if (!user.is_admin) return false;
  const others = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> ?').get(user.id).n;
  return others === 0;
}

export const operatorGate = (db) => (req, res, next) => {
  if (isInstanceOperator(req.user) || isBootstrapOperator(db, req.user)) return next();
  return res.status(403).json({
    error: 'That is an instance operator action. Operators are bound by deployment configuration.',
    code: 'not_operator',
  });
};
