import type { FastifyInstance } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import type { AppConfig } from '../config.js';
import type { SessionManager, QwenPtySession } from '../spawner.js';
import { SpawnLimitError } from '../spawner.js';
import { provisionUser, type UserProfile } from '../provision.js';

interface StartFrame {
  type: '__start';
  cols?: number;
  rows?: number;
  disabledSlashCommands?: string[];
}

interface ResizeFrame {
  type: '__resize';
  cols: number;
  rows: number;
}

interface CloseFrame {
  type: '__close';
}

type ControlFrame = StartFrame | ResizeFrame | CloseFrame;

function resolveUser(): UserProfile {
  return {
    userId: 'anonymous',
    authType: 'openai',
    disabledSlashCommands: [],
  };
}

function sendMeta(
  ws: WebSocket,
  kind: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    ws.send(JSON.stringify({ type: '__meta', kind, ...payload }));
  } catch {
    // socket already closed
  }
}

function clampDim(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(Math.max(n, min), max);
}

export function registerWsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  manager: SessionManager,
): void {
  app.get(
    '/ws/session',
    { websocket: true },
    async (socket: WebSocket) => {
      let session: QwenPtySession | null = null;

      const cleanup = async () => {
        if (session) {
          const s = session;
          session = null;
          await s.close();
        }
      };

      socket.on('close', () => { void cleanup(); });
      socket.on('error', (err: Error) => {
        app.log.error({ err }, 'ws error');
        void cleanup();
      });

      socket.on('message', async (raw: RawData, isBinary: boolean) => {
        // Binary frames are raw PTY input bytes (keystrokes). Forward as-is.
        if (isBinary) {
          if (!session) return;
          const buf = Buffer.isBuffer(raw)
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw)
              : Buffer.from(raw as ArrayBuffer);
          session.write(buf);
          return;
        }

        let frame: ControlFrame;
        try {
          frame = JSON.parse(raw.toString()) as ControlFrame;
        } catch {
          sendMeta(socket, 'error', { message: 'invalid control JSON frame' });
          return;
        }
        if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
          sendMeta(socket, 'error', { message: 'missing type field' });
          return;
        }

        const frameType = frame.type;

        if (frame.type === '__start') {
          if (session) {
            sendMeta(socket, 'error', { message: 'session already started' });
            return;
          }
          try {
            const profile = resolveUser();
            const clientDisabled = frame.disabledSlashCommands ?? [];
            if (clientDisabled.length > 0) {
              profile.disabledSlashCommands = [
                ...profile.disabledSlashCommands,
                ...clientDisabled,
              ];
            }
            const { home, workspace } = await provisionUser(config, profile);
            const cols = clampDim(frame.cols, 120, 20, 400);
            const rows = clampDim(frame.rows, 32, 8, 200);
            session = manager.create({
              userId: profile.userId,
              home,
              cwd: workspace,
              cols,
              rows,
              disabledSlashCommands: profile.disabledSlashCommands,
            });

            session.on('data', (data: string) => {
              try {
                // Send as binary so the client can cleanly distinguish PTY
                // bytes from JSON control frames.
                socket.send(Buffer.from(data, 'utf8'), { binary: true });
              } catch {
                // socket closed mid-flight
              }
            });
            session.once('exit', (code: number | null, signal: number | null) => {
              sendMeta(socket, 'exit', { code, signal });
              try { socket.close(1000, 'session exited'); } catch { /* already closed */ }
            });

            sendMeta(socket, 'ready', {
              sessionId: session.id,
              userId: profile.userId,
              cols,
              rows,
            });
          } catch (err) {
            if (err instanceof SpawnLimitError) {
              sendMeta(socket, 'error', {
                message: err.message,
                code: 'spawn_limit',
              });
            } else {
              app.log.error({ err }, 'failed to start session');
              sendMeta(socket, 'error', {
                message: (err as Error).message,
                code: 'start_failed',
              });
            }
          }
          return;
        }

        if (frame.type === '__resize') {
          if (!session) return;
          const cols = clampDim(frame.cols, 120, 20, 400);
          const rows = clampDim(frame.rows, 32, 8, 200);
          session.resize(cols, rows);
          return;
        }

        if (frame.type === '__close') {
          await cleanup();
          try { socket.close(1000, 'client close'); } catch { /* already closed */ }
          return;
        }

        sendMeta(socket, 'error', {
          message: `unknown control frame type: ${frameType}`,
        });
      });
    },
  );
}
