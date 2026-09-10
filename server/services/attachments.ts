import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const SIGNATURES: Record<string, (body: Buffer) => boolean> = {
  'application/pdf': (body) => body.length >= 12 && /^%PDF-1\.[0-7]/.test(body.subarray(0, 8).toString('ascii')) && body.subarray(Math.max(0, body.length - 2048)).includes(Buffer.from('%%EOF')),
  'image/png': (body) => body.length >= 45 && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && body.subarray(-8).equals(Buffer.from('49454e44ae426082', 'hex')),
  'image/jpeg': (body) => body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9,
};
const EXTENSIONS: Record<string, string[]> = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'text/plain': ['txt'], 'text/csv': ['csv'] };

export function cleanFilename(value: unknown): string {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch {}
  return basename(decoded).replace(/\p{Cc}/gu, '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function validUtf8(body: Buffer): boolean {
  if (body.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(body); return true; } catch { return false; }
}

export function inspectAttachment({ body, filename, contentType, allowedTypes, maxBytes }: { body: unknown; filename: unknown; contentType: unknown; allowedTypes: string[]; maxBytes: number }):
  { ok: true; filename: string; mime: string; size: number; sha256: string } | { ok: false; error: string } {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, error: 'Choose a non-empty file.' };
  if (body.length > maxBytes) return { ok: false, error: `Files are limited to ${Math.floor(maxBytes / 1048576)} MB.` };
  const name = cleanFilename(filename);
  if (!name) return { ok: false, error: 'The file needs a readable name.' };
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!allowedTypes.includes(mime)) return { ok: false, error: 'That file type is not allowed. Use PDF, PNG, JPEG, TXT, or CSV.' };
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!EXTENSIONS[mime]?.includes(ext)) return { ok: false, error: 'The filename extension does not match the declared file type.' };
  const sig = SIGNATURES[mime];
  if (sig && !sig(body)) return { ok: false, error: 'The file contents do not match the declared type.' };
  if ((mime === 'text/plain' || mime === 'text/csv') && !validUtf8(body)) return { ok: false, error: 'Text attachments must be valid UTF-8.' };
  return { ok: true, filename: name, mime, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

export function attachmentDisposition(filename: string): string {
  const safe = cleanFilename(filename) || 'attachment';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
