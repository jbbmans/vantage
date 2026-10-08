import { constants, createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { encryptSecret, decryptSecret, sha256 } from '../lib/crypto.ts';
import { secretsOf } from '../lib/keys.ts';
import { newId, now } from '../lib/ids.ts';
import { rosterVouching, seatFromRoster } from '../services/personnel.ts';

/**
 * Sign-in through the organization's identity provider over OpenID Connect: Microsoft Entra ID in GCC High or DoD,
 * or any provider that publishes a discovery document. Authorization code flow with PKCE, a single-use state and a
 * nonce; the ID token's signature is checked against the provider's published keys and its issuer, audience,
 * lifetime and nonce against this sign-in. Vantage never sees a password.
 */

export class OidcError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

export interface OidcClaims {
  iss: string; sub: string; aud: string | string[]; exp: number; iat?: number; nbf?: number; nonce?: string; azp?: string;
  email?: string; email_verified?: boolean; preferred_username?: string; upn?: string; name?: string; given_name?: string; family_name?: string;
  [claim: string]: unknown;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

const STATE_MINUTES = 10;
const CACHE_MS = 60 * 60_000;
/** Clock skew tolerated between this server and the provider. */
const SKEW_S = 120;
const ALGORITHMS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true },
};

let discoveryCache: { issuer: string; at: number; doc: Discovery } | null = null;
let jwksCache: { uri: string; at: number; keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> } | null = null;

/** For tests: forget what was fetched from the provider. */
export function resetOidcCache() { discoveryCache = null; jwksCache = null; }

/**
 * The Vantage Administrator console's check of the provider (ADR-0011): its discovery document read fresh, as a sign-in
 * reads it, then the keys it publishes. Reaches only the configured issuer and the addresses it names.
 */
export async function probeProvider(ctx: AppContext): Promise<{ issuer: string; authorizationHost: string; keys: number }> {
  discoveryCache = null;
  const doc = await discovery(ctx);
  const set = await getJson<{ keys?: unknown }>(doc.jwks_uri);
  return { issuer: doc.issuer, authorizationHost: new URL(doc.authorization_endpoint).host, keys: Array.isArray(set.keys) ? set.keys.length : 0 };
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch (e) { throw new OidcError(`The identity provider could not be reached (${(e as Error).message}).`, 'oidc_unreachable'); }
  if (!res.ok) throw new OidcError(`The identity provider answered ${res.status}.`, 'oidc_unreachable');
  return (await res.json()) as T;
}

export async function discovery(ctx: AppContext): Promise<Discovery> {
  const { issuer } = ctx.config.oidc;
  if (discoveryCache && discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < CACHE_MS) return discoveryCache.doc;
  const doc = await getJson<Discovery>(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  // A discovery document for some other issuer is not this provider's, whatever the URL said.
  if (doc.issuer !== issuer) throw new OidcError('The identity provider describes itself as a different issuer than the one configured.', 'oidc_misconfigured');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!doc[key] || !/^https:\/\//.test(doc[key]) && !ctx.config.test) throw new OidcError(`The identity provider's ${key} is missing or not HTTPS.`, 'oidc_misconfigured');
  }
  discoveryCache = { issuer, at: Date.now(), doc };
  return doc;
}

async function signingKey(ctx: AppContext, kid: string | undefined, alg: string): Promise<KeyObject> {
  const doc = await discovery(ctx);
  const find = () => jwksCache?.keys.find((k) => (!kid || k.kid === kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  if (!jwksCache || jwksCache.uri !== doc.jwks_uri || Date.now() - jwksCache.at > CACHE_MS || (!find() && Date.now() - jwksCache.at > 60_000)) {
    // Providers rotate keys; a kid we have not seen means fetch again, but not more than once a minute.
    const set = await getJson<{ keys: NonNullable<typeof jwksCache>['keys'] }>(doc.jwks_uri);
    jwksCache = { uri: doc.jwks_uri, at: Date.now(), keys: Array.isArray(set.keys) ? set.keys : [] };
  }
  const jwk = find();
  if (!jwk) throw new OidcError('The sign-in was signed with a key the identity provider does not publish.', 'oidc_bad_token');
  try { return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }); }
  catch { throw new OidcError('The identity provider published a key that cannot be read.', 'oidc_bad_token'); }
}

const b64urlJson = (part: string) => { try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; } };

