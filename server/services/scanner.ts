import { spawn } from 'node:child_process';

/**
 * Malware scanning for uploaded files.
 *
 * An upload is quarantined the moment it arrives and is not parsed until a scanner has spoken.
 * Vantage never sends a file to a third party to be scanned: the workbooks people import here hold
 * contract numbers and funding lines, and uploading them to a public service would be a disclosure,
 * not a precaution. The only supported scanner is one the instance runs itself.
 *
 * With no scanner configured the verdict is "skipped", which is recorded honestly and shown to the
 * operator. Skipped is not clean, and the owner console says so.
 */

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

/** No scanner. Files are accepted, and the absence of a scan is stated rather than implied. */
export class NoScanner implements Scanner {
  readonly name = 'none';
  async scan(): Promise<ScanResult> {
    return { verdict: 'skipped', detail: 'No malware scanner is configured on this instance, so this file was not scanned.', scanner: this.name };
  }
}

/**
 * clamd over its local UNIX socket or TCP port, via clamdscan. The file is streamed to a process
 * on this host; nothing leaves the machine.
 */
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
