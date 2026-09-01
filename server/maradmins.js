import { createHash } from 'node:crypto';
import { config } from './config.js';
import { notifyUser, now } from './db.js';

export const MARADMIN_SOURCE = 'https://www.marines.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=6&Site=481&category=14336&max=50';

const TAG_RULES = [
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

function decode(value = '') {
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

function field(item, name) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return decode(match?.[1] || '');
}

function tagsFor(title) {
  const tags = TAG_RULES.filter(([, pattern]) => pattern.test(title)).map(([tag]) => tag);
  if (/cancellation/i.test(title)) tags.unshift('Cancellation');
  return [...new Set(tags.length ? tags : ['General'])].slice(0, 4);
}

function audienceFor(title) {
  const audience = [];
  if (/enlisted|sergeant|corporal|marine/i.test(title)) audience.push('Enlisted');
  if (/officer|lieutenant|captain|major|colonel|warrant/i.test(title)) audience.push('Officers');
  if (/reserve|smcr|ima|marforres/i.test(title)) audience.push('Reserve Component');
  if (/civilian/i.test(title)) audience.push('Civilians');
  return audience.length ? [...new Set(audience)] : ['All Marines'];
}

function summaryFor(title) {
  if (/^cancellation of/i.test(title)) return 'Cancels or replaces previously issued Marine Corps guidance.';
  if (/results?/i.test(title)) return 'Publishes official results or selections for the subject identified in this message.';
  if (/solicitation|seeks applications|call for participation|nominations?/i.test(title)) {
    return 'Announces an application, nomination, or participation opportunity; review the source for eligibility and deadlines.';
  }
  if (/promotions?/i.test(title)) return 'Publishes promotion information, projected selections, or effective dates.';
  if (/schedule|class dates|roadshow/i.test(title)) return 'Publishes dates, locations, or planning information for an upcoming event or requirement.';
  if (/guidance|implementation|policy|requirement/i.test(title)) return 'Issues or updates Marine Corps policy and execution guidance.';
  if (/award/i.test(title)) return 'Provides an official award, recognition, or eligibility update.';
  return 'Official Marine Corps administrative message. Open the source to review the complete requirements and points of contact.';
}

export function parseMaradminFeed(xml) {
  const records = [];
  for (const match of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = field(item, 'title');
    const url = field(item, 'link');
    const description = field(item, 'description');
    const number = description.match(/MARADMIN(?:\s+CANCELLATION)?\s+(\d{3}\/\d{2})/i)?.[1];
    const published = new Date(field(item, 'pubDate'));
    if (!number || !title || !url || Number.isNaN(published.getTime())) continue;
    const summary = summaryFor(title);
    const tags = tagsFor(title);
    const audience = audienceFor(title);
    records.push({
      id: `maradmin-${number.replace('/', '-')}`,
      number,
      title,
      summary,
      url,
      status: 'Active',
      tags,
      audience,
      published_at: published.toISOString(),
      source_hash: createHash('sha256').update([number, title, url, description].join('\0')).digest('hex'),
    });
  }
  return records;
}

let inFlight = null;

const metaGet = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || null;
const metaSet = (db, key, value) => db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, String(value));

function isFresh(db) {
  const last = Date.parse(metaGet(db, 'maradmin_last_success') || '');
  const refreshMs = Math.max(5, Number(config.maradmins.refresh_minutes) || 30) * 60_000;
  return Number.isFinite(last) && Date.now() - last < refreshMs;
}

async function refresh(db) {
  const response = await fetch(MARADMIN_SOURCE, {
    headers: { accept: 'application/rss+xml, application/xml;q=0.9', 'user-agent': 'VantageUSMC/3.7' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Official feed returned ${response.status}.`);
  const records = parseMaradminFeed(await response.text());
  if (!records.length) throw new Error('Official feed contained no readable MARADMIN entries.');

  const initialized = metaGet(db, 'maradmin_initialized') === '1';
  const known = new Set(db.prepare('SELECT number FROM maradmins').all().map((row) => row.number));
  const inserted = records.filter((row) => !known.has(row.number));
  const fetchedAt = now();
  const upsert = db.prepare(`
    INSERT INTO maradmins
      (id, number, title, summary, url, status, tags, audience, published_at, source_hash, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      url = excluded.url,
      status = excluded.status,
      tags = excluded.tags,
      audience = excluded.audience,
      published_at = excluded.published_at,
      source_hash = excluded.source_hash,
      fetched_at = excluded.fetched_at
  `);

  db.transaction(() => {
    for (const row of records) {
      upsert.run(
        row.id, row.number, row.title, row.summary, row.url, row.status,
        JSON.stringify(row.tags), JSON.stringify(row.audience), row.published_at, row.source_hash, fetchedAt
      );
    }
    metaSet(db, 'maradmin_initialized', '1');
    metaSet(db, 'maradmin_last_success', fetchedAt);
    metaSet(db, 'maradmin_last_error', '');

    if (initialized && inserted.length) {
      const users = db.prepare('SELECT id FROM users WHERE active = 1').all();
      for (const row of inserted) {
        for (const user of users) {
          notifyUser(user.id, {
            kind: 'maradmin',
            title: `New MARADMIN ${row.number}`,
            message: row.title,
            actionUrl: `/maradmins?open=${encodeURIComponent(row.number)}`,
            dedupeKey: `maradmin:${row.number}`,
          });
        }
      }
    }
  })();

  return { updated: records.length, inserted: inserted.length, fetchedAt };
}

export async function syncMaradmins(db, { force = false } = {}) {
  if (!config.maradmins.enabled) return { disabled: true };
  if (!force && isFresh(db)) return { fresh: true, fetchedAt: metaGet(db, 'maradmin_last_success') };
  if (inFlight) return inFlight;
  inFlight = refresh(db)
    .catch((error) => {
      metaSet(db, 'maradmin_last_error', String(error.message || error).slice(0, 300));
      throw error;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function maradminSyncState(db) {
  return {
    enabled: Boolean(config.maradmins.enabled),
    source: 'Official Marines.mil RSS feed',
    lastSuccess: metaGet(db, 'maradmin_last_success'),
    lastError: metaGet(db, 'maradmin_last_error') || null,
    count: db.prepare('SELECT COUNT(*) AS count FROM maradmins').get().count,
  };
}
