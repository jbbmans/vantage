import { mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '../server/app.ts';
import { ACCOUNTS, stagingOrigin, stagingConfig, seedVideoStaging, createVideoStagingApp } from './video-staging.ts';

stagingOrigin(process.env);
process.umask(0o077);
const directory = mkdtempSync('/tmp/vantage-video-staging-');
chmodSync(directory, 0o700);
const ctx = createContext(stagingConfig(process.env, join(directory, 'vantage.db')));
seedVideoStaging(ctx, process.env);
// Deliberately do not start external feed/digest/background schedulers.
const server = createVideoStagingApp(ctx).listen(ctx.config.port, '0.0.0.0', () => {
  const enabled = ACCOUNTS.filter(a => Boolean(process.env['VANTAGE_STAGE_' + a.key + '_PASSWORD'])).length;
  console.log('Synthetic staging ready; ' + enabled + ' of 3 synthetic accounts enabled. Credentials are never logged.');
});
function stop() {
  server.close(() => { ctx.db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
