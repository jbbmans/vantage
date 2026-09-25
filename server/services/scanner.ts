import { spawn } from 'node:child_process';

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

/** Used by tests to drive each verdict without needing a scanner installed. */
export class FixedScanner implements Scanner {
  readonly name = 'fixed';
  private readonly result: ScanResult;
  constructor(result: ScanResult) { this.result = result; }
  async scan(): Promise<ScanResult> { return this.result; }
}

export function scannerFor(config: { command: string | null }): Scanner {
  return config.command ? new ClamdScanner(config.command) : new NoScanner();
}
