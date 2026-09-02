import { isIP } from 'node:net';

const normalize = (value) => String(value || '').replace(/^::ffff:/i, '');

function bytes(address) {
  const normalized = normalize(address);
  if (isIP(normalized) === 4) return normalized.split('.').map(Number);
  if (isIP(normalized) !== 6) return null;
  const [left, right = ''] = normalized.toLowerCase().split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const expand = (part) => {
    if (part.includes('.')) return part.split('.').map(Number);
    const n = Number.parseInt(part || '0', 16);
    return [(n >> 8) & 0xff, n & 0xff];
  };
  const out = [...leftParts.flatMap(expand)];
  const rightBytes = rightParts.flatMap(expand);
  while (out.length + rightBytes.length < 16) out.push(0);
  return [...out, ...rightBytes];
}

function cidrMatch(address, range) {
  const [baseRaw, prefixRaw] = String(range).split('/');
  const base = normalize(baseRaw);
  const candidate = normalize(address);
  const family = isIP(base);
  if (!family || isIP(candidate) !== family) return false;
  if (prefixRaw === undefined) return candidate === base;
  const prefix = Number(prefixRaw);
  const limit = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > limit) return false;
  const a = bytes(candidate);
  const b = bytes(base);
  for (let bit = 0; bit < prefix; bit += 1) {
    const index = Math.floor(bit / 8);
    const mask = 1 << (7 - (bit % 8));
    if ((a[index] & mask) !== (b[index] & mask)) return false;
  }
  return true;
}

export function isTrustedProxyAddress(address, allowlist) {
  return Array.isArray(allowlist) && allowlist.some((range) => cidrMatch(address, range));
}

export function singleHeader(req, name) {
  const wanted = String(name).toLowerCase();
  const values = [];
  for (let index = 0; index < (req.rawHeaders || []).length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === wanted) values.push(req.rawHeaders[index + 1]);
  }
  return values.length === 1 ? String(values[0]) : null;
}
