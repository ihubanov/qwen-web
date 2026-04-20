import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

export type SandboxMode = 'none' | 'bwrap';

export interface BwrapInvocation {
  cmd: string;
  args: string[];
}

export interface BwrapOptions {
  /** Absolute path to the node executable (e.g. process.execPath). */
  nodeBin: string;
  /** Host path to the qwen-code checkout (QWEN_CODE_ROOT). */
  qwenCodeRoot: string;
  /** Optional absolute path to a prebuilt qwen binary (QWEN_CODE_BIN). */
  qwenCodeBin: string | null;
  /** Host path to the admin-owned HOME dir for this user. */
  home: string;
  /** Host path to the user's writable workspace. */
  workspace: string;
  /** Arguments to pass to the qwen CLI. */
  qwenArgs: readonly string[];
  /**
   * System roots to expose read-only inside the sandbox. Defaults cover
   * typical distros; admins can override via SANDBOX_RO_BINDS.
   */
  roBinds: readonly string[];
  /**
   * Extra read-only binds (for e.g. custom /opt paths). Host-path → sandbox
   * path identical to keep provisioned file paths valid.
   */
  extraRoBinds: readonly string[];
  /**
   * Whether to share the host's network namespace. Required for qwen to
   * reach the upstream LLM endpoint. Default: true.
   */
  shareNet: boolean;
}

/**
 * Build an argv that runs the qwen CLI inside a `bwrap` sandbox. Host paths
 * are bind-mounted at their original locations so provisioned data (e.g.
 * trustedFolders.json referencing the host workspace path) remains valid.
 */
export function buildBwrapInvocation(opts: BwrapOptions): BwrapInvocation {
  const args: string[] = [];

  const addRoBind = (path: string) => {
    // --ro-bind-try silently ignores paths that don't exist — convenient on
    // distros that have /lib64 or /lib on one but not the other.
    args.push('--ro-bind-try', path, path);
  };

  for (const p of opts.roBinds) addRoBind(p);
  for (const p of opts.extraRoBinds) addRoBind(p);

  // Node runtime. Binding the whole `bin/..` directory picks up any
  // co-located files (npm, shim scripts) if the binary's parent is a
  // dedicated prefix like nvm's versioned dir.
  const nodeDir = dirname(dirname(opts.nodeBin));
  addRoBind(nodeDir);

  // qwen-code tree (read-only) — needed when running from source (no bundled
  // binary). If a bundled binary is configured, bind that too so the process
  // can load it.
  addRoBind(opts.qwenCodeRoot);
  if (opts.qwenCodeBin) addRoBind(opts.qwenCodeBin);

  // User's sandboxed HOME and workspace (read-write).
  args.push('--bind', opts.home, opts.home);
  args.push('--bind', opts.workspace, opts.workspace);

  // Working directory + HOME env mirror the host paths so the inside matches
  // the outside.
  args.push('--chdir', opts.workspace);
  args.push('--setenv', 'HOME', opts.home);

  // Minimal runtime filesystems.
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--tmpfs', '/tmp');

  // Isolation knobs.
  args.push('--unshare-all');
  if (opts.shareNet) args.push('--share-net');
  args.push('--die-with-parent');
  args.push('--new-session');

  // Then the program to execute.
  args.push(opts.nodeBin);
  args.push(...(opts.qwenCodeBin ? [opts.qwenCodeBin] : [`${opts.qwenCodeRoot}/packages/cli`]));
  args.push(...opts.qwenArgs);

  return { cmd: 'bwrap', args };
}

/**
 * Throws a descriptive error if bubblewrap is not installed or unusable.
 * Called once at server boot when SANDBOX_MODE=bwrap so misconfigurations
 * fail loud rather than per-session.
 */
export function assertBwrapAvailable(): void {
  try {
    execSync('bwrap --version', { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `SANDBOX_MODE=bwrap but \`bwrap\` is not runnable. ` +
        `Install the 'bubblewrap' package (e.g. 'apt install bubblewrap') and retry. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

export const DEFAULT_RO_BINDS = [
  '/usr',
  '/lib',
  '/lib32',
  '/lib64',
  '/bin',
  '/sbin',
  // Node's os.userInfo() reads /etc/passwd at startup (via the `atomically`
  // transitive dep) to resolve uid → username. Omitting this crashes the
  // child with ERR_SYSTEM_ERROR "uv_os_get_passwd returned ENOENT".
  '/etc/passwd',
  '/etc/group',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/etc/hosts',
  '/etc/hostname',
  '/etc/localtime',
] as const;
