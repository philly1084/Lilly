'use strict';

const { normalizeRecoveryHelperIdentity } = require('./recovery-helper');
const fail = () => Object.assign(new Error('Private recovery command outcome is unconfirmed.'), { code: 'computer_recovery_exec_unknown' });
const ENTRY = '/opt/lilly-recovery/src/agent-computer/recovery-worker.js';

function createRecoveryExec({ cluster, timeoutMs = 30000 } = {}) {
  if (typeof cluster?.exec !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail();
  return async ({ mode, request, signal }) => {
    let helper; let body;
    try {
      if (!['recover', 'inspect'].includes(mode) || signal?.aborted) throw fail();
      helper = normalizeRecoveryHelperIdentity(request.lease, request.lease.recoveryHelper);
      body = Buffer.from(`${JSON.stringify(request)}\n`);
      if (body.length > 65536) throw fail();
    } catch { throw fail(); }
    return new Promise((resolve, reject) => {
      let child; let timer; let finished = false; let bytes = 0; const chunks = [];
      const done = value => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        if (value === undefined) { child?.kill(); reject(fail()); } else resolve(value);
      };
      const aborted = () => done();
      try {
        child = cluster.exec({ namespace: helper.namespace, podName: helper.podName, container: 'worker', signal, maxBytes: 65536,
          command: ['/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork', '/profiles',
            '/usr/local/bin/node', ENTRY, `--${mode}`] });
        child.on('error', () => done()); child.stdin.on('error', () => done());
        child.stdout.on('error', () => done()); child.stderr.on('error', () => done());
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) done(); else chunks.push(Buffer.from(chunk)); });
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) done(); });
        child.once('exit', (code, reason) => {
          if (code !== 0 || reason) return done();
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (result?.version !== 1 || result.helperId !== helper.helperId || !result.filesystem
              || Object.keys(result).length !== 3) return done();
            done(result);
          } catch { done(); }
        });
        timer = setTimeout(() => done(), timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) return done();
        // Do not end stdin: Kubernetes v4 would close the result channel too.
        child.stdin.write(body, error => { if (error) done(); });
      } catch { done(); }
    });
  };
}

module.exports = { createRecoveryExec };
