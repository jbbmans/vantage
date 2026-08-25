import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: process.env.VANTAGE_API_PORT || '8787' },
    stdio: 'inherit',
  }),
  spawn(process.execPath, [vite, ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }),
];

let stopping = false;

function stop(signal = 'SIGTERM', exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
  setTimeout(() => process.exit(exitCode), 5_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('Development process failed to start:', error);
    stop('SIGTERM', 1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Development process exited (${signal || code || 0}).`);
      stop('SIGTERM', code || 1);
    }
  });
}
