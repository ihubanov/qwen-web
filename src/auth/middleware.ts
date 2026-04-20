import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { UserRepo, User } from './users.js';
import type { SessionRepo } from './sessions.js';

export const SESSION_COOKIE = 'qwsid';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User | null;
    authMode?: 'anonymous' | 'users';
  }
}

export interface AuthContext {
  config: AppConfig;
  users: UserRepo;
  sessions: SessionRepo;
}

function extractToken(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return unsigned.value;
}

export function registerAuthHook(
  app: FastifyInstance,
  ctx: AuthContext,
): void {
  app.addHook('onRequest', (req, _reply, done) => {
    req.authMode = ctx.config.auth.mode;
    if (ctx.config.auth.mode === 'anonymous') {
      req.user = null;
      return done();
    }
    const token = extractToken(req);
    if (!token) {
      req.user = null;
      return done();
    }
    const session = ctx.sessions.findActive(token);
    if (!session) {
      req.user = null;
      return done();
    }
    const user = ctx.users.findById(session.userId);
    if (!user || user.disabled) {
      req.user = null;
      return done();
    }
    req.user = user;
    done();
  });
}

export function requireUser(req: FastifyRequest): User | null {
  if (req.authMode === 'anonymous') return null;
  return req.user ?? null;
}

export function requireAdmin(req: FastifyRequest): User | null {
  const user = requireUser(req);
  if (!user) return null;
  return user.role === 'admin' ? user : null;
}
