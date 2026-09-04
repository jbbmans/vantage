/** Offline outbox: queued activity saves persisted in IndexedDB, replayed when the network returns. */
const DB_NAME = 'vantage-outbox';
const STORE = 'activities';

export interface OutboxItem { id: string; userId: string; createdAt: string; payload: Record<string, unknown>; attempts: number; lastError?: string }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  }));
}

export const outbox = {
  async add(payload: Record<string, unknown>, userId: string): Promise<OutboxItem> {
    const item: OutboxItem = { id: crypto.randomUUID(), userId, createdAt: new Date().toISOString(), payload, attempts: 0 };
    await tx('readwrite', (s) => s.put(item));
    notify();
    return item;
  },
  /** Items queued by one account. Entries from other accounts on a shared device stay put until that account signs in. */
  async list(userId: string): Promise<OutboxItem[]> {
    try { return ((await tx('readonly', (s) => s.getAll())) as OutboxItem[]).filter((i) => i.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); } catch { return []; }
  },
  async remove(id: string) { await tx('readwrite', (s) => s.delete(id)); notify(); },
  async update(item: OutboxItem) { await tx('readwrite', (s) => s.put(item)); notify(); },
  async count(userId: string) { return (await this.list(userId)).length; },
};

const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }
export function onOutboxChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

let flushing = false;
export async function flushOutbox(send: (payload: Record<string, unknown>) => Promise<unknown>, userId: string): Promise<{ sent: number; failed: number }> {
  if (flushing || !userId) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0; let failed = 0;
  try {
    for (const item of await outbox.list(userId)) {
      try { await send(item.payload); await outbox.remove(item.id); sent += 1; }
      catch (error) {
        const e = error as { status?: number; message?: string };
        if (e.status === 0 || e.status === 401) { failed += 1; break; }
        if (e.status === 409) { await outbox.remove(item.id); sent += 1; continue; }
        item.attempts += 1; item.lastError = e.message; await outbox.update(item); failed += 1;
      }
    }
  } finally { flushing = false; notify(); }
  return { sent, failed };
}
