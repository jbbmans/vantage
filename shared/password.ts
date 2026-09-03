export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 256;

const BLOCKED = new Set([
  '123456789012345', 'correct-horse-battery-staple', 'letmeinletmein', 'marinecorpsmarinecorps',
  'password123456', 'passwordpassword', 'qwertyuiopasdfgh', 'semperfi-semperfi', 'vantage-vantage', 'welcome-welcome',
]);
const PREDICTABLE_TERMS = [
  'administrator', 'admin', 'changeme', 'letmein', 'marinecorps', 'password', 'qwerty', 'semperfi', 'temporary',
  'usmc', 'vantage', 'welcome',
];
const SIMPLE_SUFFIX = /^(?:\d{1,8}|19\d{2}|20\d{2}|[!@#$%^&*._-]+)*$/;

export function passwordProblem(value: unknown): string | null {
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
  if (BLOCKED.has(normalized) || /^(.)\1{14,}$/u.test(normalized) || repeatedPhrase || predictableTerm) {
    return 'That password is too common or predictable. Choose a unique passphrase.';
  }
  return null;
}

export function passwordStrength(value: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!value) return { score: 0, label: 'Empty' };
  const length = [...value].length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  const words = value.trim().split(/[\s-_.]+/).filter((w) => w.length >= 3).length;
  let score = 0;
  if (length >= MIN_PASSWORD_LENGTH) score += 1;
  if (length >= 20 || words >= 4) score += 1;
  if (classes >= 3) score += 1;
  if (length >= 28 && classes >= 2) score += 1;
  if (passwordProblem(value)) score = Math.min(score, 1);
  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'];
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score] };
}
