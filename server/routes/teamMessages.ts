import { Router } from 'express';
import { wrap } from '../lib/http.ts';
import { notFound } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { openTeamMessage, teamMessageFile, teamMessageView } from '../services/teamMessages.ts';
import { attachmentContentType, attachmentDisposition } from '../services/attachments.ts';

/**
 * A kept team message and its files (ADR-0049), for the page the notice and the email open. Mounted apart from /api/org
 * so only the application's host answers it: the Unit Manager console's host answers /api/org too.
 */
export const teamMessagesRouter = Router();
teamMessagesRouter.use(requireAuth);

const NOT_FOUND = 'No such message, or it is not one you can open.';

teamMessagesRouter.get('/:id', wrap((req, res) => {
  const row = openTeamMessage(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id));
  if (!row) throw notFound(NOT_FOUND);
  res.json(teamMessageView(req.ctx, req.user, row));
}));

teamMessagesRouter.get('/:id/files/:fileId', wrap((req, res) => {
  const row = openTeamMessage(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id));
  if (!row) throw notFound(NOT_FOUND);
  const file = teamMessageFile(req.ctx, row, String(req.params.fileId));
  if (!file) throw notFound('No such file.');
  res.setHeader('Content-Type', attachmentContentType(file.mime_type));
  res.setHeader('Content-Length', String(file.size_bytes));
  // Always a download, never a page, as a record's file is: saved under its own name, never sniffed into another type,
  // and, should a browser show it all the same, shown with no script, no form and no origin of Vantage's.
  res.setHeader('Content-Disposition', attachmentDisposition(file.original_name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.send(file.content);
}));
