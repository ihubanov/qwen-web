import type { Database as Db } from 'better-sqlite3';
import { hashPassword } from './password.js';

export type Role = 'admin' | 'user';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  must_change_pw: number;
  disabled_slash_commands: string;
  created_at: string;
  last_login_at: string | null;
}

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  disabledSlashCommands: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

function rowToUser(row: UserRow): User {
  let dsc: string[] = [];
  try {
    const parsed = JSON.parse(row.disabled_slash_commands);
    if (Array.isArray(parsed)) dsc = parsed.filter((v) => typeof v === 'string');
  } catch {
    // keep empty
  }
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled === 1,
    mustChangePassword: row.must_change_pw === 1,
    disabledSlashCommands: dsc,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export class UserRepo {
  constructor(private readonly db: Db) {}

  findById(id: number): User | null {
    const row = this.db
      .prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id')
      .get({ id });
    return row ? rowToUser(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.db
      .prepare<{ username: string }, UserRow>(
        'SELECT * FROM users WHERE username = @username',
      )
      .get({ username });
    return row ? rowToUser(row) : null;
  }

  findByUsernameWithHash(
    username: string,
  ): (User & { passwordHash: string }) | null {
    const row = this.db
      .prepare<{ username: string }, UserRow>(
        'SELECT * FROM users WHERE username = @username',
      )
      .get({ username });
    if (!row) return null;
    return { ...rowToUser(row), passwordHash: row.password_hash };
  }

  list(): User[] {
    const rows = this.db
      .prepare<[], UserRow>('SELECT * FROM users ORDER BY username ASC')
      .all();
    return rows.map(rowToUser);
  }

  count(): number {
    const row = this.db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM users')
      .get();
    return row?.c ?? 0;
  }

  countAdmins(): number {
    const row = this.db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0",
      )
      .get();
    return row?.c ?? 0;
  }

  async create(params: {
    username: string;
    password: string;
    role: Role;
    mustChangePassword?: boolean;
    disabledSlashCommands?: readonly string[];
  }): Promise<User> {
    const hash = await hashPassword(params.password);
    const dsc = JSON.stringify(params.disabledSlashCommands ?? []);
    const stmt = this.db.prepare<{
      username: string;
      password_hash: string;
      role: Role;
      must_change_pw: number;
      disabled_slash_commands: string;
    }, never>(
      `INSERT INTO users (username, password_hash, role, must_change_pw, disabled_slash_commands)
       VALUES (@username, @password_hash, @role, @must_change_pw, @disabled_slash_commands)`,
    );
    const result = stmt.run({
      username: params.username,
      password_hash: hash,
      role: params.role,
      must_change_pw: params.mustChangePassword ? 1 : 0,
      disabled_slash_commands: dsc,
    });
    const id = Number(result.lastInsertRowid);
    const user = this.findById(id);
    if (!user) throw new Error('user vanished after create');
    return user;
  }

  async updatePassword(
    id: number,
    newPassword: string,
    mustChangeAfter = false,
  ): Promise<void> {
    const hash = await hashPassword(newPassword);
    this.db
      .prepare<{ id: number; hash: string; must_change_pw: number }, never>(
        `UPDATE users
            SET password_hash = @hash,
                must_change_pw = @must_change_pw
          WHERE id = @id`,
      )
      .run({ id, hash, must_change_pw: mustChangeAfter ? 1 : 0 });
  }

  update(
    id: number,
    patch: {
      role?: Role;
      disabled?: boolean;
      disabledSlashCommands?: readonly string[];
    },
  ): User | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.role !== undefined) {
      sets.push('role = @role');
      params['role'] = patch.role;
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = @disabled');
      params['disabled'] = patch.disabled ? 1 : 0;
    }
    if (patch.disabledSlashCommands !== undefined) {
      sets.push('disabled_slash_commands = @disabled_slash_commands');
      params['disabled_slash_commands'] = JSON.stringify(
        patch.disabledSlashCommands,
      );
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`)
        .run(params);
    }
    return this.findById(id);
  }

  delete(id: number): void {
    this.db
      .prepare<{ id: number }, never>('DELETE FROM users WHERE id = @id')
      .run({ id });
  }

  touchLastLogin(id: number): void {
    this.db
      .prepare<{ id: number }, never>(
        "UPDATE users SET last_login_at = datetime('now') WHERE id = @id",
      )
      .run({ id });
  }
}
