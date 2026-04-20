import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';

export interface SessionOptions {
  userId: string;
  home: string;
  cwd: string;
  cols: number;
  rows: number;
  disabledSlashCommands?: readonly string[];
}

/**
 * A qwen CLI process running inside a pseudo-terminal. Raw bytes flow between
 * the PTY and the consumer (typically a WebSocket forwarder) — the CLI sees a
 * real TTY and renders its full Ink/React UI: slash menus, approval dialogs,
 * colors, all of it.
 */
export class QwenPtySession extends EventEmitter {
  readonly id: string;
  readonly userId: string;
  private readonly pty: IPty;
  private exited = false;
  private closed = false;

  constructor(pty: IPty, opts: { id: string; userId: string }) {
    super();
    this.id = opts.id;
    this.userId = opts.userId;
    this.pty = pty;

    this.pty.onData((data) => {
      this.emit('data', data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      if (this.exited) return;
      this.exited = true;
      this.emit('exit', exitCode, signal ?? null);
    });
  }

  write(data: string | Buffer): void {
    if (this.closed || this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed || this.exited) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // pty already torn down; safe to swallow
    }
  }

  async close(graceMs = 1500): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.exited) return;
    try {
      this.pty.kill('SIGHUP');
    } catch {
      // already dead
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.exited) {
          try { this.pty.kill('SIGKILL'); } catch { /* already dead */ }
        }
        resolve();
      }, graceMs);
      this.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export class SpawnLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnLimitError';
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, QwenPtySession>();
  private readonly perUserCount = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  get count(): number {
    return this.sessions.size;
  }

  countForUser(userId: string): number {
    return this.perUserCount.get(userId) ?? 0;
  }

  create(opts: SessionOptions): QwenPtySession {
    if (this.sessions.size >= this.config.limits.total) {
      throw new SpawnLimitError(
        `total session limit reached (${this.config.limits.total})`,
      );
    }
    const currentForUser = this.countForUser(opts.userId);
    if (currentForUser >= this.config.limits.perUser) {
      throw new SpawnLimitError(
        `per-user session limit reached (${this.config.limits.perUser})`,
      );
    }

    const { file, args } = this.buildInvocation(opts);
    const env = this.buildEnv(opts.home);

    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    const id = randomUUID();
    const session = new QwenPtySession(pty, { id, userId: opts.userId });
    this.sessions.set(id, session);
    this.perUserCount.set(opts.userId, currentForUser + 1);

    this.log.info(
      {
        sessionId: id,
        userId: opts.userId,
        pid: pty.pid,
        cwd: opts.cwd,
        home: opts.home,
        cols: opts.cols,
        rows: opts.rows,
      },
      'spawned qwen pty session',
    );

    session.once('exit', (code: number | null, signal: number | null) => {
      this.sessions.delete(id);
      const remaining = (this.perUserCount.get(opts.userId) ?? 1) - 1;
      if (remaining <= 0) this.perUserCount.delete(opts.userId);
      else this.perUserCount.set(opts.userId, remaining);
      this.log.info(
        { sessionId: id, userId: opts.userId, code, signal },
        'qwen pty session exited',
      );
    });

    return session;
  }

  get(id: string): QwenPtySession | undefined {
    return this.sessions.get(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values()).map((s) => s.close()));
  }

  private buildInvocation(opts: SessionOptions): {
    file: string;
    args: string[];
  } {
    const args: string[] = [];
    if (opts.disabledSlashCommands && opts.disabledSlashCommands.length > 0) {
      args.push('--disabled-slash-commands', opts.disabledSlashCommands.join(','));
    }
    if (this.config.qwenCodeBin) {
      return { file: process.execPath, args: [this.config.qwenCodeBin, ...args] };
    }
    const cliEntry = `${this.config.qwenCodeRoot}/packages/cli`;
    return { file: process.execPath, args: [cliEntry, ...args] };
  }

  private buildEnv(home: string): Record<string, string> {
    const env: Record<string, string | undefined> = {
      PATH: process.env['PATH'],
      HOME: home,
      USER: 'qwen-web-user',
      LANG: process.env['LANG'] ?? 'C.UTF-8',
      LC_ALL: process.env['LC_ALL'] ?? 'C.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLI_VERSION: 'qwen-web',
      DEV: process.env['DEV'],
      ...this.config.upstreamAuth.env,
    };
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && v.length > 0) cleaned[k] = v;
    }
    return cleaned;
  }
}
