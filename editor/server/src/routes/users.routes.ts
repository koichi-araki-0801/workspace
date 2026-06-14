/** User-management routes (admin only). */
import { Router } from 'express';
import type { z } from 'zod';
import { actorFromReq, audit } from '../logger.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { CreateUserRequest, UpdateUserRequest } from '../openapi/schemas.js';
import * as users from '../repositories/userRepo.js';

export const usersRouter = Router();

usersRouter.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  res.json(await users.listUsers());
});

usersRouter.post(
  '/users',
  requireAuth,
  requireAdmin,
  validate(CreateUserRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof CreateUserRequest>;
    const user = await users.createUser(body);
    audit({
      event: 'user.create',
      outcome: 'success',
      ...actorFromReq(req),
      resource: { id: user.id, username: user.username },
    });
    res.status(201).json(user);
  },
);

usersRouter.patch(
  '/users/:id',
  requireAuth,
  requireAdmin,
  validate(UpdateUserRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof UpdateUserRequest>;
    res.json(await users.updateUser(String(req.params.id), body));
  },
);

usersRouter.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  await users.resetUserPassword(String(req.params.id));
  audit({
    event: 'user.reset-password',
    outcome: 'success',
    ...actorFromReq(req),
    resource: { id: String(req.params.id) },
  });
  res.status(204).end();
});
