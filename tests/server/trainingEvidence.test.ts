import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { buildZip, readZip } from '../../server/lib/zip.ts';
import { saveSchedule, runDisposition, placeHold, releaseHold, REDACTED } from '../../server/services/retention.ts';
import { cleanFilename, inspectAttachment, attachmentDisposition } from '../../server/services/attachments.ts';
import { EVIDENCE_KINDS, EVIDENCE_KIND_LABELS, ATTACHMENT_LIMITS, cleanDescription, takesEvidenceKind } from '../../shared/attachments.ts';
import { attachmentDetailsSchema } from '../../shared/schemas.ts';

/**
 * Task 19 (ADR-0025): a training holds its evidence as files. Each says what it is and what it shows, beside its name,
 * its type, who added it and when; its content and size are checked on the server; it is exactly as reachable as the
 * training it hangs on; and it keeps all of that through an export, an import, a move and an undo.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** The Marine whose training it is. */
let diaz: { token: string; id: string };
/** An NCO of the unit: reads shared records, changes nobody's. */
let nguyen: { token: string; id: string };
/** An SNCO of the unit: reads shared records and corrects them. */
let reyes: { token: string; id: string };
/** Signed in, in no unit. */
let outsider: { token: string; id: string };
/** Leads another Unit Instance. */
let g1lead: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const entries = (action: string, on: TestApp = app) => on.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;
const stored = (id: string, on: TestApp = app) => on.ctx.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Record<string, any> | undefined;

