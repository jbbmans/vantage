/**
 * Reads a saved email (.eml, RFC 5322 / MIME) into the pieces Vantage keeps.
 *
 * Only .eml is read. Outlook's .msg is a compound OLE document whose safe parsing needs a real
 * implementation of that container format; guessing at it would mean reading structured binary from
 * an untrusted file, which is exactly the shape of bug worth avoiding. A person can save any message
 * as .eml from Outlook, so the capability is not lost, only the risk.
 *
 * Attachments are read as metadata: name, type, size and a hash. Their bytes are not decoded here,
 * because nothing in the product needs them and decoding them would mean holding untrusted binary
 * in memory for no purpose.
 */
import { createHash } from 'node:crypto';

export class EmlError extends Error {
  constructor(message: string) { super(message); this.name = 'EmlError'; }
}

export interface EmlAddress { name: string | null; email: string }

export interface EmlAttachment { filename: string; contentType: string; sizeBytes: number; sha256: string }

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: EmlAddress | null;
  to: EmlAddress[];
  cc: EmlAddress[];
  date: string | null;
  text: string;
  html: string;
  attachments: EmlAttachment[];
}

/** Unfolds a header block: a continuation line starts with whitespace and belongs to the line above. */
function headerLines(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out.filter(Boolean);
}

function parseHeaders(block: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of headerLines(block)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  }
  return map;
}

/** RFC 2047 encoded words, so a subject in another language is not shown as gibberish. */
function decodeWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'binary');
      return decodeBuffer(bytes, charset);
    } catch { return whole; }
  }).replace(/\?=\s+=\?/g, '');
}

