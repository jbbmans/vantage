/** A minimal ZIP writer (deflate, no encryption) so exports can bundle many files without another dependency. */
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer | string; modified?: Date }

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
const dosDate = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ''), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw) >>> 0;
    const when = entry.modified || new Date();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime(when), 10); local.writeUInt16LE(dosDate(when), 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(dosTime(when), 12); dir.writeUInt16LE(dosDate(when), 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt16LE(0, 30); dir.writeUInt16LE(0, 32); dir.writeUInt16LE(0, 34); dir.writeUInt16LE(0, 36); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

/** Names of the entries in a zip produced by buildZip (reads the central directory). Used by tests. */
export function listZip(buf: Buffer): string[] {
  const names: string[] = [];
  const endIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endIdx < 0) return names;
  let p = buf.readUInt32LE(endIdx + 16);
  const count = buf.readUInt16LE(endIdx + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const n = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const comment = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + n).toString('utf8'));
    p += 46 + n + extra + comment;
  }
  return names;
}

export interface ZipRead { name: string; data: Buffer }

/** Caps that keep a hostile archive from exhausting memory before we have looked at anything. */
export interface ZipLimits { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number }

export class ZipError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipError'; }
}

/**
 * Reads a ZIP container. Deliberately minimal: it walks the central directory, refuses anything
 * encrypted or oversized, and never writes to disk, so a malformed archive fails as a value
 * rather than as a side effect.
 */
export function readZip(buf: Buffer, limits: ZipLimits = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? 512;
  const maxEntryBytes = limits.maxEntryBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 128 * 1024 * 1024;
  const out = new Map<string, Buffer>();

  const endIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endIdx < 0 || endIdx + 22 > buf.length) throw new ZipError('This is not a readable workbook. The archive has no directory.');
  const count = buf.readUInt16LE(endIdx + 10);
  if (count > maxEntries) throw new ZipError(`This workbook holds ${count} parts, more than the ${maxEntries} we will open.`);

  let p = buf.readUInt32LE(endIdx + 16);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('This workbook is damaged. Its directory does not line up.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('This workbook is password protected. Remove the protection and upload it again.');
    if (uncompressed > maxEntryBytes) throw new ZipError(`One part of this workbook expands to ${uncompressed} bytes, past the limit we will read.`);
    total += uncompressed;
    if (total > maxTotalBytes) throw new ZipError('This workbook expands past the size limit we will read.');
    // A part naming a parent directory is never legitimate here and is the classic archive escape.
    if (name.includes('..') || name.startsWith('/')) throw new ZipError(`This workbook contains an unsafe part name: ${name}`);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError('This workbook is damaged. A part header is missing.');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(body));
    else if (method === 8) {
      let inflated: Buffer;
      try { inflated = inflateRawSync(body, { maxOutputLength: maxEntryBytes }); }
      catch { throw new ZipError(`This workbook could not be read. The part "${name}" did not decompress.`); }
      out.set(name, inflated);
    } else throw new ZipError(`This workbook uses a compression method we do not read (${method}).`);
  }
  return out;
}
