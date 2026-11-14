/**
 * What the Vantage Administrator console sends about approved course sources (Task 22, ADR-0029). Kept apart from
 * courses.ts, which the browser imports, so the browser bundle does not carry the validation library it never runs.
 */
import { z } from 'zod';
import { isoDate } from './schemas.ts';
import { cleanBlock, cleanLine } from './courses.ts';

const NUL = '\u0000';
const line = (max: number, message = 'Required.') => z.string().max(max * 4, `Keep it under ${max} characters.`)
  .refine((v) => !v.includes(NUL), 'Contains a null byte.').transform((v) => cleanLine(v))
  .pipe(z.string().min(1, message).max(max, `Keep it under ${max} characters.`));

export const courseSourceSchema = z.object({
  name: line(120, 'Name the source, as its publisher names it.'),
  authority: line(200, 'Say who publishes it.'),
  approval_reference: line(300, 'Name the document, memo or ticket that approves this source for Vantage.'),
  approved_by: line(200, 'Say who approved it, as that document names them.'),
  approved_on: isoDate,
  notes: z.string().max(4000).nullish().transform((v) => (v ? cleanBlock(v) : '') || null)
    .pipe(z.string().max(1000, 'Keep it under 1000 characters.').nullable()),
});
export type CourseSourceInput = z.infer<typeof courseSourceSchema>;

export const withdrawSourceSchema = z.object({ reason: line(500, 'Say why.') });

/** Applying a staged catalog names the file it was shown, so a page left open never applies a different one. */
export const applyCatalogSchema = z.object({ file_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Load the catalog again.') });

/** The query a catalog file is sent with: the day its data is as of. */
export const stageCatalogQuery = z.object({ as_of: isoDate });

export const browseCatalogQuery = z.object({
  q: z.string().max(200).optional().transform((v) => cleanLine(v ?? '')),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
});
