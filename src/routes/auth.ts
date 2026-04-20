import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { UserRepo } from '../auth/users.js';
import type { SessionRepo } from '../auth/sessions.js';
import { verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, requireUser } from '../auth/middleware.js';

const LoginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

const ChangePwBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  users: UserRepo,
  sessions: SessionRepo,
): void {
  app.post('/auth/login', async (req, reply) => {
    if (config.auth.mode === 'anonymous') {
      return reply.code(400).send({ error: 'login_not_required_in_anonymous_mode' });
    }
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const { username, password } = parsed.data;
    const row = users.findByUsernameWithHash(username);
    if (!row || row.disabled) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const session = sessions.create(row.id);
    users.touchLastLogin(row.id);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      signed: true,
      maxAge: Math.floor(
        (new Date(session.expiresAt + 'Z').getTime() - Date.now()) / 1000,
      ),
    });
    return reply.send({
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.mustChangePassword,
      },
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        sessions.revoke(unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (req) => {
    if (config.auth.mode === 'anonymous') {
      return { mode: 'anonymous', user: null };
    }
    const user = requireUser(req);
    return {
      mode: 'users',
      user: user
        ? {
            id: user.id,
            username: user.username,
            role: user.role,
            mustChangePassword: user.mustChangePassword,
          }
        : null,
    };
  });

  app.post('/auth/change-password', async (req, reply) => {
    if (config.auth.mode === 'anonymous') {
      return reply.code(400).send({ error: 'anonymous_mode' });
    }
    const user = requireUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = ChangePwBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const row = users.findByUsernameWithHash(user.username);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const ok = await verifyPassword(parsed.data.currentPassword, row.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
    await users.updatePassword(user.id, parsed.data.newPassword, false);
    sessions.revokeAllForUser(user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
