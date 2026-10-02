import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { AppContext } from '../context.ts';
import type { AuditConfig } from '../config.ts';

/**
 * Audit records leave the host as they are written.
 *
 * The audit chain and the case seals are keyed by a secret on this server, so on their own they prove nothing
 * against somebody who holds the server: with the database and the secret, a history can be rewritten and
 * re-signed. A copy held somewhere that person does not control — a SIEM, a syslog collector, the platform's
 * log store — is what makes a rewrite visible: the entry hashes there stop matching the chain here. The daily
 * anchor of every case head is an audit record, so it travels the same way.
 */

export interface ForwardedAudit {
  id: string; at: string; action: string; actor_id: string | null; entity: string | null; entity_id: string | null;
  subject_id: string | null; unit_id: string | null; detail: string | null; ip: string | null;
  prev_hash: string | null; entry_hash: string;
}

export interface AuditForwardingStatus {
  stdout: boolean;
  syslog: null | { target: string; transport: string; connected: boolean; sent: number; dropped: number; queued: number; lastError: string | null };
}

const MAX_QUEUE = 10_000;
/** RFC 5424 facility 13 is "log audit"; severity 5 is notice. */
const PRI = 13 * 8 + 5;
const HOST = (hostname() || '-').replace(/[^\x21-\x7e]/g, '').slice(0, 255) || '-';

/** One RFC 5424 line: the record as JSON, so a collector can index each field. */
export function syslogLine(entry: ForwardedAudit, appName: string): string {
  const msgId = entry.action.replace(/[^\x21-\x7e]/g, '_').slice(0, 32) || '-';
  const app = appName.replace(/[^\x21-\x7e]/g, '_').slice(0, 48) || '-';
  return `<${PRI}>1 ${entry.at} ${HOST} ${app} ${process.pid} ${msgId} - ${JSON.stringify({ type: 'vantage.audit', ...entry })}`;
}

class SyslogSink {
  readonly target: string;
  readonly transport: 'udp' | 'tcp' | 'tls';
  private readonly host: string;
  private readonly port: number;
  private readonly ca: Buffer | undefined;
  private readonly appName: string;
  private udp: UdpSocket | null = null;
  private stream: Socket | null = null;
  private connecting = false;
  private queue: string[] = [];
  private retryAt = 0;
  sent = 0;
  dropped = 0;
  lastError: string | null = null;

  constructor(cfg: AuditConfig) {
    const url = new URL(cfg.syslog!);
    this.target = `${url.protocol}//${url.host}`;
    this.transport = url.protocol.replace(':', '') as SyslogSink['transport'];
    this.host = url.hostname;
    this.port = Number(url.port) || (this.transport === 'tls' ? 6514 : 514);
    this.ca = cfg.syslogCa ? readFileSync(cfg.syslogCa) : undefined;
    this.appName = cfg.appName;
  }

  get queued() { return this.queue.length; }

  get connected() { return this.transport === 'udp' ? Boolean(this.udp) : Boolean(this.stream && !this.connecting); }

  send(entry: ForwardedAudit) {
    const line = syslogLine(entry, this.appName);
    if (this.transport === 'udp') {
      this.udp ||= createSocket(this.host.includes(':') ? 'udp6' : 'udp4').on('error', (e) => { this.lastError = e.message; });
      this.udp.unref();
      this.udp.send(Buffer.from(line, 'utf8'), this.port, this.host, (e) => { if (e) { this.dropped += 1; this.lastError = e.message; } else this.sent += 1; });
      return;
    }
    if (this.queue.length >= MAX_QUEUE) { this.queue.shift(); this.dropped += 1; }
    // RFC 6587 octet counting: the length in bytes, a space, then the message.
    this.queue.push(`${Buffer.byteLength(line, 'utf8')} ${line}`);
    this.flush();
  }

  private flush() {
    if (!this.stream) { this.open(); return; }
    if (this.connecting) return;
    while (this.queue.length) {
      const frame = this.queue.shift()!;
      this.stream.write(frame);
      this.sent += 1;
    }
  }

  private open() {
    if (this.connecting || Date.now() < this.retryAt) return;
    this.connecting = true;
    const onReady = () => { this.connecting = false; this.lastError = null; this.flush(); };
    const socket = this.transport === 'tls'
      ? tlsConnect({ host: this.host, port: this.port, ca: this.ca, servername: this.host }, onReady)
      : tcpConnect({ host: this.host, port: this.port }, onReady);
    socket.unref();
    socket.setKeepAlive(true);
    socket.on('error', (e) => { this.lastError = e.message; });
    socket.on('close', () => {
      if (this.stream === socket) this.stream = null;
      this.connecting = false;
      this.retryAt = Date.now() + 5_000;
      // Anything still queued waits for the next record or the retry below.
      if (this.queue.length) setTimeout(() => this.flush(), 5_000).unref();
    });
    this.stream = socket;
  }

  close() {
    try { this.udp?.close(); } catch {}
    try { this.stream?.end(); } catch {}
    this.udp = null; this.stream = null;
  }
}

const sinks = new WeakMap<AuditConfig, SyslogSink>();

function sinkFor(cfg: AuditConfig): SyslogSink | null {
  if (!cfg.syslog) return null;
  let sink = sinks.get(cfg);
  if (!sink) { sink = new SyslogSink(cfg); sinks.set(cfg, sink); }
  return sink;
}

export function forwardAudit(ctx: AppContext, entry: ForwardedAudit) {
  const cfg = ctx.config.audit;
  try {
    if (cfg.stdout) process.stdout.write(`${JSON.stringify({ type: 'vantage.audit', ...entry })}\n`);
    sinkFor(cfg)?.send(entry);
  } catch (e) {
    // Forwarding never blocks the record itself: the chain in the database is still written and still verifies.
    const sink = sinkFor(cfg);
    if (sink) { sink.dropped += 1; sink.lastError = (e as Error).message; }
  }
}

export function auditForwardingStatus(ctx: AppContext): AuditForwardingStatus {
  const cfg = ctx.config.audit;
  const sink = sinkFor(cfg);
  return {
    stdout: cfg.stdout,
    syslog: sink ? { target: sink.target, transport: sink.transport, connected: sink.connected, sent: sink.sent, dropped: sink.dropped, queued: sink.queued, lastError: sink.lastError } : null,
  };
}

export function closeAuditSink(ctx: AppContext) { sinks.get(ctx.config.audit)?.close(); }
