import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3900),
  HOST: z.string().default('127.0.0.1'),
  QWEN_CODE_ROOT: z.string().min(1),
  QWEN_CODE_BIN: z.string().optional(),
  QWEN_BASE_SETTINGS_PATH: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  DB_PATH: z.string().default('./data/qwen-web.sqlite'),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be >=16 chars'),
  QWEN_AUTH_TYPE: z
    .enum(['openai', 'anthropic', 'qwen-oauth', 'gemini', 'vertex-ai'])
    .default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  // Comma-separated list of additional env var names to forward from the
  // server's environment into spawned qwen CLI processes. Useful for custom
  // envKey values referenced inside a QWEN_BASE_SETTINGS_PATH modelProviders
  // block (e.g. VLLM_API_KEY for a local vLLM server).
  QWEN_PASSTHROUGH_ENV: z.string().optional(),
  MAX_SESSIONS_PER_USER: z.coerce.number().int().positive().default(2),
  MAX_SESSIONS_TOTAL: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type RawConfig = z.infer<typeof schema>;

export interface AppConfig {
  port: number;
  host: string;
  qwenCodeRoot: string;
  qwenCodeBin: string | null;
  baseSettingsPath: string | null;
  dataDir: string;
  workspacesDir: string;
  settingsDir: string;
  dbPath: string;
  cookieSecret: string;
  upstreamAuth: {
    type: RawConfig['QWEN_AUTH_TYPE'];
    env: Record<string, string>;
  };
  limits: {
    perUser: number;
    total: number;
  };
  logLevel: RawConfig['LOG_LEVEL'];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = schema.parse(env);
  const dataDir = resolve(raw.DATA_DIR);
  const upstreamEnv: Record<string, string> = {};
  const copy = (key: keyof RawConfig) => {
    const v = raw[key];
    if (typeof v === 'string' && v.length > 0) upstreamEnv[key] = v;
  };
  copy('OPENAI_API_KEY');
  copy('OPENAI_BASE_URL');
  copy('ANTHROPIC_API_KEY');
  copy('ANTHROPIC_BASE_URL');
  copy('GEMINI_API_KEY');
  copy('GOOGLE_API_KEY');

  for (const name of (raw.QWEN_PASSTHROUGH_ENV ?? '').split(',')) {
    const key = name.trim();
    if (!key) continue;
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) upstreamEnv[key] = v;
  }

  return {
    port: raw.PORT,
    host: raw.HOST,
    qwenCodeRoot: resolve(raw.QWEN_CODE_ROOT),
    qwenCodeBin: raw.QWEN_CODE_BIN ? resolve(raw.QWEN_CODE_BIN) : null,
    baseSettingsPath: raw.QWEN_BASE_SETTINGS_PATH
      ? resolve(raw.QWEN_BASE_SETTINGS_PATH)
      : null,
    dataDir,
    workspacesDir: resolve(dataDir, 'workspaces'),
    settingsDir: resolve(dataDir, 'settings'),
    dbPath: resolve(raw.DB_PATH),
    cookieSecret: raw.COOKIE_SECRET,
    upstreamAuth: { type: raw.QWEN_AUTH_TYPE, env: upstreamEnv },
    limits: { perUser: raw.MAX_SESSIONS_PER_USER, total: raw.MAX_SESSIONS_TOTAL },
    logLevel: raw.LOG_LEVEL,
  };
}
