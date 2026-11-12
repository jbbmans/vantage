/** Bulk work is a bounded collection of the existing per-case operations, never a new source of credit. */
export const BULK_WORK_LIMIT = 100;
export type BulkWorkAction = 'claim' | 'release' | 'assign';
export interface BulkWorkInput {
  action: BulkWorkAction;
  items: Array<{ id: string; version: number }>;
  to_user_id?: string;
  note?: string;
}
export interface BulkWorkResult {
  id: string;
  reference: string | null;
  ok: boolean;
  message: string;
  code?: string;
  replayed?: boolean;
}
export interface BulkWorkResponse {
  results: BulkWorkResult[];
  succeeded: number;
  failed: number;
}
export interface HandoffCandidate { id: string; name: string; rank: string | null }
