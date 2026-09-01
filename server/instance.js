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

export function operatorUsernames() {
  return parseNames(process.env.VANTAGE_OPERATOR);
}

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
