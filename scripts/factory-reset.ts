// Destroys every record in the configured database. Requires VANTAGE_FACTORY_RESET=1 and a typed confirmation argument.
import { unlinkSync, existsSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';

if (process.env.VANTAGE_FACTORY_RESET !== '1' || process.argv[2] !== 'ERASE-EVERYTHING') {
  console.error('Refusing. Run: VANTAGE_FACTORY_RESET=1 node scripts/factory-reset.ts ERASE-EVERYTHING');
  process.exit(1);
}
const { databasePath } = loadConfig();
for (const suffix of ['', '-wal', '-shm']) { const p = `${databasePath}${suffix}`; if (existsSync(p)) unlinkSync(p); }
console.log(`Removed ${databasePath}. The next start performs first-run setup.`);
