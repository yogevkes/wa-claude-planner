import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Copy config.js + example into a scratch project so instance folders don't land in the repo */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-inst-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(repo, 'src', 'config.js'), path.join(dir, 'src', 'config.js'));
  fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(dir, 'config.example.json'));
  return dir;
}

function run(dir, code, args = []) {
  const env = { ...process.env };
  delete env.WA_CLAUDE_DATA;
  delete env.WA_CLAUDE_CONFIG;
  delete env.WA_CLAUDE_INSTANCE;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code, '--', ...args], { cwd: dir, env, encoding: 'utf8' });
}

const PRINT = `const m = await import('./src/config.js'); const c = m.loadConfig();
console.log(JSON.stringify({ inst: m.INSTANCE, def: m.IS_DEFAULT, config: m.paths.config, token: m.paths.googleToken, c }));`;

test('default instance keeps the original layout', () => {
  const dir = scratch();
  const out = JSON.parse(run(dir, PRINT).trim().split('\n').pop());
  assert.equal(out.inst, 'default');
  assert.equal(out.config, path.join(dir, 'config.json'));
  assert.equal(out.token, path.join(dir, 'data', 'google-token.json'));
  assert.equal(out.c.claudeConfigDir, '');
});

test('named instance gets its own folder, empty watch list, own Claude dir and the shared OAuth client', () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'google-credentials.json'), '{"installed":{}}');
  const out = JSON.parse(run(dir, PRINT, ['--instance', 'roni']).trim().split('\n').pop());
  assert.equal(out.inst, 'roni');
  assert.equal(out.config, path.join(dir, 'instances', 'roni', 'config.json'));
  assert.equal(out.token, path.join(dir, 'instances', 'roni', 'data', 'google-token.json'));
  assert.deepEqual(out.c.watchChats, []);
  assert.equal(out.c.claudeConfigDir, path.join(os.homedir(), '.claude-roni'));
  assert.ok(fs.existsSync(path.join(dir, 'instances', 'roni', 'data', 'google-credentials.json')));
});

test('config saved by Notepad with a BOM still loads', () => {
  const dir = scratch();
  run(dir, PRINT, ['--instance', 'dana']);
  const p = path.join(dir, 'instances', 'dana', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.groupName = 'הקבוצה של דנה';
  fs.writeFileSync(p, '﻿' + JSON.stringify(cfg), 'utf8');
  const out = JSON.parse(run(dir, PRINT, ['--instance', 'dana']).trim().split('\n').pop());
  assert.equal(out.c.groupName, 'הקבוצה של דנה');
});

test('invalid instance names are rejected', () => {
  const dir = scratch();
  assert.throws(() => run(dir, PRINT, ['--instance', '../evil']));
});

test('claudeConfigDir is passed to Claude Code as CLAUDE_CONFIG_DIR', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cl-'));
  process.env.WA_CLAUDE_DATA = tmp;
  const { runClaudeCli } = await import('../src/claude.js');
  const fake = path.join(tmp, 'fake-claude.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({is_error:false,result:process.env.CLAUDE_CONFIG_DIR||'none'})));`);
  fs.chmodSync(fake, 0o755);
  assert.equal(await runClaudeCli('x', { claudePath: fake, claudeConfigDir: '/home/x/.claude-roni' }), '/home/x/.claude-roni');
  assert.equal(await runClaudeCli('x', { claudePath: fake, claudeConfigDir: '' }), process.env.CLAUDE_CONFIG_DIR || 'none');
});
