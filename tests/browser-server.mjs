/**
 * Dedicated server entry point for browser suites.
 *
 * VANTAGE_TEST deliberately prevents server/index.js from opening a port so
 * API tests can import the Express app and choose an ephemeral listener. The
 * Playwright suites need the same synthetic-account/token behavior plus a real
 * localhost port, so they start it explicitly here.
 */

import { app, db } from '../server/index.js';

const port = Number(process.env.PORT || 8787);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Vantage browser test server listening on :${port}`);
});

const shutdown = () => {
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
