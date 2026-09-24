import type { AppContext, SessionUser } from '../context.ts';
import { record } from './telemetry.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { decryptSecret, encryptSecret, sha256 } from '../lib/crypto.ts';
import { createHash, randomBytes } from 'node:crypto';
import { newId, now } from '../lib/ids.ts';
import { parseAddresses, type ParsedEmail } from '../lib/eml.ts';
import { htmlToText } from '../lib/sanitizeHtml.ts';
import { storeParsedMessage, getThread } from './correspondence.ts';

/**
 * Reading mail from a connected mailbox.
 *
 * Three decisions are load-bearing here.
 *
 * The national cloud is configuration, never inference. A GCC High or DoD tenant is reached at
 * different hostnames from the commercial one, and an address ending in .mil says nothing reliable
 * about which tenant it lives in: plenty of .mil mail is commercial, and plenty of commercial-looking
 * addresses are in GCC High. Guessing wrong means sending a token to the wrong Microsoft. So the
 * cloud is chosen by whoever sets the connector up, and is stored on it.
 *
 * Sync is incremental and keyed on the provider's own message id. Matching on subject would merge
 * two unrelated conversations the moment somebody replies to the wrong mail, and subjects are
 * trivially forged. A provider id is not.
 *
 * Access is read-only. Nothing here sends mail, deletes mail, or marks anything read. Sending would
 * mean Vantage acting as a Marine in front of people outside the unit, and that is a bigger decision
 * than an import feature gets to make on its own.
 */

export type Cloud = 'global' | 'usgov' | 'usgovdod';

export interface CloudEndpoints { label: string; authority: string; graph: string; scopeHost: string }

/**
 * Microsoft's national clouds. These hostnames are the whole reason the cloud has to be declared:
 * a token minted for one is worthless at another, and sending one to the wrong host is a disclosure.
 */
