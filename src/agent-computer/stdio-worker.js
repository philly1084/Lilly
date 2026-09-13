'use strict';

const assert = require('node:assert/strict');
const { AgentComputerRuntime, normalizeIdentity } = require('./runtime');
const { serveComputer } = require('./remote-runtime');

function startWorker({ input = process.stdin, output = process.stdout, identity, chromium, profileLeaseId = null } = {}) {
  const bound = normalizeIdentity(identity);
  return serveComputer({ input, output, createRuntime: ({ authorize }) => new AgentComputerRuntime({
    rootDir: '/profiles', chromium, executablePath: chromium.executablePath(), maxComputers: 1, profileLeaseId,
    // Deployment-level socket support remains off until its egress policy is
    // verified. Page JavaScript cannot bypass request authorization via sockets.
    allowWebSockets: false,
    authorize: request => {
      const actual = normalizeIdentity(request.identity);
      if (Object.keys(bound).some(key => bound[key] !== actual[key])) return false;
      return authorize(request);
    },
  }) });
}

// Stop admitting input immediately, but keep the process alive until its owned
// browser cleanup settles. Setting exitCode alone leaves an open stdin pipe
// keeping a successfully stopped worker alive. A hung cleanup still belongs to
// the external supervisor; never turn elapsed time into a successful close.
function bindShutdown({ endpoint, input = process.stdin, output = process.stdout, host = process } = {}) {
  let stopping;
  const close = () => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(() => endpoint.close()).then(results => {
      host.exitCode = Array.isArray(results) && results.every(result => result.status === 'fulfilled') ? 0 : 1;
    }, () => { host.exitCode = 1; }).finally(() => {
      input.destroy();
      host.removeListener('SIGTERM', close);
    });
    return stopping;
  };
  input.once('end', close);
  input.once('close', close);
  input.once('error', close);
  output.once('error', close);
  host.on('SIGTERM', close);
  return close;
}

if (require.main === module) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--serve']);
    assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10001);
    // Only scoped identity belongs in this process. Provider and Kubernetes
    // credentials must never be supplied to the browser image or environment.
    assert(!Object.keys(process.env).some(key => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY|KUBECONFIG)$/.test(key)));
    const { chromium } = require('/opt/lilly-browser/node_modules/playwright-core');
    assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(process.env.LILLY_PROFILE_LEASE_ID || ''));
    const endpoint = startWorker({ identity: JSON.parse(process.env.LILLY_COMPUTER_IDENTITY || 'null'), chromium,
      profileLeaseId: process.env.LILLY_PROFILE_LEASE_ID });
    bindShutdown({ endpoint });
  } catch { process.stderr.write('Private computer worker configuration rejected.\n'); process.exitCode = 1; }
}

module.exports = { startWorker, bindShutdown };
