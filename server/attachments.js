import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const SIGNATURES = {
  'application/pdf': (body) => body.subarray(0, 5).toString('ascii') === '%PDF-',
  'image/png': (body) => body.length >= 8 && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/jpeg': (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
};

export function cleanFilename(value) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch {}
  const clean = basename(decoded)
    .replace(/\p{Cc}/gu, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 120);
}

function validUtf8Text(body) {
  if (body.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

export function inspectAttachment({ body, filename, contentType, allowedTypes, maxBytes }) {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, error: 'Choose a non-empty file.' };
  if (body.length > maxBytes) return { ok: false, error: `Files are limited to ${Math.floor(maxBytes / 1048576)} MB.` };
  const name = cleanFilename(filename);
  if (!name) return { ok: false, error: 'The file needs a readable name.' };
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!allowedTypes.includes(mime)) return { ok: false, error: 'That file type is not allowed.' };
  const signature = SIGNATURES[mime];
  if (signature && !signature(body)) return { ok: false, error: 'The file contents do not match the declared type.' };
  if ((mime === 'text/plain' || mime === 'text/csv') && !validUtf8Text(body)) {
    return { ok: false, error: 'Text attachments must be valid UTF-8 and may not contain binary data.' };
  }
  return {
    ok: true,
    filename: name,
    mime,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

export function attachmentDisposition(filename) {
  const safe = cleanFilename(filename) || 'attachment';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
