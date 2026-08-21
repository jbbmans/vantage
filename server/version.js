/**
 * Vantage — the one version number.
 *
 * v3.2 shipped saying "3.2.0" in package.json, "3.0.0" from /api/health, and
 * "v3.0" in the Settings footer, which turns "which build is this deployment
 * running?" into archaeology. package.json is the source; everything else —
 * health endpoint, Settings, logs, SOP — reads from here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let version = '0.0.0';
try {
  version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version || version;
} catch { /* keep the fallback; a broken package.json should not stop boot */ }

export const VERSION = version;
export const PRODUCT = `Vantage v${version}`;
