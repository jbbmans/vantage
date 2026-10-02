import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { metaGet, metaSet } from '../db/index.ts';
import type { AppConfig } from '../config.ts';
import { decryptSecret, encryptSecret, hmac } from './crypto.ts';

/**
 * Keys derived from VANTAGE_SECRET, and how the secret is changed without losing anything.
 *
 * Two things depend on the secret. Values stored encrypted (authenticator secrets, mailbox tokens, the DKIM key,
 * queued mail) are sealed with it. The audit chain and the case seals are HMACs under a chain key, which is kept in
 * the database sealed with the secret, so changing the secret re-wraps that one key instead of breaking every chain.
 *
 * To change the secret: set the new value as VANTAGE_SECRET and the old one as VANTAGE_SECRET_PREVIOUS, start once,
 * then remove VANTAGE_SECRET_PREVIOUS. That start re-seals every stored value under the new secret.
 */

const CHAIN_KEY = 'chain_key';

export const secretsOf = (config: Pick<AppConfig, 'secret' | 'previousSecrets'>): string[] => [config.secret, ...config.previousSecrets];

/** The secret the existing audit head was signed with, if any: chains written before the chain key existed used the secret itself. */
function secretThatSignedTheChain(db: Db, candidates: string[]): string | null {
  const head = JSON.parse(metaGet(db, 'audit_head') || 'null') as { hash: string; count: number; mac?: string } | null;
  if (head?.mac) {
    for (const s of candidates) if (hmac(s, `audit-head:${head.hash}:${head.count}`) === head.mac) return s;
  }
  const caseHead = db.prepare('SELECT work_item_id, hash, count, mac FROM work_event_heads LIMIT 1').get() as { work_item_id: string; hash: string; count: number; mac: string } | undefined;
  if (caseHead) {
    for (const s of candidates) if (hmac(s, `case-head:${caseHead.work_item_id}:${caseHead.hash}:${caseHead.count}`) === caseHead.mac) return s;
  }
  return null;
}

/** Opens (or on first start creates) the chain key, and re-wraps it under the current secret. */
export function loadChainKey(db: Db, config: Pick<AppConfig, 'secret' | 'previousSecrets'>): string {
  const candidates = secretsOf(config);
  const stored = metaGet(db, CHAIN_KEY);
  if (stored) {
    const key = decryptSecret(candidates, stored);
    if (key === null) {
      throw new Error('VANTAGE_SECRET does not open this database. If the secret was changed, set the value this instance last ran with as VANTAGE_SECRET_PREVIOUS for one start.');
    }
    if (decryptSecret(config.secret, stored) === null) metaSet(db, CHAIN_KEY, encryptSecret(config.secret, key));
    return key;
  }
  const hasChain = Boolean(metaGet(db, 'audit_head')) || Boolean(db.prepare('SELECT 1 FROM work_event_heads LIMIT 1').get());
  const key = hasChain ? secretThatSignedTheChain(db, candidates) ?? config.secret : randomBytes(32).toString('base64url');
  metaSet(db, CHAIN_KEY, encryptSecret(config.secret, key));
  return key;
}

/** Every column that holds a value sealed with the secret. */
const SEALED_COLUMNS: Array<[table: string, column: string]> = [
  ['users', 'totp_secret'], ['users', 'totp_pending'],
  ['connectors', 'access_token_enc'], ['connectors', 'refresh_token_enc'],
  ['connector_auth_states', 'verifier_enc'],
  ['oidc_states', 'verifier_enc'],
  ['email_queue', 'payload'],
];

/** Re-seals under the current secret every stored value that only a previous secret opens. Returns how many changed. */
export function resealStoredSecrets(db: Db, config: Pick<AppConfig, 'secret' | 'previousSecrets'>): number {
  if (!config.previousSecrets.length) return 0;
  let changed = 0;
  const reseal = (value: string | null): string | null => {
    if (!value || decryptSecret(config.secret, value) !== null) return null;
    const plain = decryptSecret(config.previousSecrets, value);
    return plain === null ? null : encryptSecret(config.secret, plain);
  };
  db.transaction(() => {
    for (const [table, column] of SEALED_COLUMNS) {
      const rows = db.prepare(`SELECT rowid AS rid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ rid: number; v: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const next = reseal(row.v);
        if (next) { update.run(next, row.rid); changed += 1; }
      }
    }
    // The DKIM private key lives inside a JSON value in meta.
    const dkim = metaGet(db, 'mail_dkim');
    if (dkim) {
      const parsed = JSON.parse(dkim) as { key?: string };
      const next = reseal(parsed.key ?? null);
      if (next) { metaSet(db, 'mail_dkim', JSON.stringify({ ...parsed, key: next })); changed += 1; }
    }
  })();
  return changed;
}
