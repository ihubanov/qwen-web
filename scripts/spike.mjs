#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const qwenCodeRoot = process.env.QWEN_CODE_ROOT
  ?? resolve(repoRoot, '..', 'qwen-code');

const fakeHome = resolve(repoRoot, '.spike-home');
const workspace = resolve(repoRoot, '.spike-workspace');
mkdirSync(workspace, { recursive: true });

console.error(`[spike] qwen-code: ${qwenCodeRoot}`);
console.error(`[spike] HOME     : ${fakeHome}`);
console.error(`[spike] cwd      : ${workspace}`);

const args = [
  'packages/cli',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--auth-type', 'openai',
];

const child = spawn('node', args, {
  cwd: qwenCodeRoot,
  env: {
    ...process.env,
    HOME: fakeHome,
    DEV: 'true',
    CLI_VERSION: 'spike',
    QWEN_WORKING_DIR: workspace,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-dummy-spike',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1/v1',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

let gotSystemInit = false;
let gotResult = false;
let slashCommands = null;

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'system' && Array.isArray(ev.slash_commands)) {
      gotSystemInit = true;
      slashCommands = ev.slash_commands;
      console.error(`[spike] system.slash_commands = ${JSON.stringify(ev.slash_commands)}`);
    } else if (ev.type === 'assistant') {
      const text = ev.message?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) console.log(`[assistant] ${text}`);
    } else if (ev.type === 'result') {
      gotResult = true;
      console.error(`[spike] result subtype=${ev.subtype} duration=${ev.duration_ms}ms`);
      if (ev.error) console.error(`[spike] result.error = ${JSON.stringify(ev.error)}`);
      if (ev.result) console.log(`[result] ${ev.result}`);
    } else if (ev.type === 'system') {
      console.error(`[spike] system subtype=${ev.subtype ?? '(none)'} keys=${Object.keys(ev).join(',')}`);
    } else {
      console.error(`[spike] event type=${ev.type}${ev.subtype ? `/${ev.subtype}` : ''}`);
    }
  } catch (err) {
    console.error(`[spike] parse err: ${err.message} line=${line.slice(0, 120)}`);
  }
});

const sessionId = 'spike-session';

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

setTimeout(() => {
  send({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: 'Say the single word READY and nothing else.',
    },
    parent_tool_use_id: null,
  });
  setTimeout(() => child.stdin.end(), 50);
}, 300);

child.on('close', (code) => {
  console.error(`\n[spike] child exited: ${code}`);
  console.error(`[spike] gotSystemInit=${gotSystemInit} gotResult=${gotResult}`);
  if (slashCommands) {
    const disabled = ['init', 'clear'];
    const leaked = disabled.filter((d) => slashCommands.includes(d));
    if (leaked.length === 0) {
      console.error(`[spike] ✓ denylist honored — none of ${JSON.stringify(disabled)} appeared`);
    } else {
      console.error(`[spike] ✗ denylist LEAK — found ${JSON.stringify(leaked)} in slash_commands`);
      process.exitCode = 2;
    }
  }
  process.exit(process.exitCode ?? code ?? 0);
});
