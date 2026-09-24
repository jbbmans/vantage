import { Router, type Request } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { listPeople, setTeamLevel, addToTeam, removeFromTeam } from '../services/people.ts';

/** People management: access levels per team, membership, and (for organization administrators) accounts. */
export const peopleRouter = Router();
peopleRouter.use(requireAuth);

const sudo = (req: Request) => Boolean(req.sessionRow?.sudo_until && Date.parse(req.sessionRow.sudo_until) > Date.now());
const level = z.enum(['personal', 'leader', 'administrator']);

peopleRouter.get('/', wrap((req, res) => res.json(listPeople(req.ctx, req.user, scopeFor(req.ctx, req.user, req), { sudo: sudo(req) }))));

peopleRouter.put('/:userId/teams/:unitId', wrap((req, res) => {
  const body = parse(z.object({ level }), req.body);
  res.json(setTeamLevel(req.ctx, req.user, String(req.params.userId), String(req.params.unitId), body.level, { sudo: sudo(req), ip: clientIp(req) }));
}));

peopleRouter.post('/:userId/teams', wrap((req, res) => {
  const body = parse(z.object({ unit_id: z.string().max(64), level: level.default('personal'), billet: z.string().max(80).nullish() }), req.body);
  res.status(201).json(addToTeam(req.ctx, req.user, String(req.params.userId), body.unit_id, body.level, { sudo: sudo(req), billet: body.billet, ip: clientIp(req) }));
}));

peopleRouter.delete('/:userId/teams/:unitId', wrap((req, res) => {
  res.json(removeFromTeam(req.ctx, req.user, String(req.params.userId), String(req.params.unitId), { sudo: sudo(req), ip: clientIp(req) }));
}));