let n = 0;
/** A new PDF each time: the same file twice on a record is refused as a duplicate. */
const pdf = () => Buffer.from(`%PDF-1.7\n% evidence ${(n += 1)}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40, (n += 1) % 250), Buffer.from('0000000049454e44ae426082', 'hex')]);

interface Upload { kind?: string; description?: string; name?: string; type?: string; body?: Buffer; on?: TestApp; rawDescription?: string }
const attach = (token: string, table: string, id: string, { kind, description, name = 'certificate.pdf', type = 'application/pdf', body, on = app, rawDescription }: Upload = {}) =>
  on.call('POST', `/api/records/${table}/${id}/attachments`, {
    token, raw: body ?? pdf(),
    headers: {
      'content-type': type, 'x-vantage-filename': encodeURIComponent(name),
      ...(kind !== undefined ? { 'x-vantage-evidence-kind': kind } : {}),
      ...(rawDescription !== undefined ? { 'x-vantage-description': rawDescription } : description !== undefined ? { 'x-vantage-description': encodeURIComponent(description) } : {}),
    },
  });
const training = async (token: string, body: Record<string, unknown> = {}, on: TestApp = app) => {
  const res = await on.call('POST', '/api/records/trainings', { token, body: { title: 'Corporals Course', type: 'pme', status: 'completed', date: '2026-05-01', ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
};
const files = (token: string, table: string, id: string, on: TestApp = app) => on.call('GET', `/api/records/${table}/${id}/attachments`, { token });

/** A clean Vantage: the same person signing up again and bringing a personal export in. */
async function bringIn(zip: Buffer) {
  const clean = await startApp();
  try {
    const cop = await clean.setupOperator();
    const me = await clean.register('diaz', { last_name: 'Diaz', first_name: 'Ana', rank_id: 'Cpl' });
    await enroll(clean, cop.token, 'G8', me.id);
    const token = (await clean.login('diaz')).body.token as string;
    const staged = await clean.call('POST', '/api/me/imports', { token, raw: zip, headers: { 'content-type': 'application/zip', 'x-filename': 'vantage-diaz.zip' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 500));
    const done = await clean.call('POST', `/api/me/imports/${staged.body.id}/commit`, { token, body: { profile: 'fill', expected: { new: staged.body.counts.new, update: staged.body.counts.update } } });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 500));
    return { clean, me, token };
  } catch (e) { await clean.close(); throw e; }
}

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  diaz = await app.register('diaz', { last_name: 'Diaz', first_name: 'Ana', rank_id: 'Cpl' });
  nguyen = await app.register('nguyen', { last_name: 'Nguyen', first_name: 'Tri', rank_id: 'Sgt' });
  reyes = await app.register('reyes', { last_name: 'Reyes', first_name: 'Sam', rank_id: 'SSgt' });
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', diaz.id);
  await enroll(app, op.token, 'G8', nguyen.id, 'nco');
  await enroll(app, op.token, 'G8', reyes.id, 'snco');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  // Enrollment revokes sessions so the new authority is picked up.
  diaz.token = await login('diaz');
  nguyen.token = await login('nguyen');
  reyes.token = await login('reyes');
  g1lead.token = await login('g1lead');
});
after(async () => { await app.close(); });

test('the evidence types the database accepts are the ones shared code names, and a description has one limit', () => {
  const schema = readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8');
  const check = /kind\s+TEXT CHECK \(kind IS NULL OR kind IN \(([^)]+)\)\)/.exec(schema);
  assert.ok(check, 'schema.sql checks attachments.kind');
  assert.deepEqual(check![1].split(',').map((k) => k.trim().replace(/'/g, '')), [...EVIDENCE_KINDS]);
  assert.match(schema, new RegExp(`description\\s+TEXT CHECK \\(description IS NULL OR length\\(description\\) <= ${ATTACHMENT_LIMITS.description}\\)`));
  for (const kind of EVIDENCE_KINDS) assert.ok(EVIDENCE_KIND_LABELS[kind], `${kind} has a label`);
  assert.equal(takesEvidenceKind('trainings'), true);
  assert.equal(takesEvidenceKind('activities'), false);

  // The database refuses what the server would, should anything else ever write the table.
  const insert = (id: string, kind: string | null, description: string | null) => app.ctx.db.prepare(`INSERT INTO attachments (id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at, kind, description)
    VALUES (?, 'trainings', 'none', ?, 'x.txt', 'text/plain', 1, ?, ?, ?, ?, ?)`).run(id, op.id, id, Buffer.from('x'), new Date().toISOString(), kind, description);
  assert.throws(() => insert('bad-kind', 'diploma', null), /CHECK/);
  assert.throws(() => insert('bad-desc', 'roster', 'x'.repeat(ATTACHMENT_LIMITS.description + 1)), /CHECK/);
  insert('good', 'roster', 'x'.repeat(ATTACHMENT_LIMITS.description));
  app.ctx.db.prepare("DELETE FROM attachments WHERE id = 'good'").run();
});

test('what may be said about a file: a known type, and one line of plain text', () => {
  const parsed = (v: unknown) => { const r = attachmentDetailsSchema.safeParse(v); return r.success ? r.data : r.error.issues.map((i) => i.path.join('.')); };
  assert.deepEqual(parsed({}), {}, 'a key left out is left as it is');
  assert.deepEqual(parsed({ kind: 'roster', description: '  Class 3-26\r\n graduation   roster ' }), { kind: 'roster', description: 'Class 3-26 graduation roster' });
  assert.deepEqual(parsed({ kind: '', description: '' }), { kind: null, description: null });
  assert.deepEqual(parsed({ kind: 'diploma' }), ['kind']);
  assert.deepEqual(parsed({ kind: 7 }), ['kind']);
  assert.deepEqual(parsed({ description: 'x'.repeat(ATTACHMENT_LIMITS.description + 1) }), ['description']);
  assert.deepEqual(parsed({ description: 'bell\u0007' }), ['description']);
  assert.deepEqual(parsed({ description: ['a'] }), ['description']);
  // Characters that hide or reorder text are dropped, so a description reads as it was typed.
  assert.deepEqual(cleanDescription('Signed\u202E copy\u200B'), { ok: true, value: 'Signed copy' });
  assert.deepEqual(cleanDescription('   '), { ok: true, value: null });
});

test('a training’s file says what it is, and the list shows its type, description, who added it and when', async () => {
  const id = await training(diaz.token);
  const untyped = await attach(diaz.token, 'trainings', id);
  assert.equal(untyped.status, 400, 'a file on a training says what it is');
  assert.equal(untyped.body.fieldErrors.kind, 'Choose what this file is.');
  assert.match(untyped.body.error, /certificate, transcript, completion document, qualification document, roster, other evidence/);
  assert.equal((await attach(diaz.token, 'trainings', id, { kind: 'diploma' })).status, 400);
  assert.equal((await attach(diaz.token, 'trainings', id, { kind: 'certificate', description: 'x'.repeat(ATTACHMENT_LIMITS.description + 1) })).body.fieldErrors.description, `Too long (limit ${ATTACHMENT_LIMITS.description} characters).`);
  assert.equal((await attach(diaz.token, 'trainings', id, { kind: 'certificate', description: 'tab\u0001' })).status, 400);
  assert.equal((await attach(diaz.token, 'trainings', id, { kind: 'certificate', rawDescription: '%E0%A4%A' })).status, 400, 'a description that cannot be decoded is refused, not kept as it came');
  assert.equal((await files(diaz.token, 'trainings', id)).body.attachments.length, 0, 'nothing refused was kept');

  const before = Date.now();
  const up = await attach(diaz.token, 'trainings', id, { kind: 'Certificate', description: 'Signed by the director, Corporals Course 3-26, honor graduate (café)', name: 'Corporals Course 3-26.pdf' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.kind, 'certificate');
  assert.equal(up.body.description, 'Signed by the director, Corporals Course 3-26, honor graduate (café)');
  assert.equal(up.body.original_name, 'Corporals Course 3-26.pdf');
  assert.equal(up.body.mime_type, 'application/pdf');
  assert.equal(up.body.uploaded_by, diaz.id);
  assert.equal(up.body.uploader_name, 'Cpl Diaz');
  assert.ok(Date.parse(up.body.created_at) >= before - 1000);
  assert.equal('content' in up.body, false, 'the list never carries the file');

  const listed = await files(diaz.token, 'trainings', id);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.attachments.map((a: any) => [a.id, a.kind, a.description, a.uploader_name, a.size_bytes, a.sha256.length]), [[up.body.id, 'certificate', up.body.description, 'Cpl Diaz', up.body.size_bytes, 64]]);
  assert.equal(listed.body.enabled, true);
  assert.equal(listed.body.maxPerRecord, 10);
  assert.deepEqual(listed.body.allowedTypes, ['application/pdf', 'image/jpeg', 'image/png', 'text/plain', 'text/csv']);

  // The list of trainings says how much evidence each holds.
  const mine = await get(diaz.token, '/api/records/trainings');
  assert.equal(mine.body.find((t: any) => t.id === id).evidence_count, 1);
  const bare = await training(diaz.token, { title: 'No evidence yet' });
  assert.equal((await get(diaz.token, '/api/records/trainings')).body.find((t: any) => t.id === bare).evidence_count, 0);

  // The trail names the file and what it is, never its name or what was written about it.
  const logged = entries('upload_attachment').at(-1)!;
  assert.equal(logged.entity, 'trainings');
  assert.equal(logged.entity_id, id);
  assert.equal(logged.detail, `attachment ${up.body.id}; ${up.body.size_bytes} bytes; application/pdf; certificate`);
  assert.doesNotMatch(logged.detail, /Signed|Corporals/);

  // Any other record type takes a description, and no evidence type.
  const activity = await post(diaz.token, '/api/records/activities', { title: 'Reconciled the ULO list' });
  assert.equal((await attach(diaz.token, 'activities', activity.body.id, { kind: 'certificate' })).body.fieldErrors.kind, 'Only a training’s files take an evidence type.');
  const plain = await attach(diaz.token, 'activities', activity.body.id, { description: 'The signed sheet' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.kind, null);
  assert.equal(plain.body.description, 'The signed sheet');
});

test('evidence is exactly as reachable as its training: its owner, the unit’s readers, and nobody else', async () => {
  const mine = await training(diaz.token, { title: 'Private course' });
  const kept = await attach(diaz.token, 'trainings', mine, { kind: 'transcript' });
  assert.equal(kept.status, 201);
  const at = (id: string, file: string) => `/api/records/trainings/${id}/attachments/${file}`;

  // A private training's evidence is its owner's alone, whatever anyone leads.
  for (const who of [nguyen, reyes, op, outsider, g1lead]) {
    assert.equal((await files(who.token, 'trainings', mine)).status, 403);
    assert.equal((await get(who.token, at(mine, kept.body.id))).status, 403);
    assert.equal((await put(who.token, at(mine, kept.body.id), { description: 'Mine now' })).status, 403);
    assert.equal((await del(who.token, at(mine, kept.body.id))).status, 403);
    assert.equal((await attach(who.token, 'trainings', mine, { kind: 'roster' })).status, 403);
  }
  assert.equal((await app.call('GET', at(mine, kept.body.id))).status, 401, 'never without a session');
  assert.equal((await app.call('GET', `/api/records/trainings/${mine}/attachments`)).status, 401);

  // Shared with the unit: those who read its shared records read the evidence; those who correct them change it.
  const shared = await training(diaz.token, { title: 'Shared course', visibility: 'unit', unit_id: 'G8' });
  const cert = await attach(diaz.token, 'trainings', shared, { kind: 'certificate', description: 'Completion certificate' });
  assert.equal(cert.status, 201);
  const downloads = entries('download_attachment').length;
  assert.equal((await files(nguyen.token, 'trainings', shared)).body.attachments.length, 1);
  const read = await app.call('GET', at(shared, cert.body.id), { token: nguyen.token, binary: true });
  assert.equal(read.status, 200);
  assert.equal(read.buffer!.length, cert.body.size_bytes);
  // A read of somebody else's evidence is logged against the Marine, and names the file.
  const logged = entries('download_attachment');
  assert.equal(logged.length, downloads + 1);
  assert.deepEqual([logged.at(-1)!.actor_id, logged.at(-1)!.subject_id, logged.at(-1)!.entity_id, logged.at(-1)!.detail], [nguyen.id, diaz.id, shared, `attachment ${cert.body.id}`]);
  assert.equal((await app.call('GET', at(shared, cert.body.id), { token: diaz.token, binary: true })).status, 200);
  assert.equal(entries('download_attachment').length, downloads + 1, 'opening one’s own evidence is not a read of somebody else’s');

  // An NCO reads; only someone who may correct the record adds to it, describes it or removes from it.
  assert.equal((await attach(nguyen.token, 'trainings', shared, { kind: 'roster' })).status, 403);
  assert.equal((await put(nguyen.token, at(shared, cert.body.id), { kind: 'roster' })).status, 403);
  assert.equal((await del(nguyen.token, at(shared, cert.body.id))).status, 403);
  const roster = await attach(reyes.token, 'trainings', shared, { kind: 'roster', description: 'Class roster', name: 'roster.csv', type: 'text/csv', body: Buffer.from('Name,Rank\nDiaz,Cpl\n') });
  assert.equal(roster.status, 201, JSON.stringify(roster.body));
  assert.equal(roster.body.uploader_name, 'SSgt Reyes');
  assert.equal(entries('upload_attachment').at(-1)!.subject_id, diaz.id, 'a leader adding to a Marine’s training is logged against the Marine');
  assert.equal((await put(reyes.token, at(shared, roster.body.id), { description: 'Graduation roster' })).status, 200);
  assert.equal(entries('update_attachment').at(-1)!.subject_id, diaz.id);

  // Nobody outside the unit, and nobody from another Unit Instance, whatever they lead there.
  for (const who of [outsider, g1lead]) {
    assert.equal((await files(who.token, 'trainings', shared)).status, 403);
    assert.equal((await get(who.token, at(shared, cert.body.id))).status, 403);
    assert.equal((await put(who.token, at(shared, cert.body.id), { kind: 'other' })).status, 403);
    assert.equal((await del(who.token, at(shared, cert.body.id))).status, 403);
    assert.equal((await attach(who.token, 'trainings', shared, { kind: 'other' })).status, 403);
  }
  // Refused before the file is read: a caller who may not add one is not made to wait for a large body to be taken in.
  const big = await attach(outsider.token, 'trainings', shared, { kind: 'other', body: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF\n')]) });
  assert.equal(big.status, 403);

  // A file is reached only through the record it hangs on: its id under another record, or another record type, is nothing.
  for (const [table, record] of [['trainings', mine], ['awards', shared], ['activities', shared]] as const) {
    const path = `/api/records/${table}/${record}/attachments/${cert.body.id}`;
    assert.equal((await get(diaz.token, path)).status, 404, `${table}/${record}`);
    assert.equal((await put(diaz.token, path, { description: 'Elsewhere' })).status, 404);
    assert.equal((await del(diaz.token, path)).status, 404);
  }
  assert.equal(stored(cert.body.id)!.description, 'Completion certificate');
  assert.equal(stored(cert.body.id)!.deleted_at, null);

  // Removing one is logged against the Marine and names the file; a removed file is gone from every route.
  assert.equal((await del(reyes.token, at(shared, roster.body.id))).status, 200);
  const removed = entries('delete_attachment').at(-1)!;
  assert.deepEqual([removed.actor_id, removed.subject_id, removed.detail], [reyes.id, diaz.id, `attachment ${roster.body.id}`]);
  assert.equal((await get(diaz.token, at(shared, roster.body.id))).status, 404);
  assert.equal((await put(diaz.token, at(shared, roster.body.id), { description: 'Back?' })).status, 404);
  assert.equal((await del(diaz.token, at(shared, roster.body.id))).status, 404);
  assert.equal((await files(diaz.token, 'trainings', shared)).body.attachments.length, 1);

  // A training in the recycle bin shows no evidence; one frozen when its Marine left the unit keeps it readable and unchanged.
  const frozen = await training(diaz.token, { title: 'Frozen course', visibility: 'unit', unit_id: 'G8' });
  const held = await attach(diaz.token, 'trainings', frozen, { kind: 'qualification' });
  app.ctx.db.prepare('UPDATE trainings SET frozen_at = ? WHERE id = ?').run(new Date().toISOString(), frozen);
  assert.equal((await files(diaz.token, 'trainings', frozen)).body.attachments.length, 1);
  assert.equal((await get(diaz.token, at(frozen, held.body.id))).status, 200);
  for (const who of [diaz, reyes, op]) {
    assert.equal((await attach(who.token, 'trainings', frozen, { kind: 'other' })).status, 403);
    assert.equal((await put(who.token, at(frozen, held.body.id), { kind: 'other' })).status, 403);
    assert.equal((await del(who.token, at(frozen, held.body.id))).status, 403);
  }
  assert.equal((await del(diaz.token, `/api/records/trainings/${mine}`)).status, 200);
  assert.equal((await files(diaz.token, 'trainings', mine)).status, 404);
  assert.equal((await get(diaz.token, at(mine, kept.body.id))).status, 404);
  assert.equal((await put(diaz.token, at(mine, kept.body.id), { kind: 'other' })).status, 404);
});

test('what is said about a file is corrected in place, the file never changes, and the trail says which details changed', async () => {
  const id = await training(diaz.token, { title: 'Details course' });
  const up = await attach(diaz.token, 'trainings', id, { kind: 'certificate', description: 'First wording' });
  const path = `/api/records/trainings/${id}/attachments/${up.body.id}`;
  const was = stored(up.body.id)!;
  const logged = entries('update_attachment').length;

  const changed = await put(diaz.token, path, { kind: 'transcript', description: 'Official transcript, sealed' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual([changed.body.kind, changed.body.description, changed.body.uploader_name], ['transcript', 'Official transcript, sealed', 'Cpl Diaz']);
  const now = stored(up.body.id)!;
  for (const column of ['original_name', 'mime_type', 'size_bytes', 'sha256', 'uploaded_by', 'unit_id', 'created_at', 'record_table', 'record_id']) assert.equal(now[column], was[column], column);
  assert.ok(Buffer.compare(now.content, was.content) === 0, 'the file itself never changes');
  const entry = entries('update_attachment').at(-1)!;
  assert.equal(entry.detail, `attachment ${up.body.id}; changed kind, description; certificate to transcript`);
  assert.doesNotMatch(entry.detail, /Official|sealed|First/);
  assert.equal(entry.subject_id, null, 'one’s own training');

  // The same details again change nothing and log nothing; one key leaves the other as it is.
  assert.equal((await put(diaz.token, path, { kind: 'transcript', description: 'Official transcript, sealed' })).status, 200);
  assert.equal(entries('update_attachment').length, logged + 1);
  assert.equal((await put(diaz.token, path, { description: '' })).body.description, null);
  assert.equal(stored(up.body.id)!.kind, 'transcript');
  assert.equal(entries('update_attachment').at(-1)!.detail, `attachment ${up.body.id}; changed description`);
  assert.equal((await put(diaz.token, path, { kind: 'roster' })).body.description, null);

  // A training's file keeps a type once it has one; nothing else is taken.
  assert.equal((await put(diaz.token, path, { kind: null })).body.fieldErrors.kind, 'Choose what this file is.');
  assert.equal((await put(diaz.token, path, { kind: 'diploma' })).status, 400);
  assert.equal((await put(diaz.token, path, { description: 'x'.repeat(ATTACHMENT_LIMITS.description + 1) })).status, 400);
  assert.equal((await put(diaz.token, path, { original_name: 'renamed.exe', sha256: 'x', uploaded_by: op.id, record_id: 'elsewhere', content: 'x' })).status, 200, 'anything else in the body is not read');
  assert.equal(stored(up.body.id)!.original_name, was.original_name);
  assert.equal(stored(up.body.id)!.uploaded_by, diaz.id);
  assert.equal(stored(up.body.id)!.kind, 'roster');
  assert.equal((await put(diaz.token, `/api/records/trainings/${id}/attachments/no-such-file`, { kind: 'other' })).status, 404);

  // A file on another record type has a description to correct, and no type to be given.
  const activity = await post(diaz.token, '/api/records/activities', { title: 'Briefed the section' });
  const sheet = await attach(diaz.token, 'activities', activity.body.id);
  const sheetPath = `/api/records/activities/${activity.body.id}/attachments/${sheet.body.id}`;
  assert.equal((await put(diaz.token, sheetPath, { kind: 'certificate' })).body.fieldErrors.kind, 'Only a training’s files take an evidence type.');
  assert.equal((await put(diaz.token, sheetPath, { description: 'Sign-in sheet' })).body.description, 'Sign-in sheet');
});

test('a file’s content, type, size and name are checked on the server, and a download is only ever a download', async () => {
  const id = await training(diaz.token, { title: 'Checks course' });
  const up = (o: Upload) => attach(diaz.token, 'trainings', id, { kind: 'other', ...o });

  // The content is the proof of the type, whatever the upload says it is.
  assert.equal((await up({ body: Buffer.from('MZ\u0090\u0000 not a pdf') })).status, 400);
  assert.equal((await up({ body: png(), name: 'scan.pdf' })).status, 400, 'a PNG named and sent as a PDF');
  assert.equal((await up({ body: pdf(), name: 'scan.png', type: 'image/png' })).status, 400);
  assert.equal((await up({ body: pdf(), name: 'tool.exe' })).status, 400);
  assert.equal((await up({ body: pdf(), name: 'page.html', type: 'text/html' })).status, 400);
  assert.equal((await up({ body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'x.svg', type: 'image/svg+xml' })).status, 400);
  assert.equal((await up({ body: Buffer.alloc(0) })).status, 400);
  assert.equal((await up({ body: Buffer.from([0xff, 0xfe, 0x41, 0x00]), name: 'notes.txt', type: 'text/plain' })).status, 400, 'text that is not UTF-8');
  assert.match((await up({ body: Buffer.from('col\u001b[2Jumn'), name: 'notes.txt', type: 'text/plain' })).body.error, /plain text/);
  assert.equal((await files(diaz.token, 'trainings', id)).body.attachments.length, 0);

  // PDF 2.0 is a PDF; a CSV from a machine whose spreadsheet program names the type is still a CSV; a file the browser
  // could not name is read by its filename and then proven the same way.
  const two = await up({ body: Buffer.from('%PDF-2.0\n% transcript\n%%EOF\n'), name: 'transcript.pdf' });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  const csv = await up({ body: Buffer.from('\uFEFFName,Rank\r\nDiaz,Cpl\r\n'), name: 'roster.csv', type: 'application/vnd.ms-excel', kind: 'roster' });
  assert.equal(csv.status, 201, JSON.stringify(csv.body));
  assert.equal(csv.body.mime_type, 'text/csv');
  const unnamed = await up({ body: Buffer.from('Completed 12 May.\fPage two.\n'), name: 'memo.txt', type: 'application/octet-stream' });
  assert.equal(unnamed.status, 201, JSON.stringify(unnamed.body));
  assert.equal(unnamed.body.mime_type, 'text/plain');
  assert.equal((await up({ body: Buffer.from('PK\u0003\u0004 workbook'), name: 'roster.xlsx', type: 'application/vnd.ms-excel' })).status, 400, 'the spreadsheet program’s type is taken for a CSV only');
  assert.equal((await up({ body: Buffer.from('not a pdf at all'), name: 'x.pdf', type: 'application/octet-stream' })).status, 400);
  // The same file twice is one file.
  assert.equal((await up({ body: Buffer.from('%PDF-2.0\n% transcript\n%%EOF\n'), name: 'again.pdf' })).body.code, 'duplicate_attachment');

  // A name is kept as it reads: nothing hidden in it, nothing that reorders it, its extension kept when it is shortened.
  const named = await up({ name: `Corporals\u202E Course\u200B ${'long name '.repeat(20)}.PDF` });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.ok(named.body.original_name.startsWith('Corporals Course long name'));
  assert.ok(named.body.original_name.endsWith('.PDF'));
  assert.ok(named.body.original_name.length <= ATTACHMENT_LIMITS.filename);
  assert.equal(cleanFilename('../../etc/passwd'), 'passwd');
  assert.equal(cleanFilename('a<b>:c?.pdf'), 'a-b--c-.pdf');
  assert.equal(cleanFilename('half\ud83d.pdf'), 'half.pdf');
  const emoji = cleanFilename(`${'😀'.repeat(100)}.png`);
  assert.ok(emoji.endsWith('.png') && emoji.length <= ATTACHMENT_LIMITS.filename);
  assert.doesNotThrow(() => encodeURIComponent(emoji), 'never half a character');
  // The name a download carries: quoted for old clients, and encoded as RFC 8187 asks for the rest.
  assert.equal(attachmentDisposition("Diaz's roster (final).pdf"), `attachment; filename="Diaz's roster (final).pdf"; filename*=UTF-8''Diaz%27s%20roster%20%28final%29.pdf`);
  assert.doesNotThrow(() => attachmentDisposition('half\ud83d name.pdf'));
  const inspect = (body: string, filename: string, contentType: string) => inspectAttachment({ body: Buffer.from(body), filename, contentType, allowedTypes: ['application/pdf', 'text/plain'], maxBytes: 64 });
  assert.equal(inspect('x'.repeat(65), 'a.txt', 'text/plain').ok, false, 'over the size limit');
  assert.equal(inspect('a,b', 'a.csv', 'text/csv').ok, false, 'a type the service does not allow');
  assert.equal(inspect('a,b', 'a.csv', '').ok, false, 'nor by its filename');

  // A download is saved, never shown: its own name, its checked type, and nothing a browser could run as Vantage.
  const text = await app.call('GET', `/api/records/trainings/${id}/attachments/${unnamed.body.id}`, { token: diaz.token, binary: true });
  assert.equal(text.status, 200);
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(text.headers.get('content-disposition'), `attachment; filename="memo.txt"; filename*=UTF-8''memo.txt`);
  assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(text.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.match(text.headers.get('cache-control')!, /no-store/);
  assert.equal(text.buffer!.toString('utf8'), 'Completed 12 May.\fPage two.\n');
  const doc = await app.call('GET', `/api/records/trainings/${id}/attachments/${two.body.id}`, { token: diaz.token, binary: true });
  assert.equal(doc.headers.get('content-type'), 'application/pdf');
  assert.equal(Number(doc.headers.get('content-length')), two.body.size_bytes);
});

test('limits, and attachments turned off for the service or withheld from a Unit Instance', async () => {
  const small = await startApp({ VANTAGE_ATTACHMENT_MAX_BYTES: '4096', VANTAGE_ATTACHMENTS_PER_RECORD: '2' });
  try {
    const owner = await small.setupOperator();
    const id = await training(owner.token, { title: 'Limits course', visibility: 'unit', unit_id: 'G8' }, small);
    const over = await attach(owner.token, 'trainings', id, { kind: 'certificate', on: small, body: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(8192, 0x20), Buffer.from('\n%%EOF\n')]) });
    assert.equal(over.status, 413);
    assert.equal(over.body.code, 'too_large');
    // Who may not add a file is told so before the body is read: the same oversized file from someone outside the unit
    // is refused for who they are (403), never measured (413).
    const stranger = await small.register('stranger');
    const unread = await attach(stranger.token, 'trainings', id, { kind: 'certificate', on: small, body: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(8192, 0x20), Buffer.from('\n%%EOF\n')]) });
    assert.equal(unread.status, 403, JSON.stringify(unread.body));
    const first = await attach(owner.token, 'trainings', id, { kind: 'certificate', on: small });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal((await attach(owner.token, 'trainings', id, { kind: 'transcript', on: small })).status, 201);
    const third = await attach(owner.token, 'trainings', id, { kind: 'roster', on: small });
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'attachment_limit');
    assert.equal((await files(owner.token, 'trainings', id, small)).body.maxPerRecord, 2);

    // Withheld from this Unit Instance (ADR-0014): nothing new is added; what is there stays readable, can be described
    // and can be removed.
    small.ctx.db.prepare("INSERT INTO instance_feature_flags (org_id, flag, reason, set_by, set_at) VALUES ('G8', 'attachments', 'Paused for a records review', ?, ?)").run(owner.id, new Date().toISOString());
    const path = `/api/records/trainings/${id}/attachments/${first.body.id}`;
    const listed = await files(owner.token, 'trainings', id, small);
    assert.equal(listed.body.enabled, false);
    assert.equal(listed.body.attachments.length, 2);
    assert.equal((await small.call('GET', path, { token: owner.token, binary: true })).status, 200);
    assert.equal((await small.call('PUT', path, { token: owner.token, body: { description: 'Still correctable' } })).status, 200);
    assert.equal((await small.call('DELETE', path, { token: owner.token })).status, 200);
    const refused = await attach(owner.token, 'trainings', id, { kind: 'roster', on: small });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'feature_withheld');
  } finally { await small.close(); }

  const off = await startApp({ VANTAGE_ATTACHMENTS_ENABLED: 'false' });
  try {
    const owner = await off.setupOperator();
    const id = await training(owner.token, {}, off);
    assert.equal((await attach(owner.token, 'trainings', id, { kind: 'certificate', on: off })).status, 404);
    assert.equal((await files(owner.token, 'trainings', id, off)).body.enabled, false);
  } finally { await off.close(); }
});

test('evidence keeps its type, description and uploader’s name in exports, and an import brings type and description back', async () => {
  const id = await training(diaz.token, { title: 'Sergeants Course', visibility: 'unit', unit_id: 'G8', date: '2026-03-01' });
  const cert = await attach(diaz.token, 'trainings', id, { kind: 'certificate', description: 'Completion certificate, signed', name: 'sgts-course.pdf' });
  const roster = await attach(reyes.token, 'trainings', id, { kind: 'roster', description: 'Graduation roster', name: 'roster.csv', type: 'text/csv', body: Buffer.from('Name,Rank\nDiaz,Cpl\n') });
  assert.equal(cert.status, 201); assert.equal(roster.status, 201);
  const activity = await post(diaz.token, '/api/records/activities', { title: 'Taught the fiscal class', date: '2026-03-02' });
  const sheet = await attach(diaz.token, 'activities', activity.body.id, { description: 'Sign-in sheet', name: 'sign-in.pdf' });
  assert.equal(sheet.status, 201);
  const byFile = (a: any, b: any) => String(a.original_name).localeCompare(String(b.original_name));

  // One record, by anyone who may read it: each file with what it is, what was written about it and who added it by name.
  const one = await get(nguyen.token, `/api/records/trainings/${id}/export?format=json`);
  assert.equal(one.status, 200);
  assert.deepEqual([...one.body.attachments].sort(byFile).map((a: any) => [a.original_name, a.kind, a.description, a.uploader_label]), [['roster.csv', 'roster', 'Graduation roster', 'SSgt Reyes, Sam'], ['sgts-course.pdf', 'certificate', 'Completion certificate, signed', 'Cpl Diaz, Ana']]);
  assert.equal(one.body.attachments.some((a: any) => 'uploaded_by' in a || 'content' in a), false, 'by name, never by this instance’s id, and never the file in the JSON');
  const zipped = await app.call('GET', `/api/records/trainings/${id}/export?format=zip`, { token: diaz.token, binary: true });
  const inZip = readZip(zipped.buffer!);
  assert.equal(JSON.parse(inZip.get('record.json')!.toString('utf8')).attachments.length, 2);
  assert.equal([...inZip.keys()].filter((k) => k.startsWith('attachments/')).length, 2);

  // Everything one keeps: the JSON and attachments.csv both say what each file is.
  const exported = await app.call('GET', '/api/me/export?format=zip', { token: diaz.token, binary: true });
  assert.equal(exported.status, 200);
  const zip = readZip(exported.buffer!);
  const doc = JSON.parse(zip.get('vantage-export.json')!.toString('utf8'));
  const named = (name: string, recordId: string) => doc.attachments.find((a: any) => a.original_name === name && a.record_id === recordId);
  assert.deepEqual([named('sgts-course.pdf', id).kind, named('sgts-course.pdf', id).description, named('sgts-course.pdf', id).uploader_label], ['certificate', 'Completion certificate, signed', null]);
  assert.deepEqual([named('roster.csv', id).kind, named('roster.csv', id).uploader_label], ['roster', 'SSgt Reyes, Sam']);
  assert.deepEqual([named('sign-in.pdf', activity.body.id).kind, named('sign-in.pdf', activity.body.id).description], [null, 'Sign-in sheet']);
  const sheetCsv = zip.get('attachments.csv')!.toString('utf8');
  for (const column of ['kind', 'description', 'uploader_label', 'original_name', 'mime_type', 'created_at']) assert.ok(sheetCsv.split('\r\n')[0].includes(`"${column}"`), `attachments.csv has ${column}`);
  assert.match(sheetCsv, /Completion certificate, signed/);

  // Brought into a clean Vantage, each file is on its training again and says what it is.
  const first = await bringIn(exported.buffer!);
  try {
    const back = first.clean.ctx.db.prepare(`SELECT a.* FROM attachments a JOIN trainings t ON t.id = a.record_id WHERE a.record_table = 'trainings' AND t.title = 'Sergeants Course' ORDER BY a.original_name`).all() as Array<Record<string, any>>;
    assert.deepEqual(back.map((a) => [a.original_name, a.kind, a.description]), [['roster.csv', 'roster', 'Graduation roster'], ['sgts-course.pdf', 'certificate', 'Completion certificate, signed']]);
    assert.ok(back.every((a) => a.uploaded_by === first.me.id), 'the importer is the uploader here; the export keeps who it first came from');
    const plain = first.clean.ctx.db.prepare(`SELECT kind, description FROM attachments WHERE record_table = 'activities' AND original_name = 'sign-in.pdf'`).get() as Record<string, any>;
    assert.deepEqual([plain.kind, plain.description], [null, 'Sign-in sheet']);
    const listed = await files(first.token, 'trainings', back[0].record_id, first.clean);
    assert.deepEqual(listed.body.attachments.map((a: any) => a.kind).sort(), ['certificate', 'roster']);
  } finally { await first.clean.close(); }

  // A file edited by hand: a type Vantage does not know, a type on a record that takes none, and a description nobody
  // could have typed here are left out. The files still come in.
  named('roster.csv', id).kind = 'diploma';
  named('sgts-course.pdf', id).description = 'x'.repeat(ATTACHMENT_LIMITS.description + 50);
  named('sign-in.pdf', activity.body.id).kind = 'certificate';
  const edited = buildZip([...zip].map(([name, data]) => ({ name, data: name === 'vantage-export.json' ? JSON.stringify(doc) : data })));
  const second = await bringIn(edited);
  try {
    const back = second.clean.ctx.db.prepare(`SELECT a.original_name, a.kind, a.description FROM attachments a WHERE a.original_name IN ('roster.csv', 'sgts-course.pdf', 'sign-in.pdf') AND a.deleted_at IS NULL
      AND a.record_id IN (SELECT id FROM trainings WHERE title = 'Sergeants Course' UNION SELECT id FROM activities WHERE title = 'Taught the fiscal class') ORDER BY a.original_name`).all() as Array<Record<string, any>>;
    assert.deepEqual(back.map((a) => [a.original_name, a.kind, a.description]), [['roster.csv', null, 'Graduation roster'], ['sgts-course.pdf', 'certificate', null], ['sign-in.pdf', null, 'Sign-in sheet']]);
  } finally { await second.clean.close(); }
});

test('a file keeps what is said about it when its entry moves to Training and back', async () => {
  const activity = await post(diaz.token, '/api/records/activities', { title: 'Completed Corporals Course', date: '2026-04-01' });
  const file = await attach(diaz.token, 'activities', activity.body.id, { description: 'Course certificate', name: 'course.pdf' });
  assert.equal(file.status, 201);
  const moved = await post(diaz.token, `/api/records/activities/${activity.body.id}/move`, { to: 'trainings' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const there = await files(diaz.token, 'trainings', moved.body.id);
  // It arrives with its description and no type yet: nothing is guessed from a filename.
  assert.deepEqual(there.body.attachments.map((a: any) => [a.id, a.kind, a.description]), [[file.body.id, null, 'Course certificate']]);
  const path = `/api/records/trainings/${moved.body.id}/attachments/${file.body.id}`;
  assert.equal((await put(diaz.token, path, { description: 'Course certificate, signed' })).status, 200, 'its description is corrected without being made to type it first');
  assert.equal((await put(diaz.token, path, { kind: 'certificate' })).body.kind, 'certificate');
  const undone = await post(diaz.token, `/api/records/trainings/${moved.body.id}/undo-move`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual([stored(file.body.id)!.record_table, stored(file.body.id)!.record_id, stored(file.body.id)!.kind, stored(file.body.id)!.description], ['activities', activity.body.id, 'certificate', 'Course certificate, signed']);
  // Back on an activity it may lose the type it carried, and take no other.
  const back = `/api/records/activities/${activity.body.id}/attachments/${file.body.id}`;
  assert.equal((await put(diaz.token, back, { kind: 'roster' })).status, 400);
  assert.equal((await put(diaz.token, back, { kind: null })).body.kind, null);
});

test('anonymizing a training under a retention schedule removes its evidence, and a dry run removes nothing', async () => {
  const old = new Date(Date.now() - 900 * 86_400_000).toISOString().slice(0, 10);
  const aged = await training(diaz.token, { title: 'Old shared course', visibility: 'unit', unit_id: 'G8', date: old });
  const recent = await training(diaz.token, { title: 'Recent shared course', visibility: 'unit', unit_id: 'G8', date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) });
  const gone = await attach(diaz.token, 'trainings', aged, { kind: 'certificate', description: 'Names the Marine', name: 'Diaz Ana certificate.pdf' });
  const stays = await attach(diaz.token, 'trainings', recent, { kind: 'certificate' });
  assert.equal(gone.status, 201); assert.equal(stays.status, 201);
  saveSchedule(app.ctx, 'G8', { record_type: 'trainings', retain_days: 365, disposition: 'anonymize', enabled: true, authority: 'Unit SOP' }, op.id);
  try {
    const preview = runDisposition(app.ctx, { orgId: 'G8', dryRun: true, actorId: op.id });
    assert.ok(stored(gone.body.id), 'a dry run touches nothing');
    assert.equal(preview.lines.find((l) => l.record_type === 'trainings')!.files, 1, 'and says how many files a run would remove');
    const applied = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    assert.ok(applied.lines.find((l) => l.record_type === 'trainings')!.acted >= 1);
    assert.equal(applied.lines.find((l) => l.record_type === 'trainings')!.files, 1);
    assert.equal((app.ctx.db.prepare('SELECT title FROM trainings WHERE id = ?').get(aged) as { title: string }).title, REDACTED);
    assert.equal(stored(gone.body.id), undefined, 'the certificate that names the Marine goes with the words that did');
    assert.ok(stored(stays.body.id), 'evidence on a training inside its retention period is kept');
    assert.equal((await files(diaz.token, 'trainings', aged)).body.attachments.length, 0);
  } finally {
    saveSchedule(app.ctx, 'G8', { record_type: 'trainings', retain_days: 365, disposition: 'anonymize', enabled: false, authority: 'Unit SOP' }, op.id);
  }
});

test('a training anonymized by an earlier run loses a file it still holds at the next run; a preview counts it and a hold keeps it', async () => {
  const old = new Date(Date.now() - 900 * 86_400_000).toISOString().slice(0, 10);
  const aged = await training(diaz.token, { title: 'Course an earlier run anonymized', visibility: 'unit', unit_id: 'G8', date: old });
  const trainingsLine = (run: ReturnType<typeof runDisposition>) => run.lines.find((l) => l.record_type === 'trainings')!;
  const lastRun = () => app.ctx.db.prepare("SELECT * FROM disposition_runs WHERE org_id = 'G8' AND record_type = 'trainings' ORDER BY rowid DESC LIMIT 1").get() as Record<string, any>;
  saveSchedule(app.ctx, 'G8', { record_type: 'trainings', retain_days: 365, disposition: 'anonymize', enabled: true, authority: 'Unit SOP' }, op.id);
  let hold: { id: string } | null = null;
  try {
    // Anonymized with no file on it. Every run before this release left a record's files in place, and a file can be
    // added to an anonymized record afterwards: either way the record is done and a file is still there.
    runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    assert.equal((app.ctx.db.prepare('SELECT title FROM trainings WHERE id = ?').get(aged) as { title: string }).title, REDACTED);
    const late = await attach(diaz.token, 'trainings', aged, { kind: 'certificate', description: 'Names the Marine', name: 'Diaz Ana certificate.pdf' });
    assert.equal(late.status, 201, JSON.stringify(late.body));

    // A preview finds no record to anonymize and one file to remove, and removes nothing.
    const preview = trainingsLine(runDisposition(app.ctx, { orgId: 'G8', dryRun: true, actorId: op.id }));
    assert.deepEqual([preview.eligible, preview.acted, preview.files], [0, 0, 1]);
    assert.match(lastRun().detail, /; 1 attached file to remove$/);
    assert.ok(stored(late.body.id));

    // A hold on the Marine wins over the schedule for their files as it does for their records.
    hold = placeHold(app.ctx, 'G8', { scope: 'user', subject_id: diaz.id, reason: 'Open inquiry' }, op.id);
    const held = trainingsLine(runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }));
    assert.equal(held.files, undefined);
    assert.ok(stored(late.body.id), 'a held Marine’s file is not touched');
    releaseHold(app.ctx, 'G8', hold.id, op.id);
    hold = null;

    const logged = entries('disposition_run').length;
    const applied = trainingsLine(runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }));
    assert.deepEqual([applied.eligible, applied.acted, applied.files], [0, 0, 1]);
    assert.equal(stored(late.body.id), undefined, 'the file goes, though the record was anonymized before');
    assert.match(lastRun().detail, /; 1 attached file removed$/);
    assert.equal(entries('disposition_run').length, logged + 1, 'a run that removed only files is on the trail');
    assert.match(entries('disposition_run').at(-1)!.detail, /trainings: anonymize 0, 1 files/);

    // Nothing is left for the next run, and a run that does nothing writes no trail entry.
    const again = trainingsLine(runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }));
    assert.deepEqual([again.eligible, again.acted, again.files], [0, 0, undefined]);
    assert.equal(entries('disposition_run').length, logged + 1);
  } finally {
    if (hold) releaseHold(app.ctx, 'G8', hold.id, op.id);
    saveSchedule(app.ctx, 'G8', { record_type: 'trainings', retain_days: 365, disposition: 'anonymize', enabled: false, authority: 'Unit SOP' }, op.id);
  }
});

test('a leader opening a Marine’s page sees how much evidence each shared training holds, where they could open it', async () => {
  const shared = await training(diaz.token, { title: 'Counted course', visibility: 'unit', unit_id: 'G8' });
  assert.equal((await attach(diaz.token, 'trainings', shared, { kind: 'certificate' })).status, 201);
  assert.equal((await attach(diaz.token, 'trainings', shared, { kind: 'transcript' })).status, 201);
  const page = await get(reyes.token, `/api/org/team/${diaz.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
  assert.equal(page.body.trainings.find((t: any) => t.id === shared).evidence_count, 2);
  assert.ok(page.body.trainings.every((t: any) => t.visibility === 'unit'), 'only what the Marine shared');
});
