import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from './config.js';

export interface UserProvisioning {
  home: string;
  workspace: string;
  settingsPath: string;
}

export interface UserProfile {
  userId: string;
  disabledSlashCommands: readonly string[];
  authType: AppConfig['upstreamAuth']['type'];
}

/**
 * Materialize the admin-owned HOME dir and the per-user workspace dir.
 *
 * The HOME dir holds `.qwen/settings.json` which the user cannot write to,
 * giving us a fixed denylist baseline even if the user drops their own
 * `.qwen/settings.json` inside their workspace (UNION merge makes their list
 * strictly additive).
 */
export async function provisionUser(
  config: AppConfig,
  profile: UserProfile,
): Promise<UserProvisioning> {
  const safeId = sanitize(profile.userId);
  const home = join(config.settingsDir, safeId);
  const workspace = join(config.workspacesDir, safeId);
  const qwenDir = join(home, '.qwen');
  const settingsPath = join(qwenDir, 'settings.json');
  const trustedFoldersPath = join(qwenDir, 'trustedFolders.json');

  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(qwenDir, { recursive: true, mode: 0o700 });

  // Pre-trust the workspace so the TUI doesn't block on the interactive
  // "Do you trust this folder?" prompt. The user can't reach any files
  // outside their workspace anyway (cwd is locked to workspace).
  const trustedFolders = { config: { [workspace]: 'TRUST_FOLDER' } };
  await writeFile(
    trustedFoldersPath,
    JSON.stringify(trustedFolders, null, 2) + '\n',
    { mode: 0o600 },
  );
  await chmod(trustedFoldersPath, 0o600);

  const base = await loadBaseSettings(config);

  const settings = {
    ...base,
    $version: 3,
    security: {
      ...(base.security ?? {}),
      auth: {
        ...(base.security?.auth ?? {}),
        selectedType: profile.authType,
      },
    },
    slashCommands: {
      ...(base.slashCommands ?? {}),
      disabled: mergeDisabled(
        base.slashCommands?.disabled,
        profile.disabledSlashCommands,
      ),
    },
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', {
    mode: 0o600,
  });
  await chmod(settingsPath, 0o600);

  return { home, workspace, settingsPath };
}

interface BaseSettings {
  security?: {
    auth?: { selectedType?: string } & Record<string, unknown>;
  } & Record<string, unknown>;
  slashCommands?: {
    disabled?: string[];
  } & Record<string, unknown>;
  [key: string]: unknown;
}

async function loadBaseSettings(config: AppConfig): Promise<BaseSettings> {
  if (!config.baseSettingsPath) return {};
  try {
    const raw = await readFile(config.baseSettingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as BaseSettings;
  } catch {
    // Fall through to empty baseline — the server still boots even if the
    // admin has misconfigured QWEN_BASE_SETTINGS_PATH.
  }
  return {};
}

function mergeDisabled(
  baseList: readonly string[] | undefined,
  extra: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v.trim());
  };
  for (const v of baseList ?? []) push(v);
  for (const v of extra) push(v);
  return out;
}

export async function provisioningExists(
  config: AppConfig,
  userId: string,
): Promise<boolean> {
  const safeId = sanitize(userId);
  try {
    await stat(join(config.settingsDir, safeId, '.qwen', 'settings.json'));
    return true;
  } catch {
    return false;
  }
}

function sanitize(userId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(userId)) {
    throw new Error(
      `userId "${userId}" contains characters outside [A-Za-z0-9._-]`,
    );
  }
  return userId;
}
