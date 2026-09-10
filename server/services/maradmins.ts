import { createHash } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { now } from '../lib/ids.ts';
import { notify } from './notifications.ts';

const TAG_RULES: Array<[string, RegExp]> = [
  ['Promotions', /promotion|selection board|selected for/i],
  ['Career', /assignment|retention|reenlist|lateral move|career|billet/i],
  ['Training & PME', /training|course|education|school|seminar|class dates|pme/i],
  ['Awards', /award|medal|decoration|recognition/i],
  ['Reserve', /reserve|smcr|ima|marforres/i],
  ['Pay & Benefits', /bonus|pay|allowance|compensation|travel|benefit/i],
  ['Policy', /policy|guidance|implementation|requirement/i],
  ['Uniforms', /uniform|wear of/i],
  ['Readiness', /readiness|fitness|pft|cft|medical|vaccine/i],
  ['Safety', /safety|hazard|threat|health/i],
  ['Technology', /cyber|information|software|network|artificial intelligence|digital/i],
  ['Logistics', /logistic|supply|equipment|maintenance|fuel/i],
  ['Legal', /legal|law|justice|court|equal opportunity/i],
  ['Operations', /operation|mission|deployment|exercise|force design/i],
  ['Personnel', /manpower|personnel|marine corps total force system/i],
];

