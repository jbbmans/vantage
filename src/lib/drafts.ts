const PREFIX = 'vantage.draft.';
const seg = (v: unknown) => String(v ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
export const draftKey = (userId: unknown, kind: string, id = '') => `${PREFIX}${seg(userId)}.${seg(kind)}${id ? `.${seg(id)}` : ''}`;
export function readDraft<T>(key: string): T | null { try { const raw = sessionStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; } }
export function writeDraft(key: string, value: unknown) { try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
export function clearDrafts() {
  for (const storage of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
      for (const k of keys) storage.removeItem(k);
    } catch {}
  }
}
