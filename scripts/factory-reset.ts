import { unlinkSync, existsSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';

if (process.env.VANTAGE_FACTORY_RESET !== '1' || process.argv[2] !== 'ERASE-EVERYTHING') {
  console.error('Refusing. Run: VANTAGE_FACTORY_RESET=1 node scripts/factory-reset.ts ERASE-EVERYTHING');
  process.exit(1);
}
const { databasePath, operations } = loadConfig();
for (const suffix of ['', '-wal', '-shm']) { const p = `${databasePath}${suffix}`; if (existsSync(p)) unlinkSync(p); }
// The lineage describes the database just erased; the next start begins a new one (ADR-0014).
if (operations.lineageFile && existsSync(operations.lineageFile)) unlinkSync(operations.lineageFile);
console.log(`Removed ${databasePath}. The next start performs first-run setup.`);
