import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { UserRepo } from './users.js';

/**
 * On first boot (or when all admins have been deleted) create an initial
 * admin account. Uses ADMIN_INITIAL_PASSWORD if provided, otherwise prints
 * a randomly generated password once to stderr/log.
 */
export async function seedAdminIfMissing(
  config: AppConfig,
  users: UserRepo,
  log: FastifyBaseLogger,
): Promise<void> {
  if (config.auth.mode === 'anonymous') return;
  if (users.countAdmins() > 0) return;

  const username = config.auth.adminUsername;
  const existing = users.findByUsername(username);
  if (existing) {
    // Promote the existing account back to admin + enable it.
    users.update(existing.id, { role: 'admin', disabled: false });
    log.warn(
      { username },
      'seedAdmin: re-enabled existing account and promoted to admin',
    );
    return;
  }

  const password = config.auth.adminInitialPassword ?? generatePassword();
  await users.create({
    username,
    password,
    role: 'admin',
    mustChangePassword: true,
  });

  if (config.auth.adminInitialPassword) {
    log.info({ username }, 'seedAdmin: created admin from ADMIN_INITIAL_PASSWORD');
  } else {
    // Print the one-time password prominently. It is only shown here.
    log.info(
      { username, password },
      '\n========================================\n' +
        ' INITIAL ADMIN PASSWORD (one-time)\n' +
        ` username: ${username}\n` +
        ` password: ${password}\n` +
        ' Change it after first login.\n' +
        '========================================',
    );
  }
}

function generatePassword(): string {
  // 24 chars of url-safe random. Plenty of entropy for an initial secret.
  return randomBytes(18).toString('base64url');
}
