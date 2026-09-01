import { app, db } from '../server/index.js';

const port = Number(process.env.PORT || 8787);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Vantage browser test server listening on :${port}`);
});

const shutdown = () => {
  server.close(() => {
    try { db.close(); } catch {  }
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
