/**
 * Voices every line in src/script.ts with ElevenLabs, once.
 *
 *   ELEVENLABS_API_KEY=… node tools/voice.mjs            voice anything not yet voiced
 *   node tools/voice.mjs --check                          report what is voiced and what is not
 *
 * Each line is cached under assets/vo/ by a hash of its text, voice, model and settings, so a
 * re-render never pays for a line twice and a changed line is the only one re-voiced. The cache is
 * committed: a render on a machine without the key still has the voice.
 *
 * The request uses the with-timestamps endpoint, so every character comes back with its start and
 * end. That drives the captions and the word-synced type. Neighbouring lines are sent as context
 * (previous_text / next_text), which keeps the delivery continuous across the cuts.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FILMS, VOICE } from '../src/script.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VO = join(ROOT, 'assets', 'vo');
const FFPROBE = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu', 'ffprobe');
mkdirSync(VO, { recursive: true });

export const lineHash = (text) => createHash('sha256')
  .update(JSON.stringify({ text, voice: VOICE.voiceId, model: VOICE.model, settings: VOICE.settings }))
  .digest('hex').slice(0, 16);

/** Characters and their times, folded into words. */
function wordsFrom(alignment) {
  if (!alignment?.characters) return [];
  const { characters: ch, character_start_times_seconds: st, character_end_times_seconds: en } = alignment;
  const words = [];
  let cur = null;
  for (let i = 0; i < ch.length; i++) {
    if (/\s/.test(ch[i])) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { word: '', start: st[i], end: en[i] };
    cur.word += ch[i];
    cur.end = en[i];
  }
  if (cur) words.push(cur);
  return words;
}

function probeSeconds(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const s = Number(String(r.stdout).trim());
  return Number.isFinite(s) ? s : null;
}

async function voiceLine(text, previous, next, key) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE.voiceId}/with-timestamps?output_format=mp3_44100_128`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        text, model_id: VOICE.model, voice_settings: VOICE.settings,
        previous_text: previous || undefined, next_text: next || undefined,
      }),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    // Rate limits and transient errors are retried; anything else is a real refusal and stops the run.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    throw new Error(`ElevenLabs answered ${res.status}: ${body.slice(0, 300)}`);
  }
  throw new Error('ElevenLabs did not answer.');
}

export async function voiceAll({ check = false } = {}) {
  const key = process.env.ELEVENLABS_API_KEY || '';
  const manifest = {};
  let voiced = 0; let cached = 0; let missing = 0;
  for (const film of FILMS) {
    const lines = film.scenes.flatMap((s) => s.lines);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hash = lineHash(line.text);
      const mp3 = join(VO, `${hash}.mp3`);
      const meta = join(VO, `${hash}.json`);
      if (!existsSync(mp3) || !existsSync(meta)) {
        if (check || !key) { missing++; manifest[line.id] = { hash, text: line.text, voiced: false }; continue; }
        const out = await voiceLine(line.text, lines[i - 1]?.text, lines[i + 1]?.text, key);
        writeFileSync(mp3, Buffer.from(out.audio_base64, 'base64'));
        const words = wordsFrom(out.alignment);
        writeFileSync(meta, JSON.stringify({ text: line.text, voice: VOICE.name, model: VOICE.model, words }, null, 1));
        voiced++;
        console.log(`  voiced  ${line.id.padEnd(12)} ${line.text}`);
      } else cached++;
      const info = JSON.parse(readFileSync(meta, 'utf8'));
      manifest[line.id] = { hash, text: line.text, voiced: true, file: `vo/${hash}.mp3`, seconds: probeSeconds(mp3), words: info.words };
    }
  }
  writeFileSync(join(VO, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`voice: ${voiced} voiced now, ${cached} from cache, ${missing} not voiced${!key && missing ? ' (set ELEVENLABS_API_KEY to voice them)' : ''}`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await voiceAll({ check: process.argv.includes('--check') });
}
