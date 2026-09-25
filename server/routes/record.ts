import { Router } from 'express';
import { wrap, parse } from '../lib/http.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import {
  recordSummary, assignedWork, contributionHistory, parseWindow, listDrafts, draftFromWork, updateDraft, saveDraftToRecord, deleteDraft,
  careerOverview, saveCareerProfile, saveCareerStep, deleteCareerStep,
} from '../services/record.ts';
import { careerProfileSchema, careerStepSchema } from '../../shared/record.ts';

export const recordRouter = Router();
recordRouter.use(requireAuth);

recordRouter.get('/summary', wrap((req, res) => {
  res.json(recordSummary(req.ctx, req.user, parseWindow(req.query as Record<string, unknown>)));
}));

recordRouter.get('/assigned', wrap((req, res) => res.json(assignedWork(req.ctx, req.user))));

recordRouter.get('/contributions', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(contributionHistory(req.ctx, req.user, scope, parseWindow(req.query as Record<string, unknown>)));
}));

recordRouter.get('/drafts', wrap((req, res) => res.json(listDrafts(req.ctx, req.user))));
recordRouter.post('/drafts/from-work', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.status(201).json(draftFromWork(req.ctx, req.user, scope, String(req.body?.work_item_id || '')));
}));
recordRouter.put('/drafts/:id', wrap((req, res) => res.json(updateDraft(req.ctx, req.user, String(req.params.id), req.body))));
recordRouter.post('/drafts/:id/save', wrap((req, res) => res.status(201).json(saveDraftToRecord(req.ctx, req.user, String(req.params.id)))));
recordRouter.delete('/drafts/:id', wrap((req, res) => { deleteDraft(req.ctx, req.user, String(req.params.id)); res.status(204).end(); }));

recordRouter.get('/career', wrap((req, res) => res.json(careerOverview(req.ctx, req.user))));
recordRouter.put('/career/profile', wrap((req, res) => res.json(saveCareerProfile(req.ctx, req.user, parse(careerProfileSchema, req.body)))));
recordRouter.post('/career/steps', wrap((req, res) => res.status(201).json(saveCareerStep(req.ctx, req.user, null, parse(careerStepSchema, req.body)))));
recordRouter.put('/career/steps/:id', wrap((req, res) => res.json(saveCareerStep(req.ctx, req.user, String(req.params.id), parse(careerStepSchema, req.body)))));
recordRouter.delete('/career/steps/:id', wrap((req, res) => { deleteCareerStep(req.ctx, req.user, String(req.params.id)); res.status(204).end(); }));
