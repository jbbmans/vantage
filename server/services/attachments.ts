import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { ATTACHMENT_EXTENSIONS as EXTENSIONS, ATTACHMENT_LIMITS, stripHidden } from '../../shared/attachments.ts';

/**
 * What a file must be to be kept as evidence (ADR-0025): one of the allowed types, named for what it is, within the
 * size limit, and its content what its type says. The type a browser sends is a claim; the content is the proof.
 */
const SIGNATURES: Record<string, (body: Buffer) => boolean> = {
  // PDF 1.0 to 1.7, and 2.0 (ISO 32000-2), which current certificate and transcript generators write.
  'application/pdf': (body) => body.length >= 12 && /^%PDF-(1\.[0-7]|2\.0)/.test(body.subarray(0, 8).toString('latin1')) && body.subarray(Math.max(0, body.length - 2048)).includes(Buffer.from('%%EOF')),
  'image/png': (body) => body.length >= 45 && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && body.subarray(-8).equals(Buffer.from('49454e44ae426082', 'hex')),
  'image/jpeg': (body) => body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9,
};
const BY_EXTENSION: Record<string, string> = Object.fromEntries(Object.entries(EXTENSIONS).flatMap(([mime, exts]) => exts.map((ext) => [ext, mime])));

/**
 * What a browser sends when it cannot say what a file is: nothing, or the generic type; and, for a CSV on a machine with
 * a spreadsheet program installed, that program's own type instead of the file's. None of these describes the content,
 * so the type is read from the filename and then proven against the content exactly as a stated one is. A type that is
 * stated and allowed must still agree with the filename.
 */
const UNSTATED = new Set(['', 'application/octet-stream']);
const CSV_ALIASES = new Set(['application/vnd.ms-excel', 'application/csv', 'text/x-csv', 'text/comma-separated-values']);

/** A long name keeps its extension: the stem is shortened, never the part the type is checked against. Whole characters only. */
function clipName(name: string, max: number = ATTACHMENT_LIMITS.filename): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  let kept = '';
  for (const ch of stem) { if (kept.length + ch.length + ext.length > max) break; kept += ch; }
  return `${kept.trimEnd()}${ext}`;
}

/**
 * A filename as it is kept and shown: its last path segment, without control characters, half a surrogate pair, or the
 * invisible and direction-reversing characters that make a name read as another; path and shell punctuation becomes a
 * hyphen.
 */
export function cleanFilename(value: unknown): string {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch {}
  const name = stripHidden(basename(decoded).replace(/\p{Cs}/gu, '')).replace(/\p{Cc}/gu, '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return clipName(name);
}

function validUtf8(body: Buffer): string | null {
  if (body.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return null; }
}

/** Plain text holds no control characters beyond a tab, a line break and a page break. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000B\u000E-\u001F\u007F]/;

export function inspectAttachment({ body, filename, contentType, allowedTypes, maxBytes }: { body: unknown; filename: unknown; contentType: unknown; allowedTypes: string[]; maxBytes: number }):
  { ok: true; filename: string; mime: string; size: number; sha256: string } | { ok: false; error: string } {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, error: 'Choose a non-empty file.' };
  if (body.length > maxBytes) return { ok: false, error: `Files are limited to ${Math.floor(maxBytes / 1048576)} MB.` };
  const name = cleanFilename(filename);
  if (!name) return { ok: false, error: 'The file needs a readable name.' };
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  const mime = UNSTATED.has(declared) || (ext === 'csv' && CSV_ALIASES.has(declared)) ? BY_EXTENSION[ext] ?? declared : declared;
  if (!allowedTypes.includes(mime)) return { ok: false, error: 'That file type is not allowed. Use PDF, PNG, JPEG, TXT, or CSV.' };
  if (!EXTENSIONS[mime]?.includes(ext)) return { ok: false, error: 'The filename extension does not match the declared file type.' };
  const sig = SIGNATURES[mime];
  if (sig && !sig(body)) return { ok: false, error: 'The file contents do not match the declared type.' };
  if (mime === 'text/plain' || mime === 'text/csv') {
    const text = validUtf8(body);
    if (text === null) return { ok: false, error: 'Text attachments must be valid UTF-8.' };
    if (CONTROL.test(text)) return { ok: false, error: 'Text attachments must be plain text. This file holds control characters.' };
  }
  return { ok: true, filename: name, mime, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

export function attachmentDisposition(filename: string): string {
  const safe = cleanFilename(filename) || 'attachment';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 8187 leaves fewer characters bare than encodeURIComponent does: ' ( ) and * are encoded too.
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The type a download states: text was checked as UTF-8 when it was added, so it says so. */
export const attachmentContentType = (mime: string): string => (mime === 'text/plain' || mime === 'text/csv' ? `${mime}; charset=utf-8` : mime);
