import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** The time step a code belongs to, within `window` steps of now, or null when it matches none. */
export function totpCounter(secret: string, code: string, { window = 1, step = 30, nowMs = Date.now() }: { window?: number; step?: number; nowMs?: number } = {}): number | null {
  const supplied = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(supplied)) return null;
  const counter = Math.floor(nowMs / 1000 / step);
  for (let i = -window; i <= window; i += 1) {
    const expected = totpCode(secret, counter + i);
    if (expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return counter + i;
  }
  return null;
}

export function verifyTotp(secret: string, code: string, opts: { window?: number; step?: number; nowMs?: number } = {}): boolean {
  return totpCounter(secret, code, opts) !== null;
}

/**
 * A code signs somebody in once. Without this a code read over a shoulder, or out of a proxy log,
 * stays good for the whole ±1 step window (up to ninety seconds) after its owner used it.
 *
 * Kept in memory: Vantage runs as one process, and a restart inside the window is the only gap.
 */
const usedSteps = new Map<string, { counter: number; at: number }>();
export function claimTotpStep(userId: string, counter: number, nowMs = Date.now()): boolean {
  for (const [k, v] of usedSteps) if (nowMs - v.at > 5 * 60_000) usedSteps.delete(k);
  const previous = usedSteps.get(userId);
  if (previous && counter <= previous.counter) return false;
  usedSteps.set(userId, { counter, at: nowMs });
  return true;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Vantage'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
