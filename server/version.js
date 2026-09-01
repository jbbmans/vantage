import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let version = '0.0.0';
try {
  version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version || version;
} catch {
  version = '0.0.0';
}

export const VERSION = version;
export const PRODUCT = `Vantage v${version}`;
