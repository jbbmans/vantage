import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { renderCounselingPdf } from '../../server/lib/pdfCounseling.ts';
import { buildPersonalExport, buildPersonalExportZip } from '../../server/services/personalExport.ts';
import { exportInstance } from '../../server/services/exports.ts';
import { saveSchedule, runDisposition, REDACTED } from '../../server/services/retention.ts';
import { readZip } from '../../server/lib/zip.ts';
import { auditListedRecords } from '../../server/services/audit.ts';
import {
  COUNSELING_STAGES, counselingDocument, counselingOptions, dayOf, documentBand, sessionKindFor, signatureNotes, worksheetBlocks, worksheetFor,
  type CounselingDocument, type CounselingDocumentInput,
} from '../../shared/counseling.ts';

/**
 * Task 20 (ADR-0027): a counseling is structured data. A leader drafts it, may share it with the Marine to review, and
 * finalizes it; once final it changes only by an amendment that keeps what it replaced. The Marine acknowledges the text
 * as it stands. Its NAVMC 2795 worksheet, on screen, in print and as a PDF, is drawn from the stored record and never
 * stored itself. Until it is final it is nobody's but its counselor's (and, shared for review, its Marine's).
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** The Marine counseled: a Corporal, so Figure A-2. */
let diaz: { token: string; id: string };
/** A Lance Corporal: Figure A-1. */
let kim: { token: string; id: string };
/** A Fire Team Leader: counsels, reads shared records, corrects nobody's. The counselor here. */
let lopez: { token: string; id: string };
/** An SNCO: counsels and corrects shared records (Manage records). Never Diaz's counselor in these tests. */
let reyes: { token: string; id: string };
/** An NCO: reads shared records, nothing more. */
let nguyen: { token: string; id: string };
/** Signed in, in no unit. */
let outsider: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const file = (token: string, path: string) => app.call('GET', path, { token, binary: true });
const login = async (username: string) => (await app.login(username)).body.token as string;
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
const auditSince = (seq: number) => app.ctx.db.prepare('SELECT action, actor_id, subject_id, entity_id, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; actor_id: string; subject_id: string | null; entity_id: string | null; detail: string | null }>;
const lastAction = () => (app.ctx.db.prepare('SELECT action FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { action: string }).action;
const lastDetail = (action: string) => (app.ctx.db.prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as { detail: string }).detail;
const noticesFor = (userId: string, id: string) => app.ctx.db.prepare('SELECT title, dedupe_key FROM notifications WHERE user_id = ? AND dedupe_key LIKE ? ORDER BY created_at, rowid').all(userId, `%${id}%`) as Array<{ title: string; dedupe_key: string }>;
const stored = (id: string) => app.ctx.db.prepare('SELECT * FROM counselings WHERE id = ?').get(id) as Record<string, any>;
const day = (n: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Whether the PDF draws this text, from PDFKit's hex-encoded strings in its compressed content streams. */
const pdfDraws = (pdf: Buffer, text: string) => {
  const hex = Buffer.from(text, 'latin1').toString('hex');
  const raw = pdf.toString('latin1');
  for (let at = raw.indexOf('stream\n'); at !== -1; at = raw.indexOf('stream\n', at)) {
    const end = raw.indexOf('endstream', at);
    try { if (inflateSync(pdf.subarray(at + 7, end)).toString('latin1').replace(/>\s*-?[\d.]+\s*</g, '').toLowerCase().includes(hex)) return true; } catch { /* not a compressed stream */ }
    at = end + 9;
  }
  return false;
};
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

/** A counseling Lopez writes for Diaz, shared with the unit; a draft unless the test asks otherwise. */
async function written(body: Record<string, unknown> = {}, token = lopez.token, about = diaz.id) {
  const res = await post(token, '/api/records/counselings', {
    user_id: about, type: 'quarterly', date: day(-3), summary: 'Discussed the reconciliation backlog and the close-out timeline.',
    strengths: 'Owned the UMT clean-up without being asked.', improvements: 'Brief the section chief before a deadline slips.',
    goals_set: 'Clear the remaining 2-Way UMTs by the end of the month.', follow_up_date: day(27), visibility: 'unit', unit_id: 'G8', stage: 'draft', ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
const finalize = async (c: Record<string, any>, token = lopez.token) => {
  const res = await post(token, `/api/records/counselings/${c.id}/finalize`, { version: c.version });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as Record<string, any>;
};

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  diaz = await app.register('diaz', { last_name: 'Diaz', first_name: 'Ana', rank_id: 'Cpl', mos: '3451' });
  kim = await app.register('kim', { last_name: 'Kim', first_name: 'Joon', rank_id: 'LCpl', mos: '3451' });
  lopez = await app.register('lopez', { last_name: 'Lopez', first_name: 'Maria', rank_id: 'Sgt' });
  reyes = await app.register('reyes', { last_name: 'Reyes', first_name: 'Sam', rank_id: 'SSgt' });
  nguyen = await app.register('nguyen', { last_name: 'Nguyen', first_name: 'Linh', rank_id: 'Cpl' });
  outsider = await app.register('outsider', { last_name: 'Outsider', rank_id: 'Sgt' });
  await enroll(app, op.token, 'G8', diaz.id);
  await enroll(app, op.token, 'G8', kim.id);
  await enroll(app, op.token, 'G8', lopez.id, 'fire-team-leader');
  await enroll(app, op.token, 'G8', reyes.id, 'snco');
  await enroll(app, op.token, 'G8', nguyen.id, 'nco');
  diaz.token = await login('diaz'); kim.token = await login('kim'); lopez.token = await login('lopez');
  reyes.token = await login('reyes'); nguyen.token = await login('nguyen'); outsider.token = await login('outsider');
});

after(async () => { await app.close(); });

test('the workflow rule: who may do what, at each stage', () => {
  const none = { counselor: false, manager: false, subject: false };
  const row = (stage: string, extra: Record<string, unknown> = {}) => ({ user_id: 'm', counselor_id: 'c', stage, ...extra });
  assert.deepEqual([...COUNSELING_STAGES], ['draft', 'review', 'final']);
  assert.deepEqual(counselingOptions({ ...none, counselor: true }, row('draft'), true), { edit: true, share: true, withdraw: false, finalize: true, amend: false, acknowledge: false });
  assert.deepEqual(counselingOptions({ ...none, counselor: true }, row('review'), true), { edit: true, share: false, withdraw: true, finalize: true, amend: false, acknowledge: false });
  assert.deepEqual(counselingOptions({ ...none, counselor: true }, row('final'), false), { edit: false, share: false, withdraw: false, finalize: false, amend: true, acknowledge: false });
  assert.deepEqual(counselingOptions({ ...none, manager: true }, row('final'), false), { edit: false, share: false, withdraw: false, finalize: false, amend: true, acknowledge: false });
  assert.deepEqual(counselingOptions({ ...none, subject: true }, row('final'), false), { edit: false, share: false, withdraw: false, finalize: false, amend: false, acknowledge: true });
  assert.equal(counselingOptions({ ...none, subject: true }, row('final', { acknowledged_at: 'x' }), false).acknowledge, false, 'acknowledged once is enough');
  assert.equal(counselingOptions({ ...none, subject: true }, row('review'), false).acknowledge, false, 'a draft in review is not acknowledged');
  assert.equal(counselingOptions({ ...none, counselor: true }, row('final', { frozen_at: 'x' }), false).amend, false, 'a frozen counseling stays as it is');
  // A Marine's own notes: edited as any record, with no workflow.
  assert.deepEqual(counselingOptions({ ...none, subject: true }, { user_id: 'm', counselor_id: null, stage: 'final' }, true), { edit: true, share: false, withdraw: false, finalize: false, amend: false, acknowledge: false });

  assert.equal(worksheetFor('E-1'), 'A-1');
  assert.equal(worksheetFor('E-3'), 'A-1');
  assert.equal(worksheetFor('E-4'), 'A-2');
  assert.equal(worksheetFor('O-3'), 'A-2');
  assert.equal(worksheetFor(null), 'A-2', 'a Marine whose grade is unknown takes the Corporal-and-above worksheet');
  assert.equal(sessionKindFor('initial'), 'ics');
  assert.equal(sessionKindFor('quarterly'), 'follow_on');
  assert.equal(sessionKindFor('event'), 'event');
  assert.equal(sessionKindFor('other'), null);
  // "Areas to improve" has no block of its own on either worksheet: it goes, labelled, where the guide asks for comments.
  const a1 = worksheetBlocks('A-1', { summary: 'S', strengths: 'G', improvements: 'I', goals_set: 'T' });
  assert.deepEqual(a1.map((b) => b.label), ['Tasks Assigned Next Period', 'Subjects on Which Guidance Was Provided', 'Major Accomplishments and/or Comments']);
  assert.deepEqual(a1[2].parts, [{ label: 'Major accomplishments', text: 'G' }, { label: 'Areas to improve', text: 'I' }]);
  const a2 = worksheetBlocks('A-2', { summary: 'S', strengths: 'G', goals_set: 'T' });
  assert.deepEqual(a2.map((b) => b.label), ['Agenda/Subjects Discussed', 'Major Accomplishments', 'Targets for Coming Period and/or Comments']);
  assert.deepEqual(a2[2].parts, [{ label: null, text: 'T' }], 'no label when there is nothing beside it');
  assert.equal(documentBand({ stage: 'draft', revision: 1, current_revision: 1, superseded_at: null }), 'DRAFT - NOT FINAL');
  assert.equal(documentBand({ stage: 'review', revision: 1, current_revision: 1, superseded_at: null }), 'DRAFT FOR REVIEW - NOT FINAL');
  assert.equal(documentBand({ stage: 'final', revision: 1, current_revision: 1, superseded_at: null }), null);
  assert.equal(documentBand({ stage: 'final', revision: 2, current_revision: 2, superseded_at: null }), 'AMENDED - REVISION 2');
  assert.equal(documentBand({ stage: 'final', revision: 1, current_revision: 3, superseded_at: '2026-11-02T10:00:00.000Z' }), 'REVISION 1 OF 3 - REPLACED BY AN AMENDMENT ON 2026-11-02');
  // Its dates are days where it was generated, as its "generated on" is: 04:00 UTC on the 13th is still the 12th in Chicago.
  assert.equal(dayOf('2026-11-13T04:00:00.000Z', 'America/Chicago'), '2026-11-12');
  assert.equal(dayOf('2026-11-13T04:00:00.000Z', null), '2026-11-13');
  assert.equal(dayOf('2026-11-13T04:00:00.000Z', 'Not/AZone'), '2026-11-13');
  assert.equal(documentBand({ stage: 'final', revision: 1, current_revision: 2, superseded_at: '2026-11-13T04:00:00.000Z', generated: { zone: 'America/Chicago' } }), 'REVISION 1 OF 2 - REPLACED BY AN AMENDMENT ON 2026-11-12');
  assert.equal(signatureNotes({ own_notes: false, stage: 'final', acknowledgement: { at: '2026-11-13T04:00:00.000Z', due: false }, finalized: { at: '2026-11-13T03:00:00.000Z', by: 'Sgt Lopez, Maria' }, generated: { zone: 'America/Chicago' } }).counselor, 'Finalized in Vantage on 2026-11-12 by Sgt Lopez, Maria.');
});

test('a draft is its counselor’s alone: nobody else reads, counts or hears of it', async () => {
  const seq = lastSeq();
  const c = await written();
  assert.equal(c.stage, 'draft');
  assert.equal(c.revision, 1);
  assert.equal(c.finalized_at, null);
  assert.deepEqual(c.workflow, { edit: true, share: true, withdraw: false, finalize: true, amend: false, acknowledge: false });
  assert.match(c.subject_name, /Diaz/);
  assert.deepEqual(auditSince(seq).filter((e) => e.action === 'create').map((e) => e.detail), ['counseling draft']);
  assert.deepEqual(noticesFor(diaz.id, c.id), [], 'the Marine is not told of a draft');

  const path = `/api/records/counselings/${c.id}`;
  assert.ok((await get(lopez.token, '/api/records/counselings')).body.some((r: any) => r.id === c.id), 'its counselor works from it');
  for (const who of [diaz, reyes, nguyen, op, outsider]) {
    assert.ok(!(await get(who.token, '/api/records/counselings')).body.some((r: any) => r.id === c.id), 'not in anyone else’s list');
    for (const p of [path, `${path}/worksheet`, `${path}/revisions`, `${path}/export?format=pdf`, `${path}/export?format=json`, `${path}/comments`]) {
      assert.equal((await get(who.token, p)).status, 404, `${p} is no such record to anyone else`);
    }
    for (const action of ['share', 'withdraw', 'finalize', 'amend', 'acknowledge']) {
      assert.equal((await post(who.token, `${path}/${action}`, { version: c.version, reason: 'x', summary: 'x' })).status, 404, `nor can ${action} reach it`);
    }
    assert.equal((await put(who.token, path, { summary: 'Rewritten', version: c.version })).status, 404);
    assert.equal((await del(who.token, path)).status, 404);
  }
  // Not on the Marine's page, to them or to a leader who did not write it; on it for its counselor.
  assert.ok(!(await get(diaz.token, `/api/org/team/${diaz.id}`)).body.counselings.some((r: any) => r.id === c.id));
  assert.ok(!(await get(reyes.token, `/api/org/team/${diaz.id}`)).body.counselings.some((r: any) => r.id === c.id));
  assert.ok((await get(lopez.token, `/api/org/team/${diaz.id}`)).body.counselings.some((r: any) => r.id === c.id));
  // Not in the Marine's timeline, their own export, or the sources of their own report.
  const timeline = await get(diaz.token, '/api/record/timeline?period=all');
  assert.equal(timeline.status, 200, JSON.stringify(timeline.body));
  assert.ok(!JSON.stringify(timeline.body).includes(c.id));
  assert.ok(!buildPersonalExport(app.ctx, diaz.id).records.counselings.some((r: any) => r.id === c.id));
  assert.ok(buildPersonalExport(app.ctx, lopez.id).records.counselings.some((r: any) => r.id === c.id), 'its counselor keeps what they wrote');
  const studio = await post(diaz.token, '/api/studio/reports', { title: 'Quarterly input', period_start: day(-30), period_end: day(1) });
  assert.equal(studio.status, 201, JSON.stringify(studio.body));
  assert.ok(!(await get(diaz.token, `/api/studio/reports/${studio.body.id}`)).body.sources.some((s: any) => s.id === c.id));

  // Its counselor edits it freely, still against the version they read.
  const edited = await put(lopez.token, path, { summary: 'Discussed the backlog, the close-out timeline and the GTCC delinquency.', version: c.version });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await put(lopez.token, path, { summary: 'Stale', version: c.version })).status, 409);
  // A stage is not set by an edit.
  await put(lopez.token, path, { stage: 'final', version: edited.body.version });
  assert.equal(stored(c.id).stage, 'draft');
  // A draft goes to its counselor's recycle bin, not the Marine's, and comes back.
  assert.equal((await del(lopez.token, path)).status, 200);
  assert.ok((await get(lopez.token, '/api/records/counselings?deleted=1')).body.some((r: any) => r.id === c.id));
  assert.ok(!(await get(diaz.token, '/api/records/counselings?deleted=1')).body.some((r: any) => r.id === c.id));
  assert.equal((await post(lopez.token, `${path}/restore`)).status, 200);

  // Nor does the trail tell the Marine of it: what its counselor did to the draft is kept, but not under its Marine.
  await get(lopez.token, `${path}/worksheet?purpose=print`);
  assert.equal((await file(lopez.token, `${path}/export?format=pdf`)).status, 200);
  for (const who of [diaz, reyes, nguyen]) assert.equal((await get(who.token, `${path}/attachments`)).status, 404, 'its files are no such record either');
  const onIt = app.ctx.db.prepare("SELECT action, subject_id FROM audit_log WHERE entity = 'counselings' AND entity_id = ?").all(c.id) as Array<{ action: string; subject_id: string | null }>;
  assert.ok(onIt.length >= 6, JSON.stringify(onIt));
  assert.deepEqual(onIt.filter((e) => e.subject_id), [], 'no entry on a draft names its Marine');
  assert.ok(!(await get(diaz.token, '/api/me/audit')).body.some((e: any) => e.entity_id === c.id), 'not in their access log');
  assert.ok(!buildPersonalExport(app.ctx, diaz.id).audit_trail.some((e: any) => e.entity_id === c.id), 'nor in their export’s trail');
  assert.ok(buildPersonalExport(app.ctx, lopez.id).audit_trail.some((e: any) => e.entity_id === c.id), 'its counselor’s trail keeps what they did');
  const listed = lastSeq();
  auditListedRecords(app.ctx, lopez.id, 'counselings', [stored(c.id)]);
  assert.deepEqual(auditSince(listed), [], 'listing their own draft is not a listing of the Marine’s records');

  // An import naming the draft's id finds nothing of theirs there: no "Yours: …" with the draft's words.
  const staged = await app.call('POST', '/api/me/imports', { token: diaz.token, raw: Buffer.from(JSON.stringify({ format: 'vantage-personal/1', profile: { id: diaz.id }, records: { counselings: [{ id: c.id, user_id: diaz.id, type: 'monthly', date: day(-1), summary: 'My notes from the session.' }] } })), headers: { 'content-type': 'application/json', 'x-filename': 'mine.json' } });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.ok(!JSON.stringify(staged.body).includes('backlog'), 'the draft’s words are not in the review');
  assert.ok(staged.body.rows.every((r: any) => !r.duplicateOf && r.outcome !== 'present'), JSON.stringify(staged.body.rows));
  assert.equal((await del(diaz.token, `/api/me/imports/${staged.body.id}`)).status, 200);
});

test('shared for review, its Marine reads it and answers in its comments; the unit still does not', async () => {
  const c = await written();
  const path = `/api/records/counselings/${c.id}`;
  assert.equal((await post(lopez.token, `${path}/share`, { version: c.version + 1 })).status, 409, 'against the version its counselor read');
  assert.equal((await post(lopez.token, `${path}/share`, {})).status, 400);
  const seq = lastSeq();
  const shared = await post(lopez.token, `${path}/share`, { version: c.version });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal(shared.body.stage, 'review');
  assert.deepEqual(shared.body.workflow, { edit: true, share: false, withdraw: true, finalize: true, amend: false, acknowledge: false });
  assert.deepEqual(auditSince(seq).map((e) => [e.action, e.detail, e.subject_id]), [['counseling_shared', 'draft shared with the Marine for review', diaz.id]]);
  assert.deepEqual(noticesFor(diaz.id, c.id).map((n) => n.title), ['Counseling draft to review']);
  assert.equal((await post(lopez.token, `${path}/share`, { version: shared.body.version })).status, 409, 'shared once');

  const read = await get(diaz.token, path);
  assert.equal(read.status, 200);
  assert.equal(read.body.stage, 'review');
  assert.deepEqual(read.body.workflow, { edit: false, share: false, withdraw: false, finalize: false, amend: false, acknowledge: false });
  assert.match(read.body.counselor_display, /Lopez/);
  const ack = await post(diaz.token, `${path}/acknowledge`, { version: shared.body.version });
  assert.equal(ack.status, 409, 'nothing to acknowledge until it is final');
  assert.equal(ack.body.code, 'counseling_stage');
  assert.equal((await put(diaz.token, path, { summary: 'Rewritten by the Marine', version: shared.body.version })).status, 403);
  const worksheet = await get(diaz.token, `${path}/worksheet`);
  assert.equal(worksheet.status, 200);
  assert.equal(worksheet.body.stage, 'review');
  assert.equal(documentBand(worksheet.body), 'DRAFT FOR REVIEW - NOT FINAL');

  // The Marine answers in its comments, and its counselor hears it.
  const answer = await post(diaz.token, `${path}/comments`, { body: 'Can we add the GTCC follow-up to the targets?' });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const heard = app.ctx.db.prepare('SELECT title FROM notifications WHERE user_id = ? AND dedupe_key = ?').get(lopez.id, `comment-owner:${answer.body.id}:${lopez.id}`) as { title: string } | undefined;
  assert.match(heard?.title ?? '', /counseling you wrote/);
  for (const who of [reyes, nguyen, op]) {
    assert.equal((await get(who.token, path)).status, 404, 'the unit reads it once it is final');
    assert.equal((await get(who.token, `${path}/comments`)).status, 404);
  }
  assert.ok(!(await get(reyes.token, `/api/org/team/${diaz.id}`)).body.counselings.some((r: any) => r.id === c.id));
  assert.ok((await get(diaz.token, `/api/org/team/${diaz.id}`)).body.counselings.some((r: any) => r.id === c.id), 'on the Marine’s own page while in review');

  // Its counselor takes it back: the Marine no longer reads it, and is not told of what is said on it.
  const back = await post(lopez.token, `${path}/withdraw`, { version: shared.body.version });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.stage, 'draft');
  assert.equal(lastAction(), 'counseling_withdrawn');
  assert.equal((await get(diaz.token, path)).status, 404);
  assert.equal((await post(diaz.token, `${path}/comments`, { body: 'Still there?' })).status, 404);
  const later = await post(lopez.token, `${path}/comments`, { body: 'Reworking the targets, @diaz.' });
  assert.equal(later.status, 201);
  assert.deepEqual(JSON.parse(String((app.ctx.db.prepare('SELECT mentions FROM comments WHERE id = ?').get(later.body.id) as { mentions: string }).mentions)), [], 'a mention does not reach a Marine who cannot read the draft');
  assert.ok(!app.ctx.db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND dedupe_key LIKE ?').get(diaz.id, `%${later.body.id}%`));
  assert.equal((await post(lopez.token, `${path}/withdraw`, { version: back.body.version })).status, 409, 'withdrawn once');

  // A frozen counseling stays as it is: its counselor does not take it back from the Marine either.
  const held = await written({ stage: 'review' });
  app.ctx.db.prepare('UPDATE counselings SET frozen_at = ? WHERE id = ?').run(new Date().toISOString(), held.id);
  const frozen = await post(lopez.token, `/api/records/counselings/${held.id}/withdraw`, { version: held.version });
  assert.equal(frozen.status, 403, JSON.stringify(frozen.body));
  assert.equal(frozen.body.code, 'counseling_frozen');
  assert.equal(stored(held.id).stage, 'review');
});

test('a counseling shared for review on creation tells its Marine; one finalized on creation needs a date', async () => {
  const shared = await written({ stage: 'review' });
  assert.equal(shared.stage, 'review');
  assert.deepEqual(noticesFor(diaz.id, shared.id).map((n) => n.dedupe_key), [`counseling:${shared.id}:review:1`]);
  const undated = await post(lopez.token, '/api/records/counselings', { user_id: diaz.id, type: 'event', summary: 'No date on it.', visibility: 'unit', unit_id: 'G8' });
  assert.equal(undated.status, 400, 'a counseling another Marine writes is final at once unless they say otherwise, and a final one is dated');
  assert.ok(undated.body.fieldErrors?.date);
  const legacy = await post(lopez.token, '/api/records/counselings', { user_id: diaz.id, type: 'event', date: day(-1), summary: 'Written final, as before.', visibility: 'unit', unit_id: 'G8' });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.stage, 'final');
  assert.equal(legacy.body.finalized_by, lopez.id);
  assert.ok(legacy.body.finalized_at);
  assert.deepEqual(noticesFor(diaz.id, legacy.body.id).map((n) => [n.title, n.dedupe_key]), [['New counseling recorded', `counseling:${legacy.body.id}`]]);
  // A Marine's own notes are always final, whatever they ask, and stay theirs to edit.
  const own = await post(diaz.token, '/api/records/counselings', { summary: 'My notes from the quarterly session.', stage: 'draft' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.stage, 'final');
  assert.equal(own.body.counselor_id, null);
  for (const action of ['share', 'withdraw', 'finalize', 'amend', 'acknowledge']) {
    const res = await post(diaz.token, `/api/records/counselings/${own.body.id}/${action}`, { version: own.body.version, reason: 'x', summary: 'x' });
    assert.equal(res.status, 400, action);
    assert.equal(res.body.code, 'own_notes');
  }
  assert.equal((await put(diaz.token, `/api/records/counselings/${own.body.id}`, { summary: 'My notes, corrected.', version: own.body.version })).status, 200);
  const sheet = await get(diaz.token, `/api/records/counselings/${own.body.id}/worksheet`);
  assert.equal(sheet.body.own_notes, true);
  assert.ok(sheet.body.notices.some((n: string) => /own notes/.test(n)));
  assert.equal(sheet.body.acknowledgement.due, false);
  // An unknown stage is refused, not guessed.
  assert.equal((await post(lopez.token, '/api/records/counselings', { user_id: diaz.id, date: day(-1), summary: 'x', stage: 'pending' })).status, 400);
});

test('finalizing stamps who and when, keeps the particulars as they stood, and tells the Marine then', async () => {
  const undated = await written({ date: null });
  const refused = await post(lopez.token, `/api/records/counselings/${undated.id}/finalize`, { version: undated.version });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.fieldErrors?.date, 'a counseling is dated before it is final');

  const c = await written();
  const path = `/api/records/counselings/${c.id}`;
  assert.equal((await post(lopez.token, `${path}/finalize`, { version: c.version + 3 })).status, 409);
  const seq = lastSeq();
  const final = await finalize(c);
  assert.equal(final.stage, 'final');
  assert.equal(final.revision, 1);
  assert.equal(final.finalized_by, lopez.id);
  assert.deepEqual(final.workflow, { edit: false, share: false, withdraw: false, finalize: false, amend: true, acknowledge: false });
  assert.deepEqual(auditSince(seq).map((e) => [e.action, e.detail]), [['counseling_finalized', 'from draft; revision 1']]);
  assert.deepEqual(noticesFor(diaz.id, c.id).map((n) => n.title), ['New counseling recorded']);
  const particulars = JSON.parse(stored(c.id).particulars);
  assert.deepEqual(particulars.subject, { name: 'Diaz, Ana', rank: 'Cpl', grade: 'E-4', mos: '3451', billet: null, unit: 'G-8 Comptroller' });
  assert.deepEqual(particulars.counselor, { name: 'Lopez, Maria', rank: 'Sgt' });
  assert.equal((await post(lopez.token, `${path}/finalize`, { version: final.version })).status, 409, 'final once');
  assert.equal((await post(lopez.token, `${path}/withdraw`, { version: final.version })).status, 409);

  // Now the unit reads it, and nobody rewrites or deletes it in place.
  assert.equal((await get(reyes.token, path)).status, 200);
  assert.equal((await get(nguyen.token, path)).status, 200);
  assert.equal((await get(outsider.token, path)).status, 403);
  for (const who of [lopez, reyes, diaz]) {
    assert.equal((await put(who.token, path, { summary: 'Rewritten', version: final.version })).status, 403);
    assert.equal((await del(who.token, path)).status, 403);
  }
  assert.equal((await put(lopez.token, path, { unit_id: null, visibility: 'private', version: final.version })).status, 403, 'nor re-placed');

  // The Marine is promoted afterwards: the worksheet still says what they were when it was finalized.
  app.ctx.db.prepare("UPDATE users SET rank_id = 'Sgt' WHERE id = ?").run(diaz.id);
  try {
    const sheet = await get(diaz.token, `${path}/worksheet`);
    assert.equal(sheet.body.particulars.subject.rank, 'Cpl');
    assert.equal(sheet.body.particulars_as_of, 'finalized');
    assert.equal(sheet.body.worksheet.key, 'A-2');
    const draft = await written({}, reyes.token);
    assert.equal((await get(reyes.token, `/api/records/counselings/${draft.id}/worksheet`)).body.particulars.subject.rank, 'Sgt', 'a draft shows them as they are now');
  } finally { app.ctx.db.prepare("UPDATE users SET rank_id = 'Cpl' WHERE id = ?").run(diaz.id); }
});

test('the Marine acknowledges the text they read, once; the counselor is told', async () => {
  const final = await finalize(await written());
  const path = `/api/records/counselings/${final.id}`;
  assert.equal((await post(lopez.token, `${path}/acknowledge`, { version: final.version })).status, 403, 'only the Marine acknowledges');
  assert.equal((await post(reyes.token, `${path}/acknowledge`, { version: final.version })).status, 403);
  assert.equal((await post(diaz.token, `${path}/acknowledge`, {})).status, 400, 'bound to a version');
  const stale = await post(diaz.token, `${path}/acknowledge`, { version: final.version - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  const seq = lastSeq();
  const ack = await post(diaz.token, `${path}/acknowledge`, { version: final.version });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.ok(ack.body.acknowledged_at);
  assert.equal(ack.body.workflow.acknowledge, false);
  const again = await post(diaz.token, `${path}/acknowledge`, { version: ack.body.version });
  assert.equal(again.status, 200);
  assert.equal(again.body.acknowledged_at, ack.body.acknowledged_at, 'saying it again changes nothing');
  assert.deepEqual(auditSince(seq).map((e) => [e.action, e.detail]), [['acknowledge_counseling', 'revision 1']]);
  assert.deepEqual(noticesFor(lopez.id, final.id).map((n) => [n.title, n.dedupe_key]), [['Counseling acknowledged', `counseling:${final.id}:ack:1`]]);
});

test('an amendment keeps what it replaced, why and by whom; the Marine acknowledges the amended text', async () => {
  const c = await finalize(await written({ summary: 'Original summary of the session.' }));
  const path = `/api/records/counselings/${c.id}`;
  const ack = await post(diaz.token, `${path}/acknowledge`, { version: c.version });
  assert.equal(ack.status, 200);

  // Who may amend: its counselor, or a records manager of the unit it is shared with. Never the Marine.
  const self = await post(diaz.token, `${path}/amend`, { version: ack.body.version, summary: 'Mine now', reason: 'I disagree' });
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'counseling_subject');
  const reader = await post(nguyen.token, `${path}/amend`, { version: ack.body.version, summary: 'Corrected', reason: 'Typo' });
  assert.equal(reader.status, 403);
  assert.equal(reader.body.code, 'counseling_counselor_only');
  assert.equal((await post(outsider.token, `${path}/amend`, { version: ack.body.version, summary: 'x', reason: 'x' })).status, 403);
  // What an amendment needs: a reason, a change, and the version the amender read.
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version, summary: 'Corrected summary.' })).status, 400);
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version, summary: 'Corrected summary.', reason: '   ' })).status, 400);
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version, summary: 'Original summary of the session.', reason: 'No change' })).status, 400);
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version, date: null, reason: 'Undate it' })).status, 400, 'a final counseling stays dated');
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version - 1, summary: 'Corrected summary.', reason: 'Stale' })).status, 409);
  assert.equal((await post(lopez.token, `${path}/amend`, { version: ack.body.version, summary: 'x', reason: 'r'.repeat(1001) })).status, 400);

  const seq = lastSeq();
  const first = await post(lopez.token, `${path}/amend`, { version: ack.body.version, summary: 'Corrected summary of the session.', follow_up_date: day(40), reason: 'Wrong follow-up date, and the summary named the wrong section.' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.revision, 2);
  assert.equal(first.body.acknowledged_at, null, 'the Marine acknowledges the amended text afresh');
  assert.equal(first.body.summary, 'Corrected summary of the session.');
  assert.deepEqual(auditSince(seq).map((e) => [e.action, e.detail]), [['counseling_amended', 'counselor amendment; revision 2; changed: summary, follow_up_date; acknowledgement cleared']]);
  assert.deepEqual(noticesFor(diaz.id, c.id).map((n) => n.title).slice(-1), ['Counseling amended']);

  // A records manager amends too, and its counselor hears of it.
  const second = await post(reyes.token, `${path}/amend`, { version: first.body.version, goals_set: 'Clear the UMTs and close the GTCC delinquency.', reason: 'Added the target agreed at the session.' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.revision, 3);
  assert.equal(lastDetail('counseling_amended'), 'manager amendment; revision 3; changed: goals_set');
  assert.ok(noticesFor(lopez.id, c.id).some((n) => n.title === 'A counseling you wrote was amended'));

  // The history, newest first: what each revision said, whether the Marine had acknowledged it, who and why.
  const history = await get(diaz.token, `${path}/revisions`);
  assert.equal(history.status, 200);
  assert.equal(history.body.revision, 3);
  assert.deepEqual(history.body.revisions.map((r: any) => [r.revision, r.changed, r.reason]), [
    [2, ['goals_set'], 'Added the target agreed at the session.'],
    [1, ['summary', 'follow_up_date'], 'Wrong follow-up date, and the summary named the wrong section.'],
  ]);
  assert.equal(history.body.revisions[1].content.summary, 'Original summary of the session.');
  assert.equal(history.body.revisions[1].acknowledged_at, ack.body.acknowledged_at, 'the first text was acknowledged before it was replaced');
  assert.equal(history.body.revisions[0].acknowledged_at, null);
  assert.match(history.body.revisions[0].amended_by_name, /Reyes/);
  assert.equal((await get(lopez.token, `${path}/revisions`)).body.revisions[1].amended_by_name, 'You');
  const seen = lastSeq();
  assert.equal((await get(reyes.token, `${path}/revisions`)).status, 200);
  assert.deepEqual(auditSince(seen).map((e) => [e.action, e.detail, e.subject_id]), [['view_record', 'amendment history', diaz.id]]);

  // An earlier revision prints from what it said, marked as replaced; one that never was is no such revision.
  const old = await get(diaz.token, `${path}/worksheet?revision=1`);
  assert.equal(old.status, 200);
  assert.equal(old.body.revision, 1);
  assert.equal(old.body.current_revision, 3);
  assert.ok(old.body.blocks.some((b: any) => b.parts.some((p: any) => p.text === 'Original summary of the session.')));
  assert.match(documentBand(old.body)!, /^REVISION 1 OF 3 - REPLACED BY AN AMENDMENT ON \d{4}-\d{2}-\d{2}$/);
  assert.equal(old.body.acknowledgement.due, false);
  const current = await get(diaz.token, `${path}/worksheet`);
  assert.equal(documentBand(current.body), 'AMENDED - REVISION 3');
  assert.equal(current.body.amendments.length, 2);
  assert.equal(current.body.acknowledgement.due, true);
  for (const r of ['0', '4', 'x', '1.5']) assert.equal((await get(diaz.token, `${path}/worksheet?revision=${r}`)).status, 404, r);

  // The Marine acknowledges revision 3; nothing was lost on the way.
  const ack3 = await post(diaz.token, `${path}/acknowledge`, { version: second.body.version });
  assert.equal(ack3.status, 200);
  assert.equal(lastDetail('acknowledge_counseling'), 'revision 3');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM counseling_revisions WHERE counseling_id = ?').get(c.id) as { n: number }).n, 2);
  // The history is append-only, in the database too.
  assert.throws(() => app.ctx.db.prepare("UPDATE counseling_revisions SET reason = 'Rewritten' WHERE counseling_id = ?").run(c.id));
  assert.throws(() => app.ctx.db.prepare('UPDATE counseling_revisions SET amended_by = ? WHERE counseling_id = ?').run(diaz.id, c.id));
  // And no word of the counseling or of a reason is in the audit trail or a notification.
  const trail = JSON.stringify(app.ctx.db.prepare('SELECT detail FROM audit_log WHERE entity_id = ?').all(c.id));
  const told = JSON.stringify(app.ctx.db.prepare('SELECT title, message FROM notifications WHERE dedupe_key LIKE ?').all(`%${c.id}%`));
  for (const words of ['Original summary', 'Corrected summary', 'GTCC', 'Wrong follow-up', 'agreed at the session']) {
    assert.ok(!trail.includes(words), `audit: ${words}`);
    assert.ok(!told.includes(words), `notification: ${words}`);
  }
});

