#!/usr/bin/env node
import { WebSocket } from 'ws';

const url = process.env.WS_URL ?? 'ws://127.0.0.1:3902/ws/session';
const ws = new WebSocket(url);
let sessionId = null;
let gotSystem = false;
let slashCommandsSeen = null;

const DISABLED = ['init', 'clear'];
const timeout = setTimeout(() => {
  console.error('[smoke] timeout');
  process.exit(2);
}, 15000);

ws.on('open', () => {
  console.error(`[smoke] open ${url}`);
  ws.send(JSON.stringify({
    type: '__start',
    options: { disabledSlashCommands: DISABLED },
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === '__meta' && msg.kind === 'ready') {
    sessionId = msg.sessionId;
    console.error(`[smoke] ready session=${sessionId} user=${msg.userId}`);
    ws.send(JSON.stringify({
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: 'say READY' },
      parent_tool_use_id: null,
    }));
    return;
  }
  if (msg.type === 'system' && Array.isArray(msg.slash_commands)) {
    gotSystem = true;
    slashCommandsSeen = msg.slash_commands;
    console.error(`[smoke] system.slash_commands=${JSON.stringify(msg.slash_commands)}`);
    const leaked = DISABLED.filter((d) => msg.slash_commands.includes(d));
    if (leaked.length === 0) {
      console.error(`[smoke] ✓ denylist honored via WS`);
    } else {
      console.error(`[smoke] ✗ denylist LEAK via WS: ${JSON.stringify(leaked)}`);
      process.exitCode = 1;
    }
    clearTimeout(timeout);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: '__close' }));
      setTimeout(() => ws.close(), 100);
    }, 100);
    return;
  }
  if (msg.type === '__meta') {
    console.error(`[smoke] meta.${msg.kind} ${JSON.stringify(msg).slice(0, 200)}`);
    return;
  }
  console.error(`[smoke] msg.type=${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`);
});

ws.on('close', (code) => {
  console.error(`[smoke] close code=${code} gotSystem=${gotSystem}`);
  process.exit(process.exitCode ?? (gotSystem ? 0 : 1));
});

ws.on('error', (err) => {
  console.error(`[smoke] ws error: ${err.message}`);
  process.exit(1);
});
