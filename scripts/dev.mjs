import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const children = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { cwd: root, env: { ...process.env, PORT: process.env.PORT || '8787' }, stdio: 'inherit' }),
  spawn(process.execPath, [vite], { cwd: root, env: process.env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => stop());
for (const c of children) c.on('exit', (code) => { if (!stopping) stop(code || 0); });