test('a counselor who no longer counsels the Marine reads what they wrote but no longer moves it', async () => {
  const draft = await written();
  const final = await finalize(await written());
  const grant = app.ctx.db.prepare("SELECT * FROM member_roles WHERE user_id = ? AND role_id = 'G8:fire-team-leader'").get(lopez.id) as Record<string, unknown>;
  assert.ok(grant);
  app.ctx.db.prepare("DELETE FROM member_roles WHERE user_id = ? AND role_id = 'G8:fire-team-leader'").run(lopez.id);
  try {
    const read = await get(lopez.token, `/api/records/counselings/${final.id}`);
    assert.equal(read.status, 200, 'its counselor still reads it');
    assert.equal(read.body.workflow.amend, false);
    assert.equal((await post(lopez.token, `/api/records/counselings/${final.id}/amend`, { version: final.version, summary: 'Late correction.', reason: 'x' })).status, 403);
    assert.equal((await post(lopez.token, `/api/records/counselings/${draft.id}/share`, { version: draft.version })).status, 403);
    assert.equal((await post(lopez.token, `/api/records/counselings/${draft.id}/finalize`, { version: draft.version })).status, 403);
    assert.equal((await get(lopez.token, `/api/records/counselings/${final.id}/worksheet?purpose=print`)).status, 200, 'and prints it');
    // A records manager of its unit still corrects it.
    assert.equal((await post(reyes.token, `/api/records/counselings/${final.id}/amend`, { version: final.version, summary: 'Corrected by the SNCO.', reason: 'The counselor has moved on.' })).status, 200);
  } finally {
    app.ctx.db.prepare('INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(grant.user_id, grant.role_id, grant.unit_id, grant.granted_by ?? null, grant.created_at);
  }
});

test('the worksheet follows NAVMC 2795: Figure A-1 or A-2 by grade, no SSN, its handling marking, never stored', async () => {
  const forKim = await finalize(await written({ summary: 'Weapons cleaning and the duty roster.' }, lopez.token, kim.id));
  const a1 = await get(kim.token, `/api/records/counselings/${forKim.id}/worksheet`);
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  assert.equal(a1.body.form, 'vantage-counseling/1');
  assert.equal(a1.body.worksheet.key, 'A-1');
  assert.equal(a1.body.worksheet.caption, 'COUNSELING WORKSHEET - LANCE CORPORAL AND BELOW');
  assert.deepEqual(a1.body.blocks.map((b: any) => b.key), ['tasks', 'subjects', 'accomplishments']);
  assert.equal(a1.body.session_kind, 'follow_on');
  assert.equal(a1.body.marking, 'Working paper');
  assert.match(a1.body.source, /NAVMC 2795.*Figure A-1.*Not an official form/);
  assert.ok(a1.body.notices.some((n: string) => /para 3005\.1\.i/.test(n)));
  assert.ok(a1.body.notices.some((n: string) => /No SSN/.test(n)));
  assert.equal(JSON.stringify(a1.body).match(/\b\d{3}-?\d{2}-?\d{4}\b/), null);

  const forDiaz = await finalize(await written({ type: 'initial', summary: 'Initial counseling: expectations and the section SOP.' }));
  const a2 = await get(diaz.token, `/api/records/counselings/${forDiaz.id}/worksheet`);
  assert.equal(a2.body.worksheet.key, 'A-2');
  assert.equal(a2.body.session_kind, 'ics');
  assert.deepEqual(a2.body.blocks.map((b: any) => b.label), ['Agenda/Subjects Discussed', 'Major Accomplishments', 'Targets for Coming Period and/or Comments']);

  // The PDF, rendered when asked and never kept: Letter, the guide's caption, the marking, no SSN, nobody's name in its file name.
  const filesBefore = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n;
  const seq = lastSeq();
  const res = await file(reyes.token, `/api/records/counselings/${forDiaz.id}/export?format=pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="vantage-counseling-${forDiaz.id.slice(0, 8)}-r1.pdf"`);
  const pdf = res.buffer!;
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 612 792\]/);
  assert.ok(pdfDraws(pdf, 'COUNSELING WORKSHEET - CORPORAL AND ABOVE'));
  assert.ok(pdfDraws(pdf, 'Figure A-2 layout. Not an official form.'));
  assert.ok(pdfDraws(pdf, 'Working paper'), 'the handling marking');
  assert.ok(pdfDraws(pdf, 'Initial counseling: expectations and the section SOP.'));
  assert.ok(pdfDraws(pdf, 'Agenda/Subjects Discussed'));
  assert.ok(pdfDraws(pdf, 'Marine Counseled'));
  assert.ok(pdfDraws(pdf, 'The SSN block on the worksheet is left out: Vantage does not record or print an SSN.'));
  assert.ok(!pdf.toString('latin1').includes('Diaz'), 'nobody’s name in its document info');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n, filesBefore, 'nothing stored');
  assert.deepEqual(auditSince(seq).map((e) => [e.action, e.detail, e.subject_id]), [['export_record', 'pdf; revision 1', diaz.id]]);
  // A Lance Corporal's prints Figure A-1.
  assert.ok(pdfDraws((await file(kim.token, `/api/records/counselings/${forKim.id}/export?format=pdf`)).buffer!, 'COUNSELING WORKSHEET - LANCE CORPORAL AND BELOW'));
  // The Unit Instance's own marking replaces the default.
  const marking = app.ctx.runtime.reportMarking;
  app.ctx.runtime.reportMarking = 'CUI';
  try { assert.ok(pdfDraws((await file(diaz.token, `/api/records/counselings/${forDiaz.id}/export?format=pdf`)).buffer!, 'CUI')); }
  finally { app.ctx.runtime.reportMarking = marking; }
  // Outside the unit, no PDF.
  assert.equal((await file(outsider.token, `/api/records/counselings/${forDiaz.id}/export?format=pdf`)).status, 403);

  // Printing and reading it are in the trail; the Marine reading their own is not a read of anyone's record.
  const since = lastSeq();
  assert.equal((await get(reyes.token, `/api/records/counselings/${forDiaz.id}/worksheet`)).status, 200);
  assert.equal((await get(reyes.token, `/api/records/counselings/${forDiaz.id}/worksheet?purpose=print`)).status, 200);
  assert.equal((await get(diaz.token, `/api/records/counselings/${forDiaz.id}/worksheet`)).status, 200);
  assert.equal((await get(diaz.token, `/api/records/counselings/${forDiaz.id}/worksheet?purpose=print`)).status, 200);
  assert.deepEqual(auditSince(since).map((e) => [e.action, e.actor_id === diaz.id ? 'diaz' : 'reyes', e.detail, e.subject_id]), [
    ['view_record', 'reyes', 'worksheet; revision 1', diaz.id],
    ['print_counseling', 'reyes', 'revision 1', diaz.id],
    ['print_counseling', 'diaz', 'revision 1', null],
  ]);

  // A draft prints as one, and says so in its file name.
  const draft = await written();
  const draftPdf = await file(lopez.token, `/api/records/counselings/${draft.id}/export?format=pdf`);
  assert.equal(draftPdf.status, 200);
  assert.match(draftPdf.headers.get('content-disposition')!, /-r1-draft\.pdf"$/);
  assert.ok(pdfDraws(draftPdf.buffer!, 'DRAFT - NOT FINAL'));
});

