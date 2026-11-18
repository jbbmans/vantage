import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILMS, TRAILER } from '../../film/src/script.ts';

/**
 * Task 27, the trailer (ADR-0036): the specification's ten outcomes, in its order, recorded on the product as it ships,
 * on synthetic demo data, and never portraying Vantage as a public SaaS site.
 */

const OUTCOMES = ['Marine dashboard', 'Personnel', 'Records', 'Duty', 'Training', 'FM workflows', 'Error analysis', 'Case guidance', 'Reports', 'Analytics'];
/** What a public SaaS site says: sign-up, prices, trials, hosting it yourself, a public address. */
const SAAS = /vantageusmc|sign[- ]?up|pricing|price|subscri|free trial|self[- ]host|your own network|per seat|buy now|\bwww\.|https?:|\.com\b/i;
const films = JSON.parse(readFileSync('src/config/films.generated.json', 'utf8')) as Record<string, { src: string; poster: string; seconds: number; published: string; textOnly?: boolean; transcript?: string[] }>;
const slots = [...readFileSync('src/config/videos.ts', 'utf8').matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1]);
const onDisk = (address: string) => join('public', address.split('?')[0]);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);

/** An MP4's length, from its movie header (version 0 or 1). */
function mp4Seconds(buf: Buffer): number {
  const at = buf.indexOf('mvhd');
  assert.ok(at > 0, 'the file has a movie header');
  // After the type: version (1 byte), flags (3), creation and modification times, the timescale, then the duration.
  const v = buf[at + 4];
  return v === 1 ? Number(buf.readBigUInt64BE(at + 28)) / buf.readUInt32BE(at + 24) : buf.readUInt32BE(at + 20) / buf.readUInt32BE(at + 16);
}

test('the trailer shows the ten outcomes, in the specification’s order, one scene each, between a title and an end card', () => {
  assert.equal(TRAILER.kind, 'trailer');
  assert.deepEqual(TRAILER.scenes.filter((s) => s.outcome).map((s) => s.outcome), OUTCOMES);
  const ids = TRAILER.scenes.map((s) => s.id);
  assert.ok(ids.indexOf('t-title') < ids.indexOf('t-dashboard') && ids.indexOf('t-analytics') < ids.indexOf('t-end'), 'the outcomes sit between the title and the end card');
  assert.deepEqual(FILMS.filter((f) => f.kind === 'trailer').map((f) => f.id), ['trailer'], 'one trailer');
  for (const gone of ['ad', 'hero', 'tour']) assert.ok(!FILMS.some((f) => f.id === gone), `the ${gone} film is retired`);
});

test('nothing the trailer writes on screen portrays Vantage as a public SaaS site', () => {
  for (const line of TRAILER.scenes.flatMap((s) => s.cards)) assert.doesNotMatch(line, SAAS, line);
  const composition = readFileSync('film/src/trailer/Trailer.tsx', 'utf8');
  // Its code and the words it draws, not the comments that explain why there is no address.
  const code = composition.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, SAAS, 'the composition’s own words');
  // The end card says what the demo banner and the application footer say: synthetic data, not a system of record.
  assert.match(composition, /export const FINE_PRINT = 'Synthetic demo data\. Not an official DoD or USMC system of record\.';/);
  assert.match(code, />Demo data\s*</, 'the application is labelled as demo data the whole time it is on screen');
});

test('the published trailer is the file its address names, with its poster, its length and every line it says', () => {
  const t = films.trailer;
  assert.ok(t, 'the trailer is published');
  for (const address of [t.src, t.poster]) {
    const file = onDisk(address);
    assert.ok(existsSync(file), `${file} is on disk`);
    assert.equal(address.split('?v=')[1], sha(file), `${address} names the file's content`);
  }
  const seconds = mp4Seconds(readFileSync(onDisk(t.src)));
  assert.ok(Math.abs(seconds - t.seconds) <= 1, `the file runs ${seconds.toFixed(1)}s; the index says ${t.seconds}s`);
  assert.ok(t.seconds <= 120, 'under two minutes');
  assert.equal(t.textOnly, true, 'no narration: the words are on screen');
  assert.deepEqual(t.transcript, TRAILER.scenes.flatMap((s) => s.cards.map((c) => c.trim())).filter(Boolean), 'the text alternative is what the film writes, in order');
});

test('every published film lists what it writes on screen, in order, as its text alternative', () => {
  for (const f of FILMS) {
    const published = films[f.slot];
    if (!published) continue;
    assert.equal(published.textOnly, true, `${f.slot} has no narration`);
    assert.deepEqual(published.transcript, f.scenes.flatMap((s) => s.cards.map((c) => c.trim())).filter(Boolean), `${f.slot}'s transcript is its cards`);
  }
});

test('the ad and the tour are retired from the slots, the index and the disk, and every published film has a slot', () => {
  assert.equal(slots[0], 'trailer', 'the trailer leads Starting out');
  for (const gone of ['ad', 'tour']) {
    assert.ok(!slots.includes(gone), `${gone} has no slot`);
    assert.ok(!(gone in films), `${gone} is not published`);
    for (const ext of ['mp4', 'jpg', 'vtt']) assert.ok(!existsSync(join('public', 'videos', 'films', `${gone}.${ext}`)), `${gone}.${ext} is gone`);
  }
  for (const id of Object.keys(films)) assert.ok(slots.includes(id), `${id} is published without a slot`);
});
