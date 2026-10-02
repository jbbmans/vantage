import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2, pbkdf2Sync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const hmac = (key: string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Passwords are hashed with PBKDF2-HMAC-SHA256, the FIPS 140 approved choice; scrypt is not on that list. Hashes made
 * with scrypt by earlier versions still verify, and are replaced with PBKDF2 the next time the person signs in.
 */
let pbkdf2Iterations = 600_000;
let dummyHash: string | null = null;

/** Set from configuration at start-up. The test suite uses a low count so it is not dominated by hashing. */
export function configurePasswordHashing(iterations: number) {
  pbkdf2Iterations = iterations;
  dummyHash = null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, pbkdf2Iterations, 32, 'sha256');
  return `pbkdf2-sha256$${pbkdf2Iterations}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Verifies off the event loop: a hash takes about a tenth of a second, and nobody else should wait for it. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  try {
    const parts = String(stored).split('$');
    if (parts[0] === 'pbkdf2-sha256') {
      const [, iterations, saltB64, keyB64] = parts;
      const expected = Buffer.from(keyB64, 'base64');
      const actual = await new Promise<Buffer>((resolve, reject) => pbkdf2(password, Buffer.from(saltB64, 'base64'), Number(iterations), expected.length, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    if (parts[0] === 'scrypt') {
      const [, N, r, p, saltB64, keyB64] = parts;
      const expected = Buffer.from(keyB64, 'base64');
      const actual = await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p }, (e, k) => (e ? reject(e) : resolve(k))));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    return false;
  } catch {
    return false;
  }
}

/** True for a hash made the old way, or with fewer iterations than the instance now uses. */
export const needsRehash = (stored: string | null | undefined) => {
  const [scheme, iterations] = String(stored).split('$');
  return scheme !== 'pbkdf2-sha256' || Number(iterations) < pbkdf2Iterations;
};

/** Spends the time a real verification would, so an unknown username answers no faster than a wrong password. */
export const burnVerification = async (password: string) => { await verifyPassword(password || '', dummyHash ||= hashPassword(randomBytes(24).toString('base64url'))); };

function derivedKey(secret: string): Buffer {
  return createHash('sha256').update(`vantage-aes:${secret}`).digest();
}

export function encryptSecret(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

/** Opens a value sealed with `encryptSecret`, trying each secret in turn: the current one first, then any previous ones. */
export function decryptSecret(secrets: string | readonly string[], payload: string): string | null {
  for (const secret of typeof secrets === 'string' ? [secrets] : secrets) {
    try {
      const [v, ivB, encB, tagB] = String(payload).split('.');
      if (v !== 'v1') return null;
      const decipher = createDecipheriv('aes-256-gcm', derivedKey(secret), Buffer.from(ivB, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encB, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // wrong key or damaged value: try the next secret
    }
  }
  return null;
}
