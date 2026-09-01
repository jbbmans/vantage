const PREFIX = 'vantage.draft.';
const LEGACY_KEYS = ['vantage.quicklog.draft', 'vantage.draft.member', 'vantage.draft.role'];

const segment = (value) => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

export function draftKey(userId, kind, recordId = '') {
  return `${PREFIX}${segment(userId)}.${segment(kind)}${recordId ? `.${segment(recordId)}` : ''}`;
}

export function clearSensitiveDrafts() {
  const stores = [];
  try { if (globalThis.sessionStorage) stores.push(globalThis.sessionStorage); } catch {}
  try { if (globalThis.localStorage) stores.push(globalThis.localStorage); } catch {}
  for (const storage of stores) {
    if (!storage) continue;
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
      for (const key of keys) {
        if (key && (key.startsWith(PREFIX) || LEGACY_KEYS.includes(key))) storage.removeItem(key);
      }
    } catch {}
  }
}
