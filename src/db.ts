import Database, { type Database as Db } from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Opens (and lazily migrates) the application SQLite database.
 * All DDL is idempotent so the server boots cleanly on both empty and
 * already-migrated files.
 */
export async function openDatabase(path: string): Promise<Db> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL,
      role             TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      disabled         INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      must_change_pw   INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pw IN (0, 1)),
      disabled_slash_commands TEXT NOT NULL DEFAULT '[]',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
}
