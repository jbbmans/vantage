import { createHash } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { hmac } from '../lib/crypto.ts';
import { metaGet, metaSet } from '../db/index.ts';

/**
 * IndexNow is how Bing, and through it Edge's search, DuckDuckGo and Yahoo, plus Yandex, Seznam and
 * Naver, hear that a page changed instead of waiting to recrawl it. The engines confirm a submission by
 * fetching the key from the site itself, so the key is derived from the instance secret: stable across
 * restarts, with no further setting to keep.
 */
export const indexNowKey = (ctx: AppContext) => hmac(ctx.config.secret, 'indexnow-key').slice(0, 32);

/** What the page says, not what its build happened to name its script files. */
const contentVersion = (page: string) => createHash('sha256').update(page.replace(/\/assets\/[^"'\s)]+/g, '')).digest('hex');

export type Announcement = 'sent' | 'unchanged' | 'off' | 'refused';

/** Submits the public page once per version of it, so a deploy that leaves it alone sends nothing. */
export async function announcePublicPage(ctx: AppContext, page: string, fetcher: typeof fetch = fetch): Promise<Announcement> {
  const { search, publicUrl } = ctx.config;
  if (!search.indexNow || !/^https:\/\//.test(publicUrl)) return 'off';
  const version = contentVersion(page);
  if (metaGet(ctx.db, 'indexnow_version') === version) return 'unchanged';
  const key = indexNowKey(ctx);
  const res = await fetcher(search.indexNowEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(publicUrl).host, key, keyLocation: `${publicUrl}/${key}.txt`, urlList: [`${publicUrl}/`] }),
    signal: AbortSignal.timeout(15_000),
  });
  // 202 means accepted while the engine checks the key; anything else is tried again on the next start.
  if (res.status !== 200 && res.status !== 202) return 'refused';
  metaSet(ctx.db, 'indexnow_version', version);
  return 'sent';
}
