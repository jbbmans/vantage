import { randomUUID, randomBytes } from 'node:crypto';
export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const slug = (s: string, max = 40) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max);
