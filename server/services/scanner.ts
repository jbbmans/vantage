import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { HttpError } from '../lib/errors.ts';

export type Verdict = 'clean' | 'rejected' | 'skipped';

export interface ScanResult {
  verdict: Verdict;
  detail: string;
  scanner: string;
}

export interface Scanner {
  readonly name: string;
  scan(buffer: Buffer, filename: string): Promise<ScanResult>;
}

export class NoScanner implements Scanner {
  readonly name = 'none';
  async scan(): Promise<ScanResult> {
    return { verdict: 'skipped', detail: 'No malware scanner is configured on this instance, so this file was not scanned.', scanner: this.name };
  }
}

export class ClamdScanner implements Scanner {
  readonly name = 'clamdscan';
  private readonly command: string;
  private readonly timeoutMs: number;
  constructor(command: string, timeoutMs = 30_000) { this.command = command; this.timeoutMs = timeoutMs; }

  scan(buffer: Buffer, filename: string): Promise<ScanResult> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ['--stream', '--no-summary', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (result: ScanResult) => { if (!settled) { settled = true; resolve(result); } };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ verdict: 'skipped', detail: `The scanner did not answer within ${Math.round(this.timeoutMs / 1000)} seconds, so this file was not scanned.`, scanner: this.name });
      }, this.timeoutMs);

      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', (e) => { clearTimeout(timer); finish({ verdict: 'skipped', detail: `The scanner could not be run: ${e.message}`, scanner: this.name }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        // clamdscan: 0 clean, 1 infected, 2 error.
        if (code === 0) finish({ verdict: 'clean', detail: `Scanned clean by ${this.name}.`, scanner: this.name });
        else if (code === 1) finish({ verdict: 'rejected', detail: `${filename} was rejected by the malware scanner: ${(out.trim() || 'signature match').slice(0, 300)}`, scanner: this.name });
        else finish({ verdict: 'skipped', detail: `The scanner reported an error and could not give a verdict: ${(err.trim() || out.trim() || `exit ${code}`).slice(0, 300)}`, scanner: this.name });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(buffer);
    });
  }
}

/**
 * Talks to clamd directly over its socket (INSTREAM), so the container needs no clamdscan binary: a sidecar or a
 * host daemon at VANTAGE_CLAMD (tcp://host:3310, or a unix socket path) is enough.
 */
export class ClamdSocketScanner implements Scanner {
  readonly name = 'clamd';
  private readonly target: { host: string; port: number } | { path: string };
  private readonly timeoutMs: number;
  constructor(address: string, timeoutMs = 30_000) {
    if (address.startsWith('tcp://')) { const u = new URL(address); this.target = { host: u.hostname, port: Number(u.port) || 3310 }; }
    else this.target = { path: address.replace(/^unix:\/\//, '') };
    this.timeoutMs = timeoutMs;
  }

  scan(buffer: Buffer, filename: string): Promise<ScanResult> {
    return new Promise((resolve) => {
      let settled = false;
      let reply = '';
      const finish = (result: ScanResult) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
      const skipped = (why: string) => finish({ verdict: 'skipped', detail: `The malware scanner could not give a verdict (${why}), so this file was not scanned.`, scanner: this.name });
      const socket = connect(this.target as { host: string; port: number });
      socket.setTimeout(this.timeoutMs, () => skipped(`no answer within ${Math.round(this.timeoutMs / 1000)} seconds`));
      socket.on('error', (e) => skipped(e.message));
      socket.on('data', (d) => { reply += d.toString('utf8'); });
      socket.on('end', () => {
        const answer = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(answer)) finish({ verdict: 'clean', detail: `Scanned clean by ${this.name}.`, scanner: this.name });
        else if (/ FOUND$/.test(answer)) finish({ verdict: 'rejected', detail: `${filename} was rejected by the malware scanner: ${answer.replace(/^stream: /, '').replace(/ FOUND$/, '').slice(0, 200)}`, scanner: this.name });
        else skipped(answer.slice(0, 200) || 'empty reply');
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < buffer.length; i += 64 * 1024) {
          const chunk = buffer.subarray(i, i + 64 * 1024);
          const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length, 0);
          socket.write(size); socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

/** clamd over its socket (VANTAGE_CLAMD), or the clamdscan command (VANTAGE_SCANNER_COMMAND); otherwise uploads are recorded as not scanned. */
export function scannerFor(config: { clamd?: string | null; command: string | null }): Scanner {
  if (config.clamd) return new ClamdSocketScanner(config.clamd);
  return config.command ? new ClamdScanner(config.command) : new NoScanner();
}

/**
 * Scans a file a person is adding and applies the instance's policy: a file the scanner rejects is never stored,
 * and with VANTAGE_SCAN_REQUIRED a file that could not be scanned is refused too, instead of being kept as not scanned.
 */
export async function scanUpload(config: { clamd: string | null; scannerCommand: string | null; scanRequired: boolean }, buffer: Buffer, filename: string): Promise<ScanResult> {
  const result = await scannerFor({ clamd: config.clamd, command: config.scannerCommand }).scan(buffer, filename);
  if (result.verdict === 'rejected') throw new HttpError(422, result.detail, 'malware_rejected');
  if (result.verdict === 'skipped' && config.scanRequired) throw new HttpError(503, `${result.detail} This instance accepts only scanned files; try again shortly or ask your administrator.`, 'scan_unavailable');
  return result;
}
