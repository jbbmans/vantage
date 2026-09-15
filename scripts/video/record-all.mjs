/**
 * Records every walkthrough. `npm run video`.
 *
 * Boots the app the same way the browser suite does, drives it, and writes public/videos/<id>.webm
 * plus a matching .vtt. Pass ids to record a subset: `npm run video -- quick-log tour`.
 *
 * These are committed rather than generated on deploy, on purpose. An instance inside an enclave
 * has no route to a CDN and the deploy host has no browser to record with, so a video that is not
 * in the repository is a video nobody in the field can watch.
 */

import { record, startServer, waitForServer } from './recorder.mjs';
import { WALKTHROUGHS } from './walkthroughs.mjs';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = only.length ? WALKTHROUGHS.filter((w) => only.includes(w.id)) : WALKTHROUGHS;

if (!chosen.length) {
  console.error(`No walkthrough matched. Known: ${WALKTHROUGHS.map((w) => w.id).join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.VANTAGE_VIDEO_PORT || 8902);
const server = startServer(port);
const stop = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

try {
  await waitForServer(port);
  console.log(`Recording ${chosen.length} walkthrough${chosen.length === 1 ? '' : 's'} at ${port}\n`);

  const done = [];
  const failed = [];
  for (const walkthrough of chosen) {
    try {
      done.push(await record({ ...walkthrough, port }));
    } catch (err) {
      // One broken walkthrough should not cost the other five. Report it and carry on, so the run
      // ends with a clear list of what exists and what does not.
      failed.push({ id: walkthrough.id, message: err.message });
      console.error(`  ${walkthrough.id}: FAILED — ${err.message}`);
    }
  }

  const total = done.reduce((n, d) => n + d.kb, 0);
  console.log(`\n${done.length} recorded, ${(total / 1024).toFixed(1)} MB total`);
  if (failed.length) {
    console.log(`${failed.length} failed:`);
    for (const f of failed) console.log(`  - ${f.id}: ${f.message}`);
    process.exitCode = 1;
  }
} finally {
  stop();
}
