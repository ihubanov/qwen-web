import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { UserRepo, User } from '../auth/users.js';
import type { SessionRepo } from '../auth/sessions.js';
import { requireAdmin } from '../auth/middleware.js';

const CreateBody = z.object({
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'user']).default('user'),
  mustChangePassword: z.boolean().default(true),
  disabledSlashCommands: z.array(z.string()).default([]),
});

const PatchBody = z.object({
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.boolean().optional(),
  disabledSlashCommands: z.array(z.string()).optional(),
});

const ResetPasswordBody = z.object({
  newPassword: z.string().min(8).max(256),
  mustChangePassword: z.boolean().default(true),
});

function publicUser(u: User): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    mustChangePassword: u.mustChangePassword,
    disabledSlashCommands: u.disabledSlashCommands,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  users: UserRepo,
  sessions: SessionRepo,
): void {
  const guard = (req: FastifyRequest): string | null => {
    if (config.auth.mode === 'anonymous') return 'anonymous_mode';
    if (!requireAdmin(req)) return 'forbidden';
    return null;
  };

  app.get('/admin/users', async (req, reply) => {
    const err = guard(req);
    if (err) return reply.code(err === 'anonymous_mode' ? 400 : 403).send({ error: err });
    return { users: users.list().map(publicUser) };
  });

  app.post('/admin/users', async (req, reply) => {
    const err = guard(req);
    if (err) return reply.code(err === 'anonymous_mode' ? 400 : 403).send({ error: err });
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    if (users.findByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: 'username_taken' });
    }
    const created = await users.create(parsed.data);
    return reply.code(201).send({ user: publicUser(created) });
  });

  app.patch<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const err = guard(req);
    if (err) return reply.code(err === 'anonymous_mode' ? 400 : 403).send({ error: err });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    const target = users.findById(id);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    // Prevent the last active admin from being demoted or disabled.
    const wouldStripAdmin =
      target.role === 'admin' && !target.disabled &&
      ((parsed.data.role !== undefined && parsed.data.role !== 'admin') ||
        parsed.data.disabled === true);
    if (wouldStripAdmin && users.countAdmins() <= 1) {
      return reply.code(409).send({ error: 'cannot_demote_last_admin' });
    }
    const updated = users.update(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    // If they were disabled, revoke all their sessions.
    if (parsed.data.disabled === true) sessions.revokeAllForUser(id);
    return { user: publicUser(updated) };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/reset-password',
    async (req, reply) => {
      const err = guard(req);
      if (err) return reply.code(err === 'anonymous_mode' ? 400 : 403).send({ error: err });
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
      const target = users.findById(id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const parsed = ResetPasswordBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      await users.updatePassword(id, parsed.data.newPassword, parsed.data.mustChangePassword);
      sessions.revokeAllForUser(id);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const err = guard(req);
    if (err) return reply.code(err === 'anonymous_mode' ? 400 : 403).send({ error: err });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    const target = users.findById(id);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'admin' && users.countAdmins() <= 1) {
      return reply.code(409).send({ error: 'cannot_delete_last_admin' });
    }
    sessions.revokeAllForUser(id);
    users.delete(id);
    return { ok: true };
  });
}
