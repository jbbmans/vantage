import assert from 'node:assert/strict';
import { parseMaradminFeed } from '../server/maradmins.js';

const xml = `
<rss><channel>
  <item>
    <title><![CDATA[FY26 STAFF SERGEANT PROMOTION SELECTION BOARD RESULTS]]></title>
    <link>https://www.marines.mil/News/Messages/Messages-Display/Article/123/example/</link>
    <description><![CDATA[MARADMIN 403/26 MSGID/GENADMIN/CMC WASHINGTON DC//]]></description>
    <pubDate>Mon, 31 Aug 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>ANNUAL RESERVE TRAINING GUIDANCE</title>
    <link>https://www.marines.mil/News/Messages/Messages-Display/Article/124/example/</link>
    <description>MARADMIN 402/26 MSGID/GENADMIN/</description>
    <pubDate>Sun, 30 Aug 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const rows = parseMaradminFeed(xml);
assert.equal(rows.length, 2);
assert.equal(rows[0].number, '403/26');
assert.ok(rows[0].tags.includes('Promotions'));
assert.ok(rows[0].audience.includes('Enlisted'));
assert.ok(rows[0].summary.toLowerCase().includes('results'));
assert.ok(rows[1].tags.includes('Reserve'));
assert.ok(rows[1].tags.includes('Training & PME'));
assert.equal(rows[0].id, 'maradmin-403-26');
assert.match(rows[0].source_hash, /^[a-f0-9]{64}$/);

console.log('PASS MARADMIN feed parsing, identifiers, summaries, and stable provenance hashes');