function decodeBuffer(bytes: Buffer, charset: string | undefined): string {
  const label = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(label === 'us-ascii' ? 'utf-8' : label, { fatal: false }).decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

function decodeBody(raw: string, encoding: string | undefined, charset: string | undefined): string {
  const kind = (encoding || '7bit').trim().toLowerCase();
  if (kind === 'base64') return decodeBuffer(Buffer.from(raw.replace(/\s+/g, ''), 'base64'), charset);
  if (kind === 'quoted-printable') {
    const unfolded = raw.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i += 1) {
      if (unfolded[i] === '=' && /^[0-9a-fA-F]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(unfolded.charCodeAt(i) & 0xff);
    }
    return decodeBuffer(Buffer.from(bytes), charset);
  }
  return decodeBuffer(Buffer.from(raw, 'binary'), charset);
}

export function parseAddresses(value: string | undefined): EmlAddress[] {
  if (!value) return [];
  const entries: string[] = [];
  // Split on commas that are not inside quotes or angle brackets.
  let depth = 0; let quoted = false; let current = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth += 1;
    else if (!quoted && ch === '>') depth -= 1;
    if (ch === ',' && !quoted && depth <= 0) { entries.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) entries.push(current);
  return entries.map((entry) => {
    const angled = /<([^>]+)>/.exec(entry);
    const email = (angled ? angled[1] : entry).trim().replace(/^["']|["']$/g, '');
    const name = angled ? decodeWords(entry.slice(0, angled.index).trim()).replace(/^["']|["']$/g, '') : '';
    return { name: name || null, email: email.toLowerCase() };
  }).filter((a) => a.email.includes('@'));
}

const paramOf = (header: string | undefined, key: string): string | undefined => {
  if (!header) return undefined;
  const m = new RegExp(`${key}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, 'i').exec(header);
  return m ? (m[2] ?? m[3]) : undefined;
};

interface Part { headers: Map<string, string[]>; body: string }

function splitParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const chunks = body.split(new RegExp(`(?:\\r?\\n)?${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?(?:\\r?\\n|$)`));
  return chunks.slice(1, -1).filter((c) => c !== undefined && c !== '--');
}

function walk(part: Part, out: { text: string[]; html: string[]; attachments: EmlAttachment[] }, depth = 0) {
  if (depth > 12) return;
  const contentType = part.headers.get('content-type')?.[0] || 'text/plain';
  const disposition = part.headers.get('content-disposition')?.[0] || '';
  const encoding = part.headers.get('content-transfer-encoding')?.[0];
  const mime = contentType.split(';')[0].trim().toLowerCase();

  if (mime.startsWith('multipart/')) {
    const boundary = paramOf(contentType, 'boundary');
    if (!boundary) return;
    for (const chunk of splitParts(part.body, boundary)) {
      const split = chunk.indexOf('\r\n\r\n') !== -1 ? chunk.indexOf('\r\n\r\n') : chunk.indexOf('\n\n');
      const headerBlock = split === -1 ? '' : chunk.slice(0, split);
      const body = split === -1 ? chunk : chunk.slice(split).replace(/^\r?\n\r?\n/, '');
      walk({ headers: parseHeaders(headerBlock), body }, out, depth + 1);
    }
    return;
  }

  const filename = paramOf(disposition, 'filename') || paramOf(contentType, 'name');
  if (/attachment/i.test(disposition) || (filename && !mime.startsWith('text/'))) {
    // Metadata only. The bytes are hashed to identify the file, then discarded.
    const raw = Buffer.from(part.body.replace(/\s+/g, ''), (encoding || '').toLowerCase() === 'base64' ? 'base64' : 'binary');
    out.attachments.push({
      filename: decodeWords(filename || 'attachment').slice(0, 255),
      contentType: mime.slice(0, 120),
      sizeBytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
    return;
  }

  const charset = paramOf(contentType, 'charset');
  const decoded = decodeBody(part.body, encoding, charset);
  if (mime === 'text/html') out.html.push(decoded);
  else if (mime.startsWith('text/')) out.text.push(decoded);
}

export function parseEml(buffer: Buffer, limits: { maxBytes?: number } = {}): ParsedEmail {
  const maxBytes = limits.maxBytes ?? 20 * 1024 * 1024;
  if (buffer.length > maxBytes) throw new EmlError(`That message is ${Math.round(buffer.length / 1_048_576)} MB, past the limit Vantage reads.`);
  const source = buffer.toString('binary');
  const breakIndex = source.indexOf('\r\n\r\n') !== -1 ? source.indexOf('\r\n\r\n') : source.indexOf('\n\n');
  if (breakIndex === -1) throw new EmlError('This does not look like a saved email. It has no header block.');

  const headers = parseHeaders(source.slice(0, breakIndex));
  if (!headers.has('from') && !headers.has('subject') && !headers.has('date')) {
    throw new EmlError('This does not look like a saved email. Save the message as .eml and try again.');
  }

  const collected = { text: [] as string[], html: [] as string[], attachments: [] as EmlAttachment[] };
  walk({ headers, body: source.slice(breakIndex).replace(/^\r?\n\r?\n/, '') }, collected);

  const dateHeader = headers.get('date')?.[0];
  const parsedDate = dateHeader ? new Date(dateHeader) : null;

  return {
    messageId: (headers.get('message-id')?.[0] || '').replace(/^<|>$/g, '') || null,
    inReplyTo: (headers.get('in-reply-to')?.[0] || '').replace(/^<|>$/g, '') || null,
    references: (headers.get('references')?.[0] || '').split(/\s+/).map((r) => r.replace(/^<|>$/g, '')).filter(Boolean),
    subject: decodeWords(headers.get('subject')?.[0] || '(no subject)').slice(0, 500),
    from: parseAddresses(headers.get('from')?.[0])[0] || null,
    to: parseAddresses(headers.get('to')?.[0]),
    cc: parseAddresses(headers.get('cc')?.[0]),
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    text: collected.text.join('\n\n').trim(),
    html: collected.html.join('\n').trim(),
    attachments: collected.attachments.slice(0, 50),
  };
}

/** Is this an Outlook .msg? Named specifically so the message can say what to do instead. */
export function looksLikeOutlookMsg(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}
