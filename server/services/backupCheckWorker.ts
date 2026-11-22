import { parentPort, workerData } from 'node:worker_threads';
import { checkBackup, type CheckOptions } from './backupCheck.ts';

/**
 * One backup check on a thread of its own (ADR-0041). The check reads every byte of the copy, runs SQLite's integrity
 * check and walks the audit trail; on the service's own thread that would hold every other request while it runs.
 */
const { path, options } = workerData as { path: string; options: CheckOptions };
parentPort!.postMessage(checkBackup(path, options));