function decode(value = ''): string {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const field = (item: string, name: string) => decode(item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');

function tagsFor(title: string): string[] {
  const tags = TAG_RULES.filter(([, p]) => p.test(title)).map(([t]) => t);
  if (/cancellation/i.test(title)) tags.unshift('Cancellation');
  return [...new Set(tags.length ? tags : ['General'])].slice(0, 4);
}

function audienceFor(title: string): string[] {
  const a: string[] = [];
  if (/enlisted|sergeant|corporal|marine/i.test(title)) a.push('Enlisted');
  if (/officer|lieutenant|captain|major|colonel|warrant/i.test(title)) a.push('Officers');
  if (/reserve|smcr|ima|marforres/i.test(title)) a.push('Reserve Component');
  if (/civilian/i.test(title)) a.push('Civilians');
  return a.length ? [...new Set(a)] : ['All Marines'];
}

function summaryFor(title: string): string {
  if (/^cancellation of/i.test(title)) return 'Cancels or replaces previously issued Marine Corps guidance.';
  if (/results?/i.test(title)) return 'Publishes official results or selections for the subject identified in this message.';
  if (/solicitation|seeks applications|call for participation|nominations?/i.test(title)) return 'Announces an application, nomination, or participation opportunity; review the source for eligibility and deadlines.';
  if (/promotions?/i.test(title)) return 'Publishes promotion information, projected selections, or effective dates.';
  if (/schedule|class dates|roadshow/i.test(title)) return 'Publishes dates, locations, or planning information for an upcoming event or requirement.';
  if (/guidance|implementation|policy|requirement/i.test(title)) return 'Issues or updates Marine Corps policy and execution guidance.';
  if (/award/i.test(title)) return 'Provides an official award, recognition, or eligibility update.';
  return 'Official Marine Corps administrative message. Open the source to review the complete requirements and points of contact.';
}

export interface MaradminRecord { id: string; number: string; title: string; summary: string; url: string; tags: string[]; audience: string[]; published_at: string; source_hash: string }

export function parseMaradminFeed(xml: string): MaradminRecord[] {
  const records: MaradminRecord[] = [];
  for (const match of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = field(item, 'title');
    const url = field(item, 'link');
    const description = field(item, 'description');
    const number = description.match(/MARADMIN(?:\s+CANCELLATION)?\s+(\d{3}\/\d{2})/i)?.[1] || title.match(/\b(\d{3}\/\d{2})\b/)?.[1];
    const published = new Date(field(item, 'pubDate'));
    if (!number || !title || !url || Number.isNaN(published.getTime())) continue;
    records.push({
      id: `maradmin-${number.replace('/', '-')}`, number, title, summary: summaryFor(title), url, tags: tagsFor(title), audience: audienceFor(title),
      published_at: published.toISOString(), source_hash: createHash('sha256').update([number, title, url, description].join('\0')).digest('hex'),
    });
  }
  return records;
}

let inFlight: Promise<{ updated: number; inserted: number; fetchedAt: string }> | null = null;

function isFresh(ctx: AppContext) {
  const last = Date.parse(metaGet(ctx.db, 'maradmin_last_success') || '');
  return Number.isFinite(last) && Date.now() - last < ctx.config.maradmins.refreshMinutes * 60_000;
}

export function upsertMaradmins(ctx: AppContext, records: MaradminRecord[]) {
  const initialized = metaGet(ctx.db, 'maradmin_initialized') === '1';
  const known = new Set((ctx.db.prepare('SELECT number FROM maradmins').all() as Array<{ number: string }>).map((r) => r.number));
  const inserted = records.filter((r) => !known.has(r.number));
  const fetchedAt = now();
  const upsert = ctx.db.prepare(`INSERT INTO maradmins (id, number, title, summary, url, tags, audience, published_at, source_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET title = excluded.title, summary = excluded.summary, url = excluded.url, tags = excluded.tags, audience = excluded.audience, published_at = excluded.published_at, source_hash = excluded.source_hash, fetched_at = excluded.fetched_at`);
  ctx.db.transaction(() => {
    for (const r of records) upsert.run(r.id, r.number, r.title, r.summary, r.url, JSON.stringify(r.tags), JSON.stringify(r.audience), r.published_at, r.source_hash, fetchedAt);
    metaSet(ctx.db, 'maradmin_initialized', '1');
    metaSet(ctx.db, 'maradmin_last_success', fetchedAt);
    metaSet(ctx.db, 'maradmin_last_error', '');
    if (initialized && inserted.length) {
      const users = ctx.db.prepare('SELECT id FROM users WHERE active = 1').all() as Array<{ id: string }>;
      for (const r of inserted.slice(0, 10)) for (const u of users) notify(ctx, u.id, { kind: 'maradmin', title: `New MARADMIN ${r.number}`, message: r.title, actionUrl: `/maradmins?open=${encodeURIComponent(r.number)}`, dedupeKey: `maradmin:${r.number}` });
    }
  })();
  return { updated: records.length, inserted: inserted.length, fetchedAt };
}

async function refresh(ctx: AppContext) {
  const response = await fetch(ctx.config.maradmins.source, { headers: { accept: 'application/rss+xml, application/xml;q=0.9', 'user-agent': 'Vantage/5' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Official feed returned ${response.status}.`);
  const records = parseMaradminFeed(await response.text());
  if (!records.length) throw new Error('Official feed contained no readable MARADMIN entries.');
  return upsertMaradmins(ctx, records);
}

export async function syncMaradmins(ctx: AppContext, { force = false } = {}) {
  if (!ctx.runtime.maradminsEnabled) return { disabled: true } as const;
  if (!force && isFresh(ctx)) return { fresh: true, fetchedAt: metaGet(ctx.db, 'maradmin_last_success') } as const;
  if (inFlight) return inFlight;
  inFlight = refresh(ctx)
    .catch((error: Error) => { metaSet(ctx.db, 'maradmin_last_error', String(error.message || error).slice(0, 300)); throw error; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function maradminSyncState(ctx: AppContext) {
  return {
    enabled: ctx.runtime.maradminsEnabled, source: 'Official Marines.mil RSS feed',
    lastSuccess: metaGet(ctx.db, 'maradmin_last_success'), lastError: metaGet(ctx.db, 'maradmin_last_error') || null,
    count: (ctx.db.prepare('SELECT COUNT(*) AS n FROM maradmins').get() as { n: number }).n,
  };
}
