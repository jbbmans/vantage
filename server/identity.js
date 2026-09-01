export function normalizeUsername(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}
