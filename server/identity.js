/** Canonical local-login identifier. Usernames are restricted to ASCII by validation. */
export function normalizeUsername(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}
