# qwen-web

Multi-user web wrapper around [qwen-code](https://github.com/QwenLM/qwen-code). Each WebSocket connection gets its own pseudo-terminal running the full qwen TUI in a browser via [xterm.js](https://xtermjs.org/) — slash menus, approval prompts, colors, the whole thing. Not a chat UI on top of the stream-json protocol.

Primary use case: hosting qwen for users who should not get a shell on the box. Each user gets a sandboxed workspace dir and an admin-owned settings dir they cannot rewrite.

## Status

Early. Single-user anonymous access works end-to-end. Auth, SQLite user store, per-role denylists, admin API — planned, not built.

## How isolation works

Per connection the server spawns `qwen` with:

- `HOME=data/settings/<uid>/` — admin-writable, user-unreachable. Holds the generated `.qwen/settings.json` and `.qwen/trustedFolders.json`.
- `cwd=data/workspaces/<uid>/` — user-writable. This is the "project" the TUI sees.

Since qwen reads its user-scope config from `$HOME/.qwen/settings.json` and we own that file, the admin controls the security surface (auth type, denylist, etc). The user is still free to drop a `.qwen/settings.json` inside the workspace, but under the UNION merge semantics of `slashCommands.disabled` they can only *add* to the denylist, never shrink it.

Relies on the `slashCommands.disabled` setting and `--disabled-slash-commands` flag added in [QwenLM/qwen-code#3445](https://github.com/QwenLM/qwen-code/pull/3445). On qwen-code releases without that change the denylist will not enforce.

## Requirements

- Node 20+
- A local checkout of `qwen-code` built (`npm install && npm run build` in the qwen-code tree)
- An LLM endpoint qwen can reach. The wrapper just forwards env vars; it does not manage model credentials itself

## Setup

```
git clone https://github.com/ihubanov/qwen-web
cd qwen-web
npm install
cp .env.example .env
# edit .env — at minimum set QWEN_CODE_ROOT, COOKIE_SECRET,
# and whichever upstream auth env vars qwen needs (OPENAI_API_KEY, etc).
npm run dev
```

Open `http://127.0.0.1:3900`, click Connect.

## Config

| env | purpose |
| --- | --- |
| `QWEN_CODE_ROOT` | path to the qwen-code monorepo root (dev mode, invokes `packages/cli` directly) |
| `QWEN_CODE_BIN` | absolute path to a bundled `qwen` binary (production; takes precedence over `QWEN_CODE_ROOT`) |
| `QWEN_BASE_SETTINGS_PATH` | baseline `settings.json` to inherit (e.g. your `modelProviders` block for a local vLLM). The wrapper merges its per-user overrides on top |
| `QWEN_PASSTHROUGH_ENV` | comma-separated env var names to forward into spawned qwen processes. Useful for custom `envKey` values referenced by `modelProviders` |
| `QWEN_AUTH_TYPE` | `openai`/`anthropic`/`qwen-oauth`/`gemini`/`vertex-ai`. Written into the generated per-user settings |
| `DATA_DIR` | root for `workspaces/<uid>/` and `settings/<uid>/` (default `./data`) |
| `COOKIE_SECRET` | session cookie secret. Required |
| `MAX_SESSIONS_PER_USER` / `MAX_SESSIONS_TOTAL` | concurrency caps |

## Architecture

```
browser (xterm.js) ──ws── fastify ──node-pty── qwen child process
                             │
                             ├── per-user workspace dir (cwd)
                             └── per-user HOME dir (settings + trustedFolders)
```

- `src/spawner.ts` — PTY lifecycle + per-user concurrency limits
- `src/provision.ts` — materializes `HOME`/`.qwen/settings.json` and `trustedFolders.json` per user
- `src/routes/ws.ts` — WS ↔ PTY bridge. Text frames carry JSON control messages (`__start`, `__resize`, `__close`); binary frames carry raw PTY bytes
- `public/index.html` — xterm.js client

## Why not contribute this upstream

This is a deployment app, not a CLI feature. Putting Fastify, node-pty, bcrypt, SQLite into the qwen-code repo would bloat every CLI install for the benefit of a narrow multi-tenant use case. The narrow generic piece (`slashCommands.disabled`) was contributed upstream; the deployment app lives here.

## License

Apache-2.0, matching qwen-code.