test('the PDF renders the same document the same way, and long words flow onto more pages, never cut', async () => {
  const input = (summary: string): CounselingDocumentInput => ({
    id: '0123456789abcdef', version: 3, stage: 'final', revision: 2, current_revision: 2, own_notes: false,
    content: { date: '2026-11-01', type: 'quarterly', summary, strengths: 'Steady.', improvements: 'Delegate more.', goals_set: 'Close the backlog.', follow_up_date: '2026-12-01' },
    particulars: { subject: { name: 'Diaz, Ana', rank: 'Cpl', grade: 'E-4', mos: '3451', billet: 'Fiscal clerk', unit: 'G-8 Comptroller' }, counselor: { name: 'Lopez, Maria', rank: 'Sgt' } },
    particulars_as_of: 'finalized', finalized: { at: '2026-11-01T15:00:00.000Z', by: 'Sgt Lopez, Maria' }, acknowledged_at: null,
    amendments: [{ revision: 2, at: '2026-11-02T10:00:00.000Z', by: 'SSgt Reyes, Sam', reason: 'Wrong date.', changed: ['Date'], acknowledged_at: '2026-11-01T18:00:00.000Z' }],
    amendments_total: 1, superseded_at: null, marking: 'Working paper', generated: { on: '2026-11-13', by: 'Sgt Lopez, Maria' },
  });
  const doc: CounselingDocument = counselingDocument(input('A short summary.'));
  const one = await renderCounselingPdf(doc);
  const two = await renderCounselingPdf(doc);
  assert.ok(one.equals(two), 'deterministic: the same record renders the same bytes');
  assert.ok(pdfDraws(one, 'AMENDED - REVISION 2'));
  assert.ok(pdfDraws(one, 'Amendment history (1)'));
  assert.ok(pdfDraws(one, 'Why: Wrong date.'));

  const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i + 1} of the counseling, every one of them kept.`).join(' ');
  const longPdf = await renderCounselingPdf(counselingDocument(input(long)));
  assert.ok(pages(longPdf) >= 3, `flows onto more pages (${pages(longPdf)})`);
  assert.ok(pdfDraws(longPdf, 'Sentence 400 of the counseling'));
  assert.ok(pdfDraws(longPdf, `Page ${pages(longPdf)} of ${pages(longPdf)}`), 'every page numbered of the whole');
});

test('anonymizing a counseling takes its words, its particulars and its history’s words; its shape stays', async () => {
  const c = await finalize(await written({ date: '2010-01-04', summary: 'Long-ago words.' }));
  const amended = await post(lopez.token, `/api/records/counselings/${c.id}/amend`, { version: c.version, summary: 'Long-ago words, corrected.', reason: 'Long-ago reason.' });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  saveSchedule(app.ctx, 'G8', { record_type: 'counselings', retain_days: 3650, disposition: 'anonymize', enabled: true, authority: 'Unit SOP' }, op.id);
  try {
    runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    const row = stored(c.id);
    assert.equal(row.summary, REDACTED);
    assert.equal(row.particulars, REDACTED);
    assert.equal(row.revision, 2, 'which revision it is stays');
    const kept = app.ctx.db.prepare('SELECT content, reason, changed, revision FROM counseling_revisions WHERE counseling_id = ?').get(c.id) as Record<string, unknown>;
    assert.deepEqual({ ...kept }, { content: REDACTED, reason: REDACTED, changed: 'summary', revision: 1 });
    const sheet = await get(reyes.token, `/api/records/counselings/${c.id}/worksheet`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.particulars.subject.name, REDACTED, 'nobody is named on it, not even as they are now');
    assert.equal(sheet.body.particulars.counselor, null);
    assert.equal(sheet.body.amendments[0].reason, REDACTED);
    assert.equal(sheet.body.amendments[0].by, null);
    assert.ok(!JSON.stringify(sheet.body).includes('Long-ago'));
    const history = await get(diaz.token, `/api/records/counselings/${c.id}/revisions`);
    assert.equal(history.body.revisions[0].reason, REDACTED);
    assert.equal(history.body.revisions[0].content.summary, REDACTED);
    assert.equal((await post(lopez.token, `/api/records/counselings/${c.id}/amend`, { version: stored(c.id).version, summary: 'Again', reason: 'x' })).status, 403, 'an anonymized counseling stays as it is');
  } finally {
    saveSchedule(app.ctx, 'G8', { record_type: 'counselings', retain_days: 3650, disposition: 'anonymize', enabled: false, authority: 'Unit SOP' }, op.id);
  }
});

test('its history leaves with it: in the instance export and the Marine’s own export, and only for counselings they hold', async () => {
  const c = await finalize(await written({ summary: 'Exported words.' }));
  const amended = await post(lopez.token, `/api/records/counselings/${c.id}/amend`, { version: c.version, summary: 'Exported words, amended.', reason: 'Exported reason.' });
  assert.equal(amended.status, 200);
  const draft = await written({ summary: 'A draft that stays the counselor’s.' });

  const instance = exportInstance(app.ctx);
  assert.ok((instance.tables.counseling_revisions as Array<Record<string, unknown>>).some((r) => r.counseling_id === c.id));
  assert.ok((instance.tables.counselings as Array<Record<string, unknown>>).some((r) => r.id === draft.id && r.stage === 'draft'), 'an instance export keeps every stage');

  const mine = buildPersonalExport(app.ctx, diaz.id);
  assert.ok(mine.records.counselings.some((r: any) => r.id === c.id));
  assert.ok(!mine.records.counselings.some((r: any) => r.id === draft.id));
  const kept = (mine.counseling_revisions as Array<Record<string, any>>).find((r) => r.counseling_id === c.id)!;
  assert.ok(kept, 'its history is in the Marine’s export');
  assert.equal(kept.content.fields.summary, 'Exported words.');
  assert.equal(kept.reason, 'Exported reason.');
  assert.match(String(kept.amended_by), /Lopez/);
  const zip = readZip(buildPersonalExportZip(app.ctx, diaz.id).buffer);
  assert.ok([...zip.keys()].some((name) => name.endsWith('counseling-revisions.csv')));
  const counselor = buildPersonalExport(app.ctx, lopez.id);
  assert.equal((counselor.counseling_revisions as Array<Record<string, any>>).find((r) => r.counseling_id === c.id)!.amended_by, 'me');
  assert.ok(counselor.records.counselings.some((r: any) => r.id === draft.id));
});
