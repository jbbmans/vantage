/** Local-password policy. CAC/PIV deployments should disable this authenticator. */
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 256;

const BLOCKED = new Set([
  '123456789012345',
  'correct-horse-battery-staple',
  'letmeinletmein',
  'marinecorpsmarinecorps',
  'password123456',
  'passwordpassword',
  'qwertyuiopasdfgh',
  'semperfi-semperfi',
  'vantage-vantage',
  'welcome-welcome',
]);

const PREDICTABLE_TERMS = [
  'administrator', 'admin', 'changeme', 'letmein', 'marinecorps', 'password',
  'qwerty', 'semperfi', 'temporary', 'usmc', 'vantage', 'welcome',
];

const SIMPLE_SUFFIX = /^(?:\d{1,8}|19\d{2}|20\d{2}|[!@#$%^&*._-]+)*$/;

export function passwordProblem(value) {
  if (value === undefined || value === null || value === '') return 'Required.';
  if (typeof value !== 'string') return 'Must be text.';
  const length = [...value.normalize('NFC')].length;
  if (length < MIN_PASSWORD_LENGTH) return `At least ${MIN_PASSWORD_LENGTH} characters.`;
  if (length > MAX_PASSWORD_LENGTH) return `At most ${MAX_PASSWORD_LENGTH} characters.`;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  const repeatedPhrase = /^(.{4,})\1(?:\d{0,8})$/u.test(compact);
  const predictableTerm = PREDICTABLE_TERMS.some((term) => {
    const index = compact.indexOf(term);
    if (index < 0) return false;
    const remainder = compact.slice(0, index) + compact.slice(index + term.length);
    return SIMPLE_SUFFIX.test(remainder);
  });
  if (
    BLOCKED.has(normalized)
    || /^(.)\1{14,}$/u.test(normalized)
    || repeatedPhrase
    || predictableTerm
  ) {
    return 'That password is too common or predictable. Choose a unique passphrase.';
  }
  return null;
}
