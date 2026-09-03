const WINDOW_MS = 15 * 60 * 1000;

interface Entry { count: number; start: number }
class Window {
  private map = new Map<string, Entry>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs = WINDOW_MS) { this.max = max; this.windowMs = windowMs; }
  peek(key: string, nowMs = Date.now()): number {
    const e = this.map.get(key);
    if (!e || nowMs - e.start > this.windowMs) return 0;
    return e.count;
  }
  bump(key: string, nowMs = Date.now()): Entry {
    const e = this.map.get(key) || { count: 0, start: nowMs };
    if (nowMs - e.start > this.windowMs) { e.count = 0; e.start = nowMs; }
    e.count += 1;
    this.map.set(key, e);
    return e;
  }
  retryAfter(key: string, nowMs = Date.now()): number {
    const e = this.map.get(key);
    if (!e) return 1;
    return Math.max(1, Math.ceil((e.start + this.windowMs - nowMs) / 1000));
  }
  limited(key: string): { retryAfter: number } | null {
    return this.peek(key) >= this.max ? { retryAfter: this.retryAfter(key) } : null;
  }
  clear(key?: string) { if (key) this.map.delete(key); else this.map.clear(); }
  prune(nowMs = Date.now()) { for (const [k, e] of this.map) if (nowMs - e.start > this.windowMs) this.map.delete(k); }
}

export const limiters = {
  loginIp: new Window(15),
  loginUser: new Window(10),
  registerIp: new Window(20),
  resetIp: new Window(10),
  mfaToken: new Window(6),
  mutations: new Window(300),
  aiGlobal: new Window(100, 60_000),
  aiUser: new Window(12, 60_000),
};

export function configureLimits({ mutations, registrations }: { mutations: number; registrations: number }) {
  limiters.mutations = new Window(mutations);
  limiters.registerIp = new Window(registrations);
}

export function configureAiLimits({ global, perUser }: { global: number; perUser: number }) {
  limiters.aiGlobal = new Window(global, 60_000);
  limiters.aiUser = new Window(perUser, 60_000);
}

export function pruneLimiters() { for (const w of Object.values(limiters)) w.prune(); }
export function resetLimiters() { for (const w of Object.values(limiters)) w.clear(); }
