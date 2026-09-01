import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const SIGNATURES = {
  'application/pdf': (body) => body.length >= 12
    && /^%PDF-1\.[0-7]/.test(body.subarray(0, 8).toString('ascii'))
    && body.subarray(Math.max(0, body.length - 2048)).includes(Buffer.from('%%EOF')),
  'image/png': (body) => body.length >= 45
    && body.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    && body.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')),
  'image/jpeg': (body) => body.length >= 4
    && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
    && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9,
};

const EXTENSIONS = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
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

function extensionFor(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function inspectAttachment({ body, filename, contentType, allowedTypes, maxBytes }) {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, error: 'Choose a non-empty file.' };
  if (body.length > maxBytes) return { ok: false, error: `Files are limited to ${Math.floor(maxBytes / 1048576)} MB.` };
  const name = cleanFilename(filename);
  if (!name) return { ok: false, error: 'The file needs a readable name.' };
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!allowedTypes.includes(mime)) return { ok: false, error: 'That file type is not allowed.' };
  if (!EXTENSIONS[mime]?.includes(extensionFor(name))) {
    return { ok: false, error: 'The filename extension does not match the declared file type.' };
  }
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
