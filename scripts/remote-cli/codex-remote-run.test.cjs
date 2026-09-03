'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { test, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wrapper-test-'));
const wrapper = path.join(__dirname, 'codex-remote-run.sh');
const mock = path.join(root, 'codex');
fs.writeFileSync(mock, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.ARGV_FILE,JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
if(process.env.MOCK_ERROR) console.error(process.env.MOCK_ERROR);
setTimeout(()=>process.exit(Number(process.env.MOCK_EXIT||0)),Number(process.env.MOCK_DELAY||0));
`);
fs.chmodSync(mock, 0o755);
const authSync = path.join(root, 'codex-sync-auth-from-gateway');
fs.writeFileSync(authSync, '#!/bin/sh\nprintf "sync\\n" >> "$AUTH_SYNC_FILE"\nexit 0\n');
fs.chmodSync(authSync, 0o755);
const argvFile = path.join(root, 'argv.json');
const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, ARGV_FILE: argvFile };
const run = (args, extra = {}) => spawnSync('bash', [wrapper, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('forwards high effort, model and exact code prompt as individual arguments', () => {
  const prompt = 'Create only .kimibuilt/test.js\n  const message = "hello";';
  const result = run(['run', '--format', 'json', '--model', 'gpt-5.6-luna', '--reasoning-effort', 'high', '--', prompt]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high\n/);
  const argv = JSON.parse(fs.readFileSync(argvFile));
  assert.deepEqual(argv, ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=high', '--', prompt]);
});
test('resume preserves the specified session and effort', () => {
  const result = run(['run', '--session', 'thread-123', '--reasoning-effort', 'high', 'continue']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile)).slice(-4), ['resume', 'thread-123', '--', 'continue']);
});
test('omission preserves Codex defaults and emits no false receipt', () => {
  const result = run(['run', 'hello']);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /REASONING_EFFORT_APPLIED/);
  assert.ok(!JSON.parse(fs.readFileSync(argvFile)).includes('-c'));
});
test('a failing Codex exit remains a failure', () => {
  const result = run(['run', 'hello'], { MOCK_EXIT: '17', MOCK_ERROR: 'fixture failure' });
  assert.equal(result.status, 17);
  assert.match(result.stderr, /fixture failure/);
});
test('invalid effort and missing values are rejected before launching', () => {
  assert.equal(run(['run', '--reasoning-effort', 'high; touch /tmp/no']).status, 2);
  assert.equal(run(['run', '--reasoning-effort']).status, 2);
  assert.equal(run(['run', '--sandbox', 'invalid']).status, 2);
});
test('bounded authentication retry preserves a second failure exit', () => {
  const countFile = path.join(root, 'auth-sync.txt');
  const result = run(['run', 'hello'], { MOCK_EXIT: '23', MOCK_ERROR: 'refresh_token_invalidated', AUTH_SYNC_FILE: countFile });
  assert.equal(result.status, 23);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'sync\n');
});
test('progress reaches the caller before the CLI completes', async () => {
  const child = spawn('bash', [wrapper, 'run', 'hello'], { env: { ...env, MOCK_DELAY: '800' } });
  let receivedWhileRunning = false;
  child.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('thread.started') && child.exitCode === null) receivedWhileRunning = true;
  });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  assert.ok(receivedWhileRunning);
});
