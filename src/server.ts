import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from './config.js';
import { SessionManager } from './spawner.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { openDatabase } from './db.js';
import { UserRepo } from './auth/users.js';
import { SessionRepo } from './auth/sessions.js';
import { registerAuthHook } from './auth/middleware.js';
import { seedAdminIfMissing } from './auth/seed.js';
import { assertBwrapAvailable } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const vendorMap: Array<{ prefix: string; root: string }> = [
  {
    prefix: '/vendor/xterm/',
    root: resolve(__dirname, '..', 'node_modules', '@xterm', 'xterm'),
  },
  {
    prefix: '/vendor/xterm-addon-fit/',
    root: resolve(__dirname, '..', 'node_modules', '@xterm', 'addon-fit'),
  },
  {
    prefix: '/vendor/xterm-addon-web-links/',
    root: resolve(__dirname, '..', 'node_modules', '@xterm', 'addon-web-links'),
  },
];

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  if (config.sandbox.mode === 'bwrap') {
    assertBwrapAvailable();
    app.log.info(
      { mode: 'bwrap', shareNet: config.sandbox.shareNet },
      'sandbox enabled',
    );
  }

  const db = await openDatabase(config.dbPath);
  const users = new UserRepo(db);
  const sessions = new SessionRepo(db, config.auth.sessionTtlSeconds);

  await seedAdminIfMissing(config, users, app.log);

  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket);
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  for (const mount of vendorMap) {
    await app.register(fastifyStatic, {
      root: mount.root,
      prefix: mount.prefix,
      decorateReply: false,
    });
  }

  registerAuthHook(app, { config, users, sessions });
  registerAuthRoutes(app, config, users, sessions);
  registerAdminRoutes(app, config, users, sessions);

  const manager = new SessionManager(config, app.log);
  registerWsRoutes(app, config, manager, users);

  app.get('/health', async () => ({
    ok: true,
    authMode: config.auth.mode,
    sessions: {
      total: manager.count,
      limit: config.limits.total,
    },
  }));

  // Periodic cleanup of expired session rows.
  const purgeTimer = setInterval(() => {
    const n = sessions.purgeExpired();
    if (n > 0) app.log.debug({ purged: n }, 'purged expired sessions');
  }, 60_000).unref();

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    await manager.closeAll();
    try { db.close(); } catch { /* ignore */ }
  });

  return app;
}
