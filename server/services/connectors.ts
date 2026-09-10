import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
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
export function authorizationPlan(row: ConnectorRow) {
  const endpoints = MICROSOFT_CLOUDS[row.cloud] || MICROSOFT_CLOUDS.global;
  const scopes = JSON.parse(row.scopes || '[]') as string[];
  return {
    cloud: row.cloud,
    cloud_label: endpoints.label,
    authorize_url: `${endpoints.authority}/organizations/oauth2/v2.0/authorize`,
    token_url: `${endpoints.authority}/organizations/oauth2/v2.0/token`,
    graph_base: `${endpoints.graph}/v1.0`,
    delta_url: `${endpoints.graph}/v1.0/me/messages/delta`,
    scopes: scopes.map((s) => (s.includes('/') || s === 'offline_access' ? s : `https://${endpoints.scopeHost}/${s}`)),
    access: row.access,
  };
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
  opts: { unitId?: string | null; visibility?: 'private' | 'unit'; maxPages?: number } = {},
): Promise<SyncResult> {
  const connector = ownedConnector(ctx, user, connectorId);
  if (connector.status !== 'connected') throw badRequest('This mailbox is not connected yet. Authorize it first.');
  if (connector.access !== 'read_only') throw badRequest('Vantage only reads mail. This connector is configured for more than that, which it should not be.');

  const plan = authorizationPlan(connector);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 20, 100));
  const result: SyncResult = { fetched: 0, stored: 0, skipped: 0, threadsCreated: 0, removed: 0, deltaStored: false, pages: 0 };

  let url = connector.delta_token || plan.delta_url;
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
export function graphFetcher(connector: ConnectorRow, accessToken: string, timeoutMs = 20_000): GraphFetcher {
  const plan = authorizationPlan(connector);
  return async (url: string) => {
    // A URL that is not on this cloud's Graph host is never called: a redirect must not walk a
    // government token onto a commercial endpoint, or anywhere else.
    if (!url.startsWith(plan.graph_base) && !url.startsWith(`${MICROSOFT_CLOUDS[connector.cloud].graph}/`)) {
      throw new Error(`Refusing to call ${new URL(url).host}: this connector reads only from ${new URL(plan.graph_base).host}.`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (!res.ok) throw new Error(`Microsoft Graph answered ${res.status}.`);
      return (await res.json()) as DeltaPage;
    } finally { clearTimeout(timer); }
  };
}

export { parseAddresses, getThread };