export const MICROSOFT_CLOUDS: Record<Cloud, CloudEndpoints> = {
  global: { label: 'Commercial (worldwide)', authority: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com', scopeHost: 'graph.microsoft.com' },
  usgov: { label: 'GCC High (US Government)', authority: 'https://login.microsoftonline.us', graph: 'https://graph.microsoft.us', scopeHost: 'graph.microsoft.us' },
  usgovdod: { label: 'DoD (US Government)', authority: 'https://login.microsoftonline.us', graph: 'https://dod-graph.microsoft.us', scopeHost: 'dod-graph.microsoft.us' },
};

/** Read-only, and narrow. Vantage never asks for permission to send or to change anything. */
export const READ_ONLY_SCOPES = ['offline_access', 'User.Read', 'Mail.Read'];

export interface ConnectorRow {
  id: string; user_id: string; provider: string; cloud: Cloud; account_label: string;
  access: string; status: string; scopes: string; delta_token: string | null;
  last_sync_at: string | null; last_error: string | null; created_at: string; updated_at: string;
  access_token_enc?: string | null; refresh_token_enc?: string | null; token_expires_at?: string | null;
  account_id?: string | null; account_address?: string | null; tenant_id?: string | null; authorized_at?: string | null;
}

/** What a connector looks like from outside. No token, no delta cursor: neither is anyone's business. */
export function publicView(row: ConnectorRow) {
  const endpoints = MICROSOFT_CLOUDS[row.cloud] || MICROSOFT_CLOUDS.global;
  return {
    id: row.id, provider: row.provider, cloud: row.cloud, cloud_label: endpoints.label,
    graph_host: endpoints.graph, authority: endpoints.authority,
    account_label: row.account_label, access: row.access, status: row.status,
    scopes: JSON.parse(row.scopes || '[]') as string[],
    last_sync_at: row.last_sync_at, last_error: row.last_error,
    has_delta_cursor: Boolean(row.delta_token),
    // Who the connection signed in as, and when. Never the tokens themselves.
    account_address: row.account_address || null, authorized_at: row.authorized_at || null,
    token_expires_at: row.token_expires_at || null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function listConnectors(ctx: AppContext, user: SessionUser) {
  const rows = ctx.db.prepare('SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as ConnectorRow[];
  return rows.map(publicView);
}

export function createConnector(ctx: AppContext, user: SessionUser, input: { provider?: string; cloud?: string; account_label?: string }) {
  const provider = String(input.provider || 'microsoft365');
  if (provider !== 'microsoft365') throw badRequest('Vantage connects to Microsoft 365 mailboxes. Other providers are not supported.');
  const cloud = String(input.cloud || '') as Cloud;
  if (!MICROSOFT_CLOUDS[cloud]) {
    throw badRequest(`Choose which Microsoft cloud this mailbox is in: ${Object.entries(MICROSOFT_CLOUDS).map(([k, v]) => `${k} (${v.label})`).join(', ')}. Vantage will not guess this from an email address, because the address does not tell you.`);
  }
  const label = String(input.account_label || '').trim().slice(0, 200);
  if (!label) throw badRequest('Name the mailbox this connector is for.');

  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO connectors (id, user_id, provider, cloud, account_label, access, status, scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'read_only', 'needs_authorization', ?, ?, ?)`
  ).run(id, user.id, provider, cloud, label, JSON.stringify(READ_ONLY_SCOPES), at, at);
  return publicView(ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow);
}

export function ownedConnector(ctx: AppContext, user: SessionUser, id: string): ConnectorRow {
  const row = ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined;
  if (!row) throw notFound('No such connector.');
  // A mailbox connection is personal. An operator can see that one exists, never read through it.
  if (row.user_id !== user.id) throw forbidden('That mailbox connection belongs to someone else.');
  return row;
}

export function deleteConnector(ctx: AppContext, user: SessionUser, id: string) {
  const row = ownedConnector(ctx, user, id);
  ctx.db.transaction(() => {
    // Messages already imported stay: they are a record of work. Only the connection goes.
    ctx.db.prepare('UPDATE threads SET connector_id = NULL, provider = NULL, provider_thread_id = NULL WHERE connector_id = ?').run(row.id);
    ctx.db.prepare('DELETE FROM connectors WHERE id = ?').run(row.id);
  })();
}

/** The exact URLs an authorization would use. Shown to an operator so it can be checked before use. */
export function authorizationPlan(row: ConnectorRow, tenant = 'organizations') {
  const endpoints = MICROSOFT_CLOUDS[row.cloud] || MICROSOFT_CLOUDS.global;
  const scopes = JSON.parse(row.scopes || '[]') as string[];
  return {
    cloud: row.cloud,
    cloud_label: endpoints.label,
    authorize_url: `${endpoints.authority}/${tenant}/oauth2/v2.0/authorize`,
    token_url: `${endpoints.authority}/${tenant}/oauth2/v2.0/token`,
    graph_base: `${endpoints.graph}/v1.0`,
    delta_url: `${endpoints.graph}/v1.0/me/messages/delta`,
    scopes: scopes.map((s) => (s.includes('/') || s === 'offline_access' ? s : `https://${endpoints.scopeHost}/${s}`)),
    access: row.access,
  };
}

// Authorization -------------------------------------------------------

/**
 * Signing a mailbox in (F08).
 *
 * The flow is OAuth 2.0 authorization code with PKCE, against the connector's own national cloud,
 * as a confidential client. Four things keep it honest:
 *
 *   Bound to the person. The sign-in is started by a signed-in Vantage user and can only be
 *   completed by the same user, once, within ten minutes. Anybody else arriving with the state
 *   value is refused, which is what stops a link from binding somebody else's mailbox to yours.
 *
 *   Bound to the mailbox. The connector names the mailbox it is for. If Microsoft signs in a
 *   different account, the tokens are thrown away and nothing is connected.
 *
 *   Read-only, checked. If Microsoft grants more than read access, Vantage refuses the grant.
 *
 *   Visible. Every failure lands on the connector as a plain sentence, and a connection Microsoft
 *   stops honouring goes back to needing authorization instead of failing quietly.
 */

export const mailboxConfigured = (ctx: AppContext) => Boolean(ctx.config.m365.clientId && ctx.config.m365.clientSecret);

export function mailboxAvailability(ctx: AppContext) {
  return mailboxConfigured(ctx)
    ? { available: true as const, reason: null }
    : { available: false as const, reason: 'Mailbox sign-in is not set up on this instance. An operator has to register a Microsoft Entra application and give Vantage its client id and secret. Until then, bring mail in by uploading .eml files.' };
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string; error?: string; error_description?: string }

/** The hosts a connector talks to. Only the test suite may point these anywhere else. */
function hostsFor(ctx: AppContext, cloud: Cloud) {
  const base = MICROSOFT_CLOUDS[cloud] || MICROSOFT_CLOUDS.global;
  const override = ctx.config.m365.endpointOverride;
  return override ? { ...base, authority: override, graph: override, scopeHost: base.scopeHost } : base;
}

function endpointsFor(ctx: AppContext, row: ConnectorRow) {
  const hosts = hostsFor(ctx, row.cloud);
  const tenant = ctx.config.m365.tenant;
  const scopes = (JSON.parse(row.scopes || '[]') as string[]).map((s) => (s.includes('/') || s === 'offline_access' ? s : `https://${hosts.scopeHost}/${s}`));
  return {
    authorize: `${hosts.authority}/${tenant}/oauth2/v2.0/authorize`,
    token: `${hosts.authority}/${tenant}/oauth2/v2.0/token`,
    me: `${hosts.graph}/v1.0/me?$select=id,mail,userPrincipalName`,
    scopes,
  };
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const STATE_MINUTES = 10;

/** Starts a sign-in: returns the Microsoft URL to send the browser to. */
export function startAuthorization(ctx: AppContext, user: SessionUser, connectorId: string) {
  if (!mailboxConfigured(ctx)) throw conflict(mailboxAvailability(ctx).reason!, 'mailbox_unconfigured');
  const row = ownedConnector(ctx, user, connectorId);
  if (row.access !== 'read_only') throw badRequest('Vantage only signs in read-only mailbox connections.');
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const at = new Date();
  ctx.db.prepare('DELETE FROM connector_auth_states WHERE expires_at < ? OR used_at IS NOT NULL').run(at.toISOString());
  ctx.db.prepare(
    'INSERT INTO connector_auth_states (state_hash, connector_id, user_id, verifier_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sha256(state), row.id, user.id, encryptSecret(ctx.config.secret, verifier), at.toISOString(), new Date(at.getTime() + STATE_MINUTES * 60_000).toISOString());
  const ep = endpointsFor(ctx, row);
  const params = new URLSearchParams({
    client_id: ctx.config.m365.clientId,
    response_type: 'code',
    redirect_uri: ctx.config.m365.redirectUri,
    response_mode: 'query',
    scope: ep.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (row.account_label.includes('@')) params.set('login_hint', row.account_label);
  return { url: `${ep.authorize}?${params.toString()}`, expires_in: STATE_MINUTES * 60 };
}

async function postForm(url: string, form: Record<string, string>, timeoutMs = 20_000): Promise<{ status: number; body: TokenResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), redirect: 'error', signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

/** Claims in an id token Microsoft just handed us over TLS. Read for the directory id only; never trusted for identity. */
function idTokenTenant(idToken: string | undefined): string | null {
  try { return idToken ? String(JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).tid || '') || null : null; }
  catch { return null; }
}

const BROADER_THAN_READ = /(^|[\s/])(Mail\.ReadWrite|Mail\.Send|Mail\.ReadWrite\.Shared|Mail\.Send\.Shared|MailboxSettings\.ReadWrite)(\s|$)/i;

function failAuthorization(ctx: AppContext, row: ConnectorRow, message: string, code: string): never {
  ctx.db.prepare("UPDATE connectors SET status = 'needs_authorization', last_error = ?, updated_at = ? WHERE id = ?").run(message.slice(0, 500), now(), row.id);
  throw conflict(message, code);
}

/** Finishes a sign-in: exchanges the code, checks what was granted and who signed in, stores the tokens. */
export async function completeAuthorization(ctx: AppContext, user: SessionUser, input: { code?: string; state?: string; error?: string; error_description?: string }) {
  const state = String(input.state || '');
  if (!state) throw badRequest('This sign-in did not come back with its state value, so it cannot be matched to anything.');
  const pending = ctx.db.prepare('SELECT * FROM connector_auth_states WHERE state_hash = ?').get(sha256(state)) as
    { state_hash: string; connector_id: string; user_id: string; verifier_enc: string; expires_at: string; used_at: string | null } | undefined;
  // Unknown, used, expired, or started by somebody else: all refused the same way.
  if (!pending || pending.used_at || pending.expires_at < new Date().toISOString() || pending.user_id !== user.id) {
    throw forbidden('This mailbox sign-in is not one you started, or it has expired. Start it again from Correspondence.', 'authorization_state_invalid');
  }
  ctx.db.prepare('UPDATE connector_auth_states SET used_at = ? WHERE state_hash = ?').run(now(), pending.state_hash);
  const row = ownedConnector(ctx, user, pending.connector_id);
  if (input.error) failAuthorization(ctx, row, `Microsoft did not authorize the mailbox: ${String(input.error_description || input.error).slice(0, 300)}`, 'authorization_declined');
  if (!input.code) failAuthorization(ctx, row, 'Microsoft returned without an authorization code.', 'authorization_incomplete');
  const verifier = decryptSecret(ctx.config.secret, pending.verifier_enc);
  if (!verifier) failAuthorization(ctx, row, 'The sign-in could not be completed on this server. Start it again.', 'authorization_incomplete');

  const ep = endpointsFor(ctx, row);
  const token = await postForm(ep.token, {
    grant_type: 'authorization_code', client_id: ctx.config.m365.clientId, client_secret: ctx.config.m365.clientSecret,
    code: String(input.code), redirect_uri: ctx.config.m365.redirectUri, code_verifier: verifier!, scope: ep.scopes.join(' '),
  }).catch((e: Error) => failAuthorization(ctx, row, `Microsoft could not be reached to finish signing in: ${e.message}`, 'authorization_unreachable'));
  if (token.status !== 200 || !token.body.access_token) {
    failAuthorization(ctx, row, `Microsoft refused the sign-in: ${String(token.body.error_description || token.body.error || `HTTP ${token.status}`).split('\n')[0].slice(0, 300)}`, 'authorization_refused');
  }
  const granted = String(token.body.scope || '');
  if (BROADER_THAN_READ.test(granted)) failAuthorization(ctx, row, 'Microsoft granted more than read access to this mailbox. Vantage refuses a grant broader than it asked for; nothing was stored.', 'authorization_too_broad');
  if (!/Mail\.Read(\s|$)/i.test(granted) && granted) failAuthorization(ctx, row, 'Microsoft did not grant read access to mail, so there is nothing Vantage could read.', 'authorization_insufficient');

  // Who actually signed in. The connector names a mailbox; a different one is not connected.
  const me = await fetch(ep.me, { headers: { authorization: `Bearer ${token.body.access_token}`, accept: 'application/json' }, redirect: 'error' })
    .then(async (r) => (r.ok ? ((await r.json()) as { id?: string; mail?: string; userPrincipalName?: string }) : null))
    .catch(() => null);
  if (!me?.id) failAuthorization(ctx, row, 'Signed in, but Microsoft Graph would not say which account it was, so the mailbox was not connected.', 'authorization_unverified');
  const address = String(me!.mail || me!.userPrincipalName || '').toLowerCase();
  const expected = row.account_label.trim().toLowerCase();
  if (expected.includes('@') && address !== expected) {
    failAuthorization(ctx, row, `You signed in as ${address || 'an account with no address'}, but this connection is for ${expected}. Nothing was connected.`, 'authorization_wrong_account');
  }
  const at = now();
  const expires = new Date(Date.now() + Math.max(60, Number(token.body.expires_in) || 3600) * 1000).toISOString();
  // A different mailbox than last time starts from scratch rather than resuming another account's cursor.
  const reset = row.account_id && row.account_id !== me!.id;
  ctx.db.prepare(
    `UPDATE connectors SET status = 'connected', last_error = NULL, access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?,
            account_id = ?, account_address = ?, tenant_id = ?, authorized_at = ?, delta_token = CASE WHEN ? THEN NULL ELSE delta_token END, updated_at = ?
      WHERE id = ?`
  ).run(
    encryptSecret(ctx.config.secret, token.body.access_token!), token.body.refresh_token ? encryptSecret(ctx.config.secret, token.body.refresh_token) : null, expires,
    me!.id, address || null, idTokenTenant(token.body.id_token), at, reset ? 1 : 0, at, row.id,
  );
  record(ctx, 'correspondence.authorized', { cloud: row.cloud }, { id: user.id });
  return publicView(ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(row.id) as ConnectorRow);
}

/**
 * A usable access token for a connected mailbox, refreshed when it is close to expiring. A refresh
 * Microsoft refuses (revoked consent, a password change, an expired grant) takes the connection back
 * to needing authorization, with the reason on it, and forgets the tokens.
 */
export async function accessTokenFor(ctx: AppContext, row: ConnectorRow): Promise<string> {
  if (row.status !== 'connected') throw conflict('This mailbox is not connected. Authorize it first.', 'connector_not_authorized');
  const current = row.access_token_enc ? decryptSecret(ctx.config.secret, row.access_token_enc) : null;
  if (current && row.token_expires_at && Date.parse(row.token_expires_at) - Date.now() > 120_000) return current;
  const refresh = row.refresh_token_enc ? decryptSecret(ctx.config.secret, row.refresh_token_enc) : null;
  if (!refresh || !mailboxConfigured(ctx)) {
    forgetTokens(ctx, row, 'The connection’s sign-in has run out and there is nothing to renew it with. Authorize it again.');
    throw conflict('The mailbox sign-in has run out. Authorize it again.', 'connector_reauthorize');
  }
  const ep = endpointsFor(ctx, row);
  const res = await postForm(ep.token, { grant_type: 'refresh_token', client_id: ctx.config.m365.clientId, client_secret: ctx.config.m365.clientSecret, refresh_token: refresh, scope: ep.scopes.join(' ') })
    .catch((e: Error) => { throw conflict(`Microsoft could not be reached to renew the sign-in: ${e.message}`, 'connector_unreachable'); });
  if (res.status !== 200 || !res.body.access_token) {
    const why = String(res.body.error_description || res.body.error || `HTTP ${res.status}`).split('\n')[0].slice(0, 300);
    forgetTokens(ctx, row, `Microsoft no longer accepts this connection (${why}). Authorize it again.`);
    throw conflict('Microsoft no longer accepts this mailbox connection. Authorize it again.', 'connector_reauthorize');
  }
  if (BROADER_THAN_READ.test(String(res.body.scope || ''))) {
    forgetTokens(ctx, row, 'Microsoft renewed the sign-in with more than read access. Vantage refused it.');
    throw conflict('The renewed grant was broader than read access, so Vantage refused it.', 'authorization_too_broad');
  }
  const expires = new Date(Date.now() + Math.max(60, Number(res.body.expires_in) || 3600) * 1000).toISOString();
  ctx.db.prepare('UPDATE connectors SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), token_expires_at = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(ctx.config.secret, res.body.access_token), res.body.refresh_token ? encryptSecret(ctx.config.secret, res.body.refresh_token) : null, expires, now(), row.id);
  return res.body.access_token;
}

function forgetTokens(ctx: AppContext, row: ConnectorRow, reason: string) {
  ctx.db.prepare("UPDATE connectors SET status = 'needs_authorization', access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
    .run(reason.slice(0, 500), now(), row.id);
}

/**
 * Disconnects without removing: the tokens are destroyed here at once. Microsoft keeps the consent
 * record until the person removes the app from their account, which the response tells them how to do.
 */
export function disconnectConnector(ctx: AppContext, user: SessionUser, id: string) {
  const row = ownedConnector(ctx, user, id);
  ctx.db.prepare("UPDATE connectors SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, delta_token = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
  ctx.db.prepare('DELETE FROM connector_auth_states WHERE connector_id = ?').run(row.id);
  const portal = row.cloud === 'global' ? 'https://myapps.microsoft.com' : 'https://myapps.microsoft.us';
  return { connector: publicView(ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(row.id) as ConnectorRow), revoke_consent_at: portal };
}

// Sync ----------------------------------------------------------------

/**
 * One message as Microsoft Graph returns it, narrowed to the fields Vantage reads.
 * Kept as an interface so a sync can be driven from a live Graph response or from a recorded one
 * without the storing code knowing which it got.
 */
export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
  '@removed'?: unknown;
}

export interface DeltaPage { value: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }

/** How a page of messages is fetched. Injected so a sync can be tested without a live tenant. */
export type GraphFetcher = (url: string) => Promise<DeltaPage>;

const addressOf = (entry: { emailAddress?: { name?: string; address?: string } } | undefined) =>
  entry?.emailAddress?.address ? { name: entry.emailAddress.name || null, email: String(entry.emailAddress.address).toLowerCase() } : null;

function toParsed(message: GraphMessage): ParsedEmail {
  const isHtml = (message.body?.contentType || '').toLowerCase() === 'html';
  const content = message.body?.content || '';
  return {
    messageId: message.internetMessageId || message.id,
    inReplyTo: null,
    references: [],
    subject: String(message.subject || '(no subject)').slice(0, 500),
    from: addressOf(message.from),
    to: (message.toRecipients || []).map(addressOf).filter(Boolean) as ParsedEmail['to'],
    cc: (message.ccRecipients || []).map(addressOf).filter(Boolean) as ParsedEmail['cc'],
    date: message.receivedDateTime || message.sentDateTime || null,
    text: isHtml ? htmlToText(content) : content,
    html: isHtml ? content : '',
    // Attachment bytes are never pulled: only the fact that some exist reaches the record.
    attachments: message.hasAttachments ? [{ filename: 'attachments in the original message', contentType: 'unknown', sizeBytes: 0, sha256: '' }] : [],
  };
}

export interface SyncResult {
  fetched: number;
  stored: number;
  skipped: number;
  threadsCreated: number;
  removed: number;
  deltaStored: boolean;
  pages: number;
}

/**
 * Pulls new mail into threads.
 *
 * Everything is keyed on Graph's own ids: the conversation id groups a thread, the message id
 * identifies a message. A message already stored is skipped rather than duplicated, so running a
 * sync twice, or resuming after a crash, changes nothing.
 */
export async function syncMailbox(
  ctx: AppContext,
  user: SessionUser,
  connectorId: string,
  fetcher: GraphFetcher,
  opts: { unitId?: string | null; visibility?: 'private' | 'unit'; maxPages?: number; graphHost?: string } = {},
): Promise<SyncResult> {
  const connector = ownedConnector(ctx, user, connectorId);
  if (connector.status !== 'connected') throw badRequest('This mailbox is not connected yet. Authorize it first.');
  if (connector.access !== 'read_only') throw badRequest('Vantage only reads mail. This connector is configured for more than that, which it should not be.');

  const plan = authorizationPlan(connector);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 20, 100));
  const result: SyncResult = { fetched: 0, stored: 0, skipped: 0, threadsCreated: 0, removed: 0, deltaStored: false, pages: 0 };

  let url = connector.delta_token || (opts.graphHost ? `${opts.graphHost}/v1.0/me/messages/delta` : plan.delta_url);
  let deltaLink: string | null = null;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const body = await fetcher(url);
      result.pages += 1;
      for (const message of body.value || []) {
        result.fetched += 1;
        if (message['@removed'] !== undefined) {
          // A message deleted upstream is not deleted here: it is a record of work that happened.
          result.removed += 1;
          continue;
        }
        const stored = storeGraphMessage(ctx, user, connector, message, opts);
        if (stored.stored) result.stored += 1; else result.skipped += 1;
        if (stored.threadCreated) result.threadsCreated += 1;
      }
      if (body['@odata.deltaLink']) { deltaLink = body['@odata.deltaLink']; break; }
      if (!body['@odata.nextLink']) break;
      url = body['@odata.nextLink'];
    }
  } catch (e) {
    ctx.db.prepare("UPDATE connectors SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?")
      .run(String((e as Error).message).slice(0, 500), now(), connector.id);
    record(ctx, 'correspondence.sync', { cloud: connector.cloud, stored: result.stored, skipped: result.skipped, pages: result.pages, failed: true }, { id: user.id });
    throw e;
  }

  // The cursor is only advanced once a run finished, so an interrupted sync repeats rather than skips.
  if (deltaLink) {
    ctx.db.prepare("UPDATE connectors SET delta_token = ?, last_sync_at = ?, last_error = NULL, status = 'connected', updated_at = ? WHERE id = ?")
      .run(deltaLink, now(), now(), connector.id);
    result.deltaStored = true;
  } else {
    ctx.db.prepare('UPDATE connectors SET last_sync_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), connector.id);
  }
  // How much a mailbox brought in, and from which cloud. No subject, no address, no body.
  record(ctx, 'correspondence.sync', { cloud: connector.cloud, stored: result.stored, skipped: result.skipped, pages: result.pages, failed: false }, { id: user.id });
  return result;
}

function storeGraphMessage(
  ctx: AppContext,
  user: SessionUser,
  connector: ConnectorRow,
  message: GraphMessage,
  opts: { unitId?: string | null; visibility?: 'private' | 'unit' },
): { stored: boolean; threadCreated: boolean } {
  return ctx.db.transaction(() => {
    const existing = ctx.db.prepare('SELECT id FROM thread_messages WHERE connector_id = ? AND provider_message_id = ?').get(connector.id, message.id);
    if (existing) return { stored: false, threadCreated: false };

    const conversationId = message.conversationId || message.id;
    let thread = ctx.db.prepare('SELECT * FROM threads WHERE connector_id = ? AND provider_thread_id = ? AND deleted_at IS NULL').get(connector.id, conversationId) as { id: string } | undefined;
    let threadCreated = false;
    const at = now();

    if (!thread) {
      const id = newId();
      ctx.db.prepare(
        `INSERT INTO threads (id, owner_id, unit_id, visibility, subject, state, provider, provider_thread_id, connector_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'response_received', ?, ?, ?, ?, ?)`
      ).run(id, user.id, opts.unitId || null, opts.visibility === 'unit' ? 'unit' : 'private',
        String(message.subject || '(no subject)').slice(0, 500), connector.provider, conversationId, connector.id, at, at);
      thread = { id };
      threadCreated = true;
    }

    storeParsedMessage(ctx, thread.id, toParsed(message), {
      // A message from the account's own mailbox that they sent is outbound; anything else came in.
      direction: 'inbound',
      source: 'graph',
      connectorId: connector.id,
      providerMessageId: message.id,
      createdBy: user.id,
    });
    return { stored: true, threadCreated };
  })();
}

/** Builds a Graph fetcher over a bearer token. The token never leaves this function's closure. */
export function graphFetcher(connector: ConnectorRow, accessToken: string, timeoutMs = 20_000, graphHost: string = MICROSOFT_CLOUDS[connector.cloud].graph): GraphFetcher {
  return async (url: string) => {
    // A URL that is not on this cloud's Graph host is never called: a redirect must not walk a
    // government token onto a commercial endpoint, or anywhere else.
    if (!url.startsWith(`${graphHost}/`)) {
      throw new Error(`Refusing to call ${new URL(url).host}: this connector reads only from ${new URL(graphHost).host}.`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (res.status === 401) throw Object.assign(new Error('Microsoft Graph no longer accepts this connection’s sign-in.'), { reauthorize: true });
      if (!res.ok) throw new Error(`Microsoft Graph answered ${res.status}.`);
      return (await res.json()) as DeltaPage;
    } finally { clearTimeout(timer); }
  };
}

/** The Graph host a connector syncs from on this instance. */
export const graphHostFor = (ctx: AppContext, row: ConnectorRow) => hostsFor(ctx, row.cloud).graph;

export { parseAddresses, getThread };
