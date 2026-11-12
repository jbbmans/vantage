import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { scopeFor, type Scope } from '../authz/scope.ts';
import { HttpError, badRequest } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { getItem, readable, mayClaim, mayReassign, claimItem, releaseItem } from './work.ts';
import { handOff, handoffCandidates } from './cases.ts';
import { replayedWorkRequest } from './workRequests.ts';
import { BULK_WORK_LIMIT, type BulkWorkInput, type BulkWorkResponse, type BulkWorkResult, type HandoffCandidate } from '../../shared/bulkWork.ts';

const schema = z.object({
  action: z.enum(['claim', 'release', 'assign']),
  items: z.array(z.object({ id: z.string().min(1).max(64), version: z.number().int().min(1) })).min(1).max(BULK_WORK_LIMIT)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Choose each case only once.'),
  to_user_id: z.string().min(1).max(64).optional(),
  note: z.string().trim().max(1000).optional(),
});
export function parseBulkWork(body: unknown): BulkWorkInput {
  const input = parse(schema, body);
  if (input.action === 'assign' && (!input.to_user_id || !input.note)) throw badRequest('Choose a Marine and say what they need to know.');
  return input;
}
const resultOf = (results: BulkWorkResult[]): BulkWorkResponse => ({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });

/** Preview reveals identifiers only for work the caller may currently read, and performs no writes. */
export function previewBulkWork(ctx: AppContext, user: SessionUser, scope: Scope, input: BulkWorkInput): BulkWorkResponse {
  const target = input.action === 'assign'
    ? ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(input.to_user_id) as SessionUser | undefined : undefined;
  const targetScope = target ? scopeFor(ctx, target) : null;
  return resultOf(input.items.map(({ id, version }) => {
    const row = getItem(ctx, id);
    const denied = (message: string, code: string, reference: string | null = null): BulkWorkResult => ({ id, reference, ok: false, message, code });
    if (!row || !readable(scope, user, row)) return denied('This work is unavailable to you.', 'unavailable');
    const ref = row.reference || row.title;
    if (row.version !== version) return denied('Changed since selection. Refresh before trying again.', 'version_conflict', ref);
    if (row.state === 'resolved' || row.state === 'not_applicable') return denied('This work is closed.', 'closed', ref);
    if (input.action === 'claim') {
      if (!mayClaim(scope, user, row)) return denied('You cannot claim this work.', 'forbidden', ref);
      if (row.claimed_by && row.claimed_by !== user.id) return denied('Someone else holds this work.', 'already_held', ref);
      if (row.claimed_by === user.id) return denied('You already hold this work.', 'already_held', ref);
    } else if (input.action === 'release') {
      if (row.claimed_by !== user.id && !mayReassign(scope, user, row)) return denied('You cannot release this work.', 'forbidden', ref);
      if (!row.claimed_by) return denied('Nobody holds this work.', 'not_held', ref);
    } else {
      if (row.claimed_by !== user.id && !mayReassign(scope, user, row)) return denied('You cannot assign this work.', 'forbidden', ref);
      if (!target || !targetScope || !readable(targetScope, target, row) || !mayClaim(targetScope, target, row)) return denied('That Marine cannot claim this work.', 'ineligible_target', ref);
      if (row.claimed_by === target.id) return denied('That Marine already holds this work.', 'already_held', ref);
    }
    return { id, reference: ref, ok: true, message: 'Ready.' };
  }));
}

/** Existing per-item transactions, authorization and history remain the enforcement boundary. Failures are explicit. */
export function runBulkWork(ctx: AppContext, user: SessionUser, scope: Scope, input: BulkWorkInput, key: string): BulkWorkResponse {
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw badRequest('A valid request identifier is required. Preview the selection again.');
  const results: BulkWorkResult[] = [];
  for (const item of input.items) {
    const row = getItem(ctx, item.id);
    if (!row || !readable(scope, user, row)) {
      results.push({ id: item.id, reference: null, ok: false, message: 'This work is unavailable to you.', code: 'unavailable' });
      continue;
    }
    const reference = row.reference || row.title;
    const fingerprint = createHash('sha256').update(JSON.stringify([input.action, item, input.to_user_id ?? null, input.note ?? null])).digest('hex');
    const request = { key, fingerprint };
    try {
      const kind = input.action === 'assign' ? 'handed_off' : input.action === 'claim' ? 'claimed' : 'released';
      if (replayedWorkRequest(ctx, user, item.id, request, kind)) {
        results.push({ id: item.id, reference, ok: true, message: 'Already applied.', replayed: true });
        continue;
      }
      const preview = previewBulkWork(ctx, user, scope, { ...input, items: [item] }).results[0];
      if (!preview.ok) { results.push(preview); continue; }
      if (input.action === 'claim') claimItem(ctx, user, scope, item.id, item.version, request);
      else if (input.action === 'release') releaseItem(ctx, user, scope, item.id, item.version, request);
      else handOff(ctx, user, scope, item.id, { to_user_id: input.to_user_id, note: input.note, version: item.version }, request);
      results.push({ id: item.id, reference, ok: true, message: 'Applied.' });
    } catch (error) {
      // Only an expected per-case refusal is a partial result. An infrastructure error must reach the normal error
      // handler; pretending the batch finished would conceal a broken database or audit trail.
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      results.push({ id: item.id, reference, ok: false, message: error.message, code: error.code ?? undefined });
    }
  }
  return resultOf(results);
}

export function bulkHandoffCandidates(ctx: AppContext, user: SessionUser, scope: Scope, ids: string[]): HandoffCandidate[] {
  const people = new Map<string, HandoffCandidate>();
  const scopes = new Map<string, Scope>();
  for (const id of ids) {
    const row = getItem(ctx, id);
    if (!row || !readable(scope, user, row) || (row.claimed_by !== user.id && !mayReassign(scope, user, row))) continue;
    for (const person of handoffCandidates(ctx, user, scope, id, scopes)) people.set(person.id, person);
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
