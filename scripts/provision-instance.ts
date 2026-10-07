import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';
import { createContext } from '../server/app.ts';
import { provisionUnitInstance, provisioningActor } from '../server/services/provisioning.ts';

/**
 * Provision a Unit Instance from a manifest, as a named Vantage Administrator (ADR-0007, docs/deploy-mcen.md).
 *
 *   VANTAGE_PROVISION=1 node scripts/provision-instance.ts --by <administrator> <manifest.json> [--dry-run]
 *
 * The manifest: {"name": "MARFORRES G-1", "code": "G1", "short_name": "G-1", "manager": "<username or DoD ID>"}.
 * Running it again changes nothing that is already true; --dry-run says what it would do and writes nothing.
 */
if (process.env.VANTAGE_PROVISION !== '1') { console.error('Refusing: set VANTAGE_PROVISION=1 for this one invocation.'); process.exit(1); }
const args = process.argv.slice(2);
const by = args[args.indexOf('--by') + 1];
const dryRun = args.includes('--dry-run');
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--by');
if (!args.includes('--by') || !by || !file) {
  console.error('Usage: VANTAGE_PROVISION=1 node scripts/provision-instance.ts --by <administrator> <manifest.json> [--dry-run]');
  process.exit(1);
}

const ctx = createContext(loadConfig());
try {
  const actor = provisioningActor(ctx, by);
  const result = provisionUnitInstance(ctx, actor, JSON.parse(readFileSync(file, 'utf8')), { dryRun });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  ctx.db.close();
}
