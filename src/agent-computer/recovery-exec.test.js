'use strict';

jest.mock('./recovery-helper', () => ({ normalizeRecoveryHelperIdentity: jest.fn((_lease, helper) => helper) }));
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRecoveryExec } = require('./recovery-exec');

function fixture(reply = (child, request) => {
  child.stdout.write(JSON.stringify({ version: 1, helperId: request.lease.recoveryHelper.helperId, filesystem: { retired: true } }));
  child.emit('exit', 0, null);
}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = jest.fn();
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    expect(chunk.toString().endsWith('\n')).toBe(true); callback(); queueMicrotask(() => reply(child, JSON.parse(chunk.toString())));
  } });
  const cluster = { exec: jest.fn(() => child) };
  const request = { version: 1, lease: { recoveryHelper: { namespace: 'lilly-team-workers', podName: 'profile-recovery-fixture', helperId: 'fixture-id' } } };
  return { child, cluster, request };
}

test('uses fixed flock command, newline request and authoritative exit without closing stdin', async () => {
  const f = fixture(); const execute = createRecoveryExec({ cluster: f.cluster });
  expect(await execute({ mode: 'inspect', request: f.request })).toEqual({ version: 1, helperId: 'fixture-id', filesystem: { retired: true } });
  expect(f.child.stdin.writableEnded).toBe(false);
  expect(f.cluster.exec.mock.calls[0][0].command).toEqual(['/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork', '/profiles',
    '/usr/local/bin/node', '/opt/lilly-recovery/src/agent-computer/recovery-worker.js', '--inspect']);
  expect(f.child.kill).not.toHaveBeenCalled();
});

test.each(['disconnect', 'nonzero', 'oversized', 'malformed', 'foreign', 'extra', 'timeout', 'abort'])('%s is an unknown command outcome, not recovery success', async mode => {
  const f = fixture(child => {
    if (mode === 'disconnect') child.emit('exit', null, 'transport_closed');
    if (mode === 'nonzero') child.emit('exit', 73, null);
    if (mode === 'oversized') child.stdout.write('x'.repeat(16385));
    if (mode === 'malformed') { child.stdout.write('PRIVATE'); child.emit('exit', 0, null); }
    if (mode === 'foreign' || mode === 'extra') {
      child.stdout.write(JSON.stringify({ version: 1, helperId: mode === 'foreign' ? 'other' : 'fixture-id', filesystem: {}, ...(mode === 'extra' ? { secret: 'PRIVATE' } : {}) }));
      child.emit('exit', 0, null);
    }
  });
  const controller = new AbortController(); const execute = createRecoveryExec({ cluster: f.cluster, timeoutMs: 25 });
  const pending = execute({ mode: 'recover', request: f.request, signal: controller.signal });
  if (mode === 'abort') controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'computer_recovery_exec_unknown', message: 'Private recovery command outcome is unconfirmed.' });
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});