/** Checks an ID token's signature and claims. Everything a forged or replayed token could get wrong is refused. */
export async function verifyIdToken(ctx: AppContext, token: string, expected: { nonceHash: string }): Promise<OidcClaims> {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new OidcError('The identity provider returned a malformed sign-in.', 'oidc_bad_token');
  const header = b64urlJson(parts[0]) as { alg?: string; kid?: string; typ?: string } | null;
  const claims = b64urlJson(parts[1]) as OidcClaims | null;
  if (!header || !claims) throw new OidcError('The identity provider returned a malformed sign-in.', 'oidc_bad_token');
  // "none", and HMAC algorithms keyed by something public, are how unsigned or self-signed tokens get accepted.
  const alg = ALGORITHMS[String(header.alg)];
  if (!alg) throw new OidcError(`The sign-in is signed with ${String(header.alg)}, which Vantage does not accept.`, 'oidc_bad_token');
  const key = await signingKey(ctx, header.kid, String(header.alg));
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  const ok = verifySignature(alg.hash, signed, alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key, signature);
  if (!ok) throw new OidcError('The sign-in’s signature does not verify.', 'oidc_bad_token');

  const { issuer, clientId } = ctx.config.oidc;
  const nowS = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw new OidcError('The sign-in was issued by a different provider.', 'oidc_bad_token');
  if (!audiences.includes(clientId)) throw new OidcError('The sign-in was issued for a different application.', 'oidc_bad_token');
  if (audiences.length > 1 && claims.azp && claims.azp !== clientId) throw new OidcError('The sign-in was issued for a different application.', 'oidc_bad_token');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) throw new OidcError('The sign-in has expired. Try again.', 'oidc_expired');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > nowS) throw new OidcError('The sign-in is not valid yet. Check this server’s clock.', 'oidc_bad_token');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > nowS) throw new OidcError('The sign-in was issued in the future. Check this server’s clock.', 'oidc_bad_token');
  if (!claims.nonce || sha256(`oidc-nonce:${claims.nonce}`) !== expected.nonceHash) throw new OidcError('The sign-in does not belong to this attempt.', 'oidc_bad_token');
  if (!claims.sub) throw new OidcError('The sign-in carries no subject.', 'oidc_bad_token');
  return claims;
}

export type Face = 'app' | 'console';

/** The callback address registered with the provider, one per face so each face's sign-in lands on its own host. */
export const redirectUri = (ctx: AppContext, face: Face) => `${new URL(ctx.config.urls[face]).origin}/api/auth/oidc/callback`;

