import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export interface SessionRecord {
  token: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class SessionRepo {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds: number,
  ) {}

  create(userId: number): SessionRecord {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + this.ttlSeconds * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    this.db
      .prepare<{ token: string; user_id: number; expires_at: string }, never>(
        `INSERT INTO sessions (token, user_id, expires_at)
         VALUES (@token, @user_id, @expires_at)`,
      )
      .run({ token, user_id: userId, expires_at: expires });
    const row = this.db
      .prepare<{ token: string }, SessionRow>(
        'SELECT * FROM sessions WHERE token = @token',
      )
      .get({ token });
    if (!row) throw new Error('session vanished after create');
    return rowToRecord(row);
  }

  findActive(token: string): SessionRecord | null {
    const row = this.db
      .prepare<{ token: string }, SessionRow>(
        `SELECT * FROM sessions
           WHERE token = @token
             AND expires_at > datetime('now')`,
      )
      .get({ token });
    return row ? rowToRecord(row) : null;
  }

  revoke(token: string): void {
    this.db
      .prepare<{ token: string }, never>(
        'DELETE FROM sessions WHERE token = @token',
      )
      .run({ token });
  }

  revokeAllForUser(userId: number): void {
    this.db
      .prepare<{ user_id: number }, never>(
        'DELETE FROM sessions WHERE user_id = @user_id',
      )
      .run({ user_id: userId });
  }

  purgeExpired(): number {
    const info = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
      .run();
    return Number(info.changes);
  }
}