/** Begins a sign-in: records the attempt and returns the provider URL to send the browser to. */
export async function startSignIn(ctx: AppContext, opts: { face: Face; consented: boolean; returnTo: string | null }): Promise<string> {
  const doc = await discovery(ctx);
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const at = new Date();
  ctx.db.prepare('DELETE FROM oidc_states WHERE expires_at < ? OR used_at IS NOT NULL').run(at.toISOString());
  ctx.db.prepare(
    'INSERT INTO oidc_states (state_hash, nonce_hash, verifier_enc, face, consented, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sha256(`oidc-state:${state}`), sha256(`oidc-nonce:${nonce}`), encryptSecret(ctx.config.secret, verifier), opts.face, opts.consented ? 1 : 0, opts.returnTo,
    at.toISOString(), new Date(at.getTime() + STATE_MINUTES * 60_000).toISOString());
  const params = new URLSearchParams({
    client_id: ctx.config.oidc.clientId, response_type: 'code', redirect_uri: redirectUri(ctx, opts.face), scope: ctx.config.oidc.scopes,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', response_mode: 'query',
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

export interface Completed { claims: OidcClaims; face: Face; consented: boolean; returnTo: string | null }

/** Finishes a sign-in the provider sent back: the state is used once, the code is exchanged, the token is checked. */
export async function completeSignIn(ctx: AppContext, query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<Completed> {
  if (!query.state) throw new OidcError('The sign-in came back without its state. Start again.', 'oidc_state');
  const row = ctx.db.prepare('SELECT * FROM oidc_states WHERE state_hash = ?').get(sha256(`oidc-state:${query.state}`)) as
    { state_hash: string; nonce_hash: string; verifier_enc: string; face: Face; consented: number; return_to: string | null; expires_at: string; used_at: string | null } | undefined;
  // Spent before anything else, so a replayed callback finds it gone whatever happens next.
  const claimed = row && !row.used_at ? ctx.db.prepare('UPDATE oidc_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL').run(now(), row.state_hash).changes : 0;
  if (!row || !claimed) throw new OidcError('That sign-in has already been used or was never started here. Start again.', 'oidc_state');
  if (Date.parse(row.expires_at) < Date.now()) throw new OidcError('The sign-in took too long. Start again.', 'oidc_state');
  if (query.error) throw new OidcError(`The identity provider did not sign you in: ${String(query.error_description || query.error).slice(0, 200)}`, 'oidc_denied');
  if (!query.code) throw new OidcError('The identity provider sent no code. Start again.', 'oidc_state');
  const verifier = decryptSecret(secretsOf(ctx.config), row.verifier_enc);
  if (!verifier) throw new OidcError('The sign-in could not be completed. Start again.', 'oidc_state');

  const doc = await discovery(ctx);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(ctx, row.face), client_id: ctx.config.oidc.clientId, code_verifier: verifier });
  if (ctx.config.oidc.clientSecret) form.set('client_secret', ctx.config.oidc.clientSecret);
  let res: Response;
  try {
    res = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch (e) { throw new OidcError(`The identity provider could not be reached (${(e as Error).message}).`, 'oidc_unreachable'); }
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new OidcError(`The identity provider refused the sign-in: ${String(body.error_description || body.error || res.status).slice(0, 200)}`, 'oidc_denied');
  const claims = await verifyIdToken(ctx, body.id_token, { nonceHash: row.nonce_hash });
  return { claims, face: row.face, consented: Boolean(row.consented), returnTo: row.return_to };
}

/** The address a person signed in with, from whichever claim the provider uses for it. */
export function emailOf(claims: OidcClaims): string | null {
  for (const v of [claims.email, claims.preferred_username, claims.upn]) if (typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return v.toLowerCase();
  return null;
}

/**
 * The account a verified sign-in belongs to. An account linked before is found by issuer and subject, which a
 * provider never reassigns. The first time, it is linked by the configured claim: the email address (the provider is
 * the organization's own tenant, which owns its addresses) or the EDIPI; with roster provisioning on, a Marine on the
 * roster who has no account yet gets one.
 */
export function resolveOidcAccount(ctx: AppContext, claims: OidcClaims): { userId: string; linked: boolean; provisioned: boolean } {
  const { db } = ctx;
  const cfg = ctx.config.oidc;
  const known = db.prepare('SELECT id, active FROM users WHERE oidc_issuer = ? AND oidc_subject = ?').get(claims.iss, claims.sub) as { id: string; active: number } | undefined;
  if (known) {
    if (!known.active) throw new OidcError('That account is not active.', 'oidc_inactive');
    return { userId: known.id, linked: false, provisioned: false };
  }
  const edipi = cfg.edipiClaim ? String(claims[cfg.edipiClaim] ?? '').trim() : '';
  let candidate: { id: string; active: number; oidc_subject: string | null } | undefined;
  if (cfg.linkBy === 'email' && (claims.email_verified === true || cfg.trustProviderEmail)) {
    const email = emailOf(claims);
    if (email) candidate = db.prepare('SELECT id, active, oidc_subject FROM users WHERE email = ? COLLATE NOCASE').get(email) as typeof candidate;
  } else if (cfg.linkBy === 'edipi' && /^\d{10}$/.test(edipi)) {
    candidate = db.prepare('SELECT id, active, oidc_subject FROM users WHERE edipi = ?').get(edipi) as typeof candidate;
  }
  if (candidate) {
    if (!candidate.active) throw new OidcError('That account is not active.', 'oidc_inactive');
    // An account already tied to another identity is not re-tied by a matching address.
    if (candidate.oidc_subject) throw new OidcError('That Vantage account is already linked to a different sign-in. Ask your administrator.', 'oidc_conflict');
    db.prepare('UPDATE users SET oidc_issuer = ?, oidc_subject = ?, updated_at = ? WHERE id = ?').run(claims.iss, claims.sub, now(), candidate.id);
    return { userId: candidate.id, linked: true, provisioned: false };
  }
  if (cfg.autoProvisionFromRoster && /^\d{10}$/.test(edipi)) {
    const roster = rosterVouching(ctx, edipi);
    if (roster && !db.prepare('SELECT 1 FROM users WHERE edipi = ?').get(edipi)) {
      const id = newId();
      const at = now();
      // An address another account already holds is left off rather than refusing the person.
      const email = emailOf(claims);
      const freeEmail = email && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(email) ? email : null;
      try {
        db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, middle_initial, rank_id, mos, eas, edipi, identity_source, identity_synced_at, oidc_issuer, oidc_subject, active, created_at, updated_at)
                    VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'roster', ?, ?, ?, 1, ?, ?)`)
          .run(id, `edipi-${edipi}`, freeEmail, roster.first_name, roster.last_name, roster.middle_initial, roster.rank_id, roster.mos, roster.eas, edipi, at, claims.iss, claims.sub, at, at);
      } catch (e) {
        if (String((e as Error).message).includes('UNIQUE')) throw new OidcError('An account for that person could not be created because one with the same name already exists. Ask your administrator.', 'oidc_conflict');
        throw e;
      }
      seatFromRoster(ctx, id, roster);
      return { userId: id, linked: true, provisioned: true };
    }
  }
  throw new OidcError('No Vantage account is linked to that sign-in. Ask your administrator to add you, then sign in again.', 'oidc_unlinked');
}
